'use strict';
// Skin du compte Minecraft : lecture, envoi d'un nouveau skin, retour au skin par défaut (API officielle de Mojang).
// Le jeton Minecraft ne quitte jamais le processus principal ; la page ne reçoit que des images en data: URL.
// Sans Electron : testé avec un faux transport.

const SKINS_URL = 'https://api.minecraftservices.com/minecraft/profile/skins';
const ACTIVE_SKIN_URL = `${SKINS_URL}/active`;
const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Mojang refuse les fichiers plus gros ; un vrai skin fait quelques Ko. */
const MAX_BYTES = 24 * 1024;
const VARIANTS = new Set(['classic', 'slim']);

class SkinError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Vérifie qu'un fichier est un skin Minecraft : PNG de 64 x 64 (ou 64 x 32, ancien format). Renvoie { width, height }. */
function checkSkinPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new SkinError('NOT_PNG', "Ce fichier n'est pas une image PNG.");
  }
  if (buffer.length > MAX_BYTES) throw new SkinError('TOO_BIG', 'Image trop lourde pour un skin (24 Ko au plus).');
  // premier bloc IHDR : largeur et hauteur en octets 16-23
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new SkinError('NOT_PNG', 'Image PNG illisible.');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new SkinError('BAD_SIZE', `Un skin fait 64 x 64 pixels (ou 64 x 32) ; cette image fait ${width} x ${height}.`);
  }
  return { width, height };
}

/** Skin actif d'un profil Minecraft (réponse de /minecraft/profile ou des routes de skin) : { url, variant } ou null. */
function activeSkin(profile) {
  const skins = Array.isArray(profile?.skins) ? profile.skins : [];
  const skin = skins.find((s) => s.state === 'ACTIVE') || skins[0];
  if (!skin?.url) return null;
  return { url: String(skin.url).replace(/^http:/, 'https:'), variant: String(skin.variant || 'CLASSIC').toLowerCase() === 'slim' ? 'slim' : 'classic' };
}

function failure(response, action) {
  const status = response.status;
  if (status === 401) return new SkinError('SESSION_EXPIRED', 'Session Minecraft expirée : reconnecte le compte.');
  if (status === 429) return new SkinError('RATE_LIMITED', 'Trop de changements de skin : réessaie dans une minute.');
  if (status === 400) {
    const detail = response.data?.errorMessage || response.data?.error || '';
    return new SkinError('REFUSED', `Skin refusé par Mojang${detail ? ` : ${detail}` : ''}.`);
  }
  return new SkinError('MOJANG', `Impossible de ${action} le skin (HTTP ${status}).`);
}

/** Skin actuel du compte, lu chez Mojang. */
async function readSkin(transport, accessToken) {
  const response = await transport('GET', PROFILE_URL, { bearer: accessToken });
  if (response.status !== 200) throw failure(response, 'lire');
  return activeSkin(response.data);
}

/** Envoie un nouveau skin (PNG vérifié) ; variant : 'classic' (bras larges) ou 'slim' (bras fins). */
async function uploadSkin(transport, accessToken, png, variant) {
  checkSkinPng(png);
  if (!VARIANTS.has(variant)) throw new SkinError('BAD_VARIANT', 'Modèle inconnu (classique ou fin).');
  const response = await transport('POST', SKINS_URL, {
    bearer: accessToken,
    multipart: { fields: { variant }, file: { name: 'file', filename: 'skin.png', contentType: 'image/png', data: png } },
  });
  if (response.status !== 200) throw failure(response, 'changer');
  return activeSkin(response.data);
}

/** Revient au skin par défaut de Mojang (Steve ou Alex selon le compte). */
async function resetSkin(transport, accessToken) {
  const response = await transport('DELETE', ACTIVE_SKIN_URL, { bearer: accessToken });
  if (response.status !== 200) throw failure(response, 'réinitialiser');
  return activeSkin(response.data);
}

/** Corps multipart/form-data (champs texte puis un fichier) : { body: Buffer, contentType }. */
function multipartBody({ fields = {}, file }, boundary = `----attack${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`, 'utf8'));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

module.exports = { SkinError, checkSkinPng, activeSkin, readSkin, uploadSkin, resetSkin, multipartBody, MAX_BYTES };
