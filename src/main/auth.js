'use strict';
// Connexion Microsoft par code d'appareil, puis Xbox Live -> XSTS -> Minecraft (login_with_xbox),
// vérification de possession du jeu et profil. Aucun jeton n'est journalisé ni placé dans un message d'erreur.
//
// Toutes les requêtes passent par un « transport » : (method, url, { form, json, bearer }) -> { status, data }.
// En production c'est createTransport() ; les tests en fournissent un simulé (aucun appel réseau).
const { AUTH, ALLOWED_HOSTS } = require('./constants');

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Codes XErr renvoyés par XSTS, avec un message clair. */
const XERR = {
  2148916233: ['NO_XBOX', "Ce compte Microsoft n'a pas de profil Xbox. Connecte-toi une fois sur xbox.com pour le créer, puis réessaie."],
  2148916235: ['XBOX_REGION', "Xbox Live n'est pas disponible dans le pays de ce compte."],
  2148916236: ['XBOX_ADULT', 'Ce compte doit être vérifié comme adulte sur xbox.com avant de pouvoir jouer.'],
  2148916237: ['XBOX_ADULT', 'Ce compte doit être vérifié comme adulte sur xbox.com avant de pouvoir jouer.'],
  2148916238: ['CHILD', "C'est un compte enfant : un adulte doit l'ajouter à une famille Microsoft (account.microsoft.com/family) pour autoriser le jeu."],
};

const UUID_HEX = /^[0-9a-f]{32}$/i;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isClientId(value) {
  return typeof value === 'string' && CLIENT_ID.test(value.trim());
}

/** Délai maximal d'un échange avec Microsoft, Xbox ou Minecraft (requête et lecture de la réponse). */
const REQUEST_TIMEOUT_MS = 30000;

/** Transport réel : fetch avec hôtes en liste blanche (redirections comprises) et délai maximal par requête. */
function createTransport({ allowedHosts = ALLOWED_HOSTS, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { fetchChecked } = require('./http');
  return async (method, url, { form, json, bearer, multipart } = {}) => {
    // sans délai, un serveur qui ne répond plus bloquerait la connexion (et le bouton JOUER) environ 5 minutes
    const signal = AbortSignal.timeout(timeoutMs);
    const host = new URL(url).hostname;
    const timedOut = () => new AuthError('TIMEOUT', `${host} ne répond pas : réessaie dans un instant.`);
    const headers = { Accept: 'application/json' };
    let body;
    if (multipart) {
      // envoi de fichier (skin) : voir skins.multipartBody
      const encoded = require('./skins').multipartBody(multipart);
      headers['Content-Type'] = encoded.contentType;
      body = encoded.body;
    } else if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let response;
    try {
      response = await fetchChecked(url, headers, allowedHosts, { method, body, signal });
    } catch (error) {
      if (error.message?.startsWith('Adresse refusée')) throw error;
      if (signal.aborted) throw timedOut();
      throw new AuthError('NETWORK', `Connexion impossible à ${host}. Vérifie ta connexion Internet.`);
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (signal.aborted) throw timedOut();
      throw new AuthError('NETWORK', `Connexion coupée avec ${host}. Vérifie ta connexion Internet.`);
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 200) };
    }
    return { status: response.status, data };
  };
}

function requireClientId(clientId) {
  if (!isClientId(clientId)) {
    throw new AuthError('NO_CLIENT_ID', "Aucun ID client Azure valide : renseigne-le dans Réglages (voir la page Compte).");
  }
  return clientId.trim();
}

function microsoftError(data) {
  const error = data?.error;
  if (error === 'expired_token') return new AuthError('CODE_EXPIRED', 'Le code a expiré. Relance la connexion.');
  if (error === 'authorization_declined') return new AuthError('DECLINED', 'Connexion refusée sur la page Microsoft.');
  if (error === 'invalid_grant') return new AuthError('SESSION_EXPIRED', 'Session Microsoft expirée : reconnecte ce compte.');
  if (/AADSTS700016/.test(data?.error_description || '')) {
    return new AuthError('BAD_CLIENT_ID', "Cet ID client Azure n'existe pas chez Microsoft : recopie l'« ID d'application (client) » de ton app.");
  }
  if (error === 'temporarily_unavailable') return new AuthError('MS_UNAVAILABLE', 'Microsoft est momentanément indisponible : réessaie dans un instant.');
  if (error === 'unauthorized_client' || error === 'invalid_client') {
    return new AuthError('BAD_CLIENT_ID',
      "L'app Azure refuse cette connexion : vérifie l'ID client et que « Autoriser les flux de clients publics » est sur Oui (Authentification → paramètres avancés).");
  }
  return new AuthError('MS_ERROR', `Erreur Microsoft (${error || 'inconnue'}).`);
}

/** 1. Demande d'un code d'appareil : { deviceCode, userCode, verificationUri, expiresIn, interval }. */
async function startDeviceCode(transport, clientId) {
  const { status, data } = await transport('POST', AUTH.deviceCode, {
    form: { client_id: requireClientId(clientId), scope: AUTH.scope },
  });
  if (status !== 200 || !data?.device_code) throw microsoftError(data);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: Math.max(1, data.interval || 5),
  };
}

function msTokens(data, now) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now() + (data.expires_in || 3600) * 1000,
  };
}

/** 2. Interroge Microsoft jusqu'à ce que l'utilisateur ait validé le code (ou expiration / annulation). */
async function pollDeviceCode(transport, clientId, device, options = {}) {
  const { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, isCancelled = () => false } = options;
  let interval = device.interval;
  const deadline = now() + device.expiresIn * 1000;
  while (now() < deadline) {
    await sleep(interval * 1000);
    if (isCancelled()) throw new AuthError('CANCELLED', 'Connexion annulée.');
    const { status, data } = await transport('POST', AUTH.token, {
      form: {
        client_id: requireClientId(clientId),
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.deviceCode,
      },
    });
    if (status === 200 && data?.access_token) return msTokens(data, now);
    if (data?.error === 'authorization_pending') continue;
    if (data?.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw microsoftError(data);
  }
  throw new AuthError('CODE_EXPIRED', 'Le code a expiré. Relance la connexion.');
}

/** Renouvelle les jetons Microsoft avec le refresh token (Microsoft en renvoie un nouveau à garder). */
async function refreshMicrosoft(transport, clientId, refreshToken, { now = Date.now } = {}) {
  const { status, data } = await transport('POST', AUTH.token, {
    form: { client_id: requireClientId(clientId), grant_type: 'refresh_token', refresh_token: refreshToken, scope: AUTH.scope },
  });
  if (status !== 200 || !data?.access_token) throw microsoftError(data);
  return { ...msTokens(data, now), refreshToken: data.refresh_token || refreshToken };
}

/** 3. Xbox Live puis XSTS pour les services Minecraft : { uhs, xstsToken }. */
async function xboxChain(transport, msAccessToken) {
  const user = await transport('POST', AUTH.xboxUser, {
    json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
  });
  if (user.status !== 200 || !user.data?.Token) throw new AuthError('XBOX_ERROR', `Xbox Live a refusé la connexion (HTTP ${user.status}).`);
  const xsts = await transport('POST', AUTH.xsts, {
    json: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [user.data.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    },
  });
  if (xsts.status !== 200 || !xsts.data?.Token) {
    const known = XERR[xsts.data?.XErr];
    if (known) throw new AuthError(known[0], known[1]);
    throw new AuthError('XSTS_ERROR', `Autorisation Xbox refusée (${xsts.data?.XErr || `HTTP ${xsts.status}`}).`);
  }
  const uhs = xsts.data.DisplayClaims?.xui?.[0]?.uhs || user.data.DisplayClaims?.xui?.[0]?.uhs;
  if (!uhs) throw new AuthError('XSTS_ERROR', 'Réponse Xbox incomplète (uhs absent).');
  return { uhs, xstsToken: xsts.data.Token };
}

/** 4. Jeton Minecraft. Un 403 ici signifie presque toujours : app Azure pas encore validée par Mojang. */
async function minecraftLogin(transport, { uhs, xstsToken }, { now = Date.now } = {}) {
  const { status, data } = await transport('POST', AUTH.mcLogin, { json: { identityToken: `XBL3.0 x=${uhs};${xstsToken}` } });
  const invalidApp = /invalid app registration/i.test(`${data?.errorMessage || ''} ${data?.error || ''} ${data?.raw || ''}`);
  if (status === 403 || invalidApp) {
    throw new AuthError('APP_NOT_APPROVED',
      "Ton app Azure n'est pas encore validée par Mojang : remplis le formulaire https://aka.ms/mce-reviewappid et attends leur accord (puis jusqu'à 24 h).");
  }
  if (status === 429) throw new AuthError('RATE_LIMITED', 'Trop de connexions Minecraft d’affilée : réessaie dans quelques minutes.');
  if (status !== 200 || !data?.access_token) throw new AuthError('MC_ERROR', `Les services Minecraft ont refusé la connexion (HTTP ${status}).`);
  return { accessToken: data.access_token, expiresAt: now() + (data.expires_in || 86400) * 1000 };
}

/** 5. Possession du jeu (achat ou Game Pass) et profil : { id, name, skinUrl }. */
async function minecraftProfile(transport, mcAccessToken) {
  const entitlements = await transport('GET', AUTH.entitlements, { bearer: mcAccessToken });
  const items = Array.isArray(entitlements.data?.items) ? entitlements.data.items : [];
  const owns = items.some((i) => i.name === 'game_minecraft' || i.name === 'product_minecraft');
  const profile = await transport('GET', AUTH.profile, { bearer: mcAccessToken });
  if (profile.status === 404 || (profile.status === 200 && !profile.data?.name)) {
    throw new AuthError(owns ? 'NO_PROFILE' : 'NOT_OWNED', owns
      ? "Minecraft Java est acheté mais aucun pseudo n'est choisi : crée-le sur minecraft.net, puis réessaie."
      : "Ce compte ne possède pas Minecraft Java Edition.");
  }
  if (profile.status !== 200) throw new AuthError('MC_ERROR', `Profil Minecraft indisponible (HTTP ${profile.status}).`);
  // Game Pass : la liste d'achats peut être vide alors que le profil existe ; le profil fait foi.
  const { id, name, skins = [] } = profile.data;
  if (!UUID_HEX.test(id || '')) throw new AuthError('MC_ERROR', 'Profil Minecraft invalide.');
  const skin = skins.find((s) => s.state === 'ACTIVE') || skins[0];
  const skinVariant = String(skin?.variant || 'CLASSIC').toLowerCase() === 'slim' ? 'slim' : 'classic';
  return { id: id.toLowerCase(), name, skinUrl: skin?.url || null, skinVariant };
}

/** Chaîne complète à partir de jetons Microsoft : { profile, minecraft, microsoft }. */
async function completeLogin(transport, microsoft, options = {}) {
  const xbox = await xboxChain(transport, microsoft.accessToken);
  const minecraft = await minecraftLogin(transport, xbox, options);
  const profile = await minecraftProfile(transport, minecraft.accessToken);
  return { profile, minecraft, microsoft };
}

/** Connexion d'un nouveau compte. onCode(device) affiche le code à l'utilisateur. */
async function loginWithDeviceCode(transport, clientId, { onCode, onStage, ...options } = {}) {
  const device = await startDeviceCode(transport, clientId);
  onCode?.({ userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn });
  const microsoft = await pollDeviceCode(transport, clientId, device, options);
  onStage?.('xbox');
  return completeLogin(transport, microsoft, options);
}

/** Rafraîchit un compte enregistré (nouveau jeton Minecraft + nouveau refresh token). */
async function refreshAccount(transport, clientId, refreshToken, options = {}) {
  const microsoft = await refreshMicrosoft(transport, clientId, refreshToken, options);
  return completeLogin(transport, microsoft, options);
}

module.exports = {
  AuthError,
  XERR,
  isClientId,
  createTransport,
  startDeviceCode,
  pollDeviceCode,
  refreshMicrosoft,
  xboxChain,
  minecraftLogin,
  minecraftProfile,
  completeLogin,
  loginWithDeviceCode,
  refreshAccount,
};
