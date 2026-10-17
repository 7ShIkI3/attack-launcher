'use strict';
// Chaîne de connexion Microsoft -> Xbox -> XSTS -> Minecraft, avec un transport HTTP simulé (aucun appel réseau).
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/main/auth');
const { AUTH } = require('../src/main/constants');

const CLIENT = '11111111-2222-3333-4444-555555555555';
const UUID = '0123456789abcdef0123456789abcdef';

/** Transport simulé : routes = { url: réponse | [réponses successives] | fonction(call) }. */
function fakeTransport(overrides = {}) {
  const routes = {
    [AUTH.deviceCode]: { status: 200, data: { device_code: 'DEV', user_code: 'ABCD-1234', verification_uri: 'https://www.microsoft.com/link', expires_in: 900, interval: 5 } },
    [AUTH.token]: [
      { status: 400, data: { error: 'authorization_pending' } },
      { status: 400, data: { error: 'slow_down' } },
      { status: 200, data: { access_token: 'MS-ACCESS', refresh_token: 'MS-REFRESH', expires_in: 3600 } },
    ],
    [AUTH.xboxUser]: { status: 200, data: { Token: 'XBL', DisplayClaims: { xui: [{ uhs: 'UHS' }] } } },
    [AUTH.xsts]: { status: 200, data: { Token: 'XSTS', DisplayClaims: { xui: [{ uhs: 'UHS' }] } } },
    [AUTH.mcLogin]: { status: 200, data: { access_token: 'MC-ACCESS', expires_in: 86400 } },
    [AUTH.entitlements]: { status: 200, data: { items: [{ name: 'product_minecraft' }, { name: 'game_minecraft' }] } },
    [AUTH.profile]: { status: 200, data: { id: UUID, name: 'Raphou', skins: [{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/abc' }] } },
    ...overrides,
  };
  const calls = [];
  const transport = async (method, url, options = {}) => {
    calls.push({ method, url, ...options });
    let route = routes[url];
    if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0];
    if (typeof route === 'function') route = route(options);
    if (!route) throw new Error(`route non simulée : ${url}`);
    return route;
  };
  return { transport, calls };
}

const fast = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })() };

test('connexion complète par code d’appareil', async () => {
  const { transport, calls } = fakeTransport();
  const codes = [];
  const result = await auth.loginWithDeviceCode(transport, CLIENT, { ...fast, onCode: (c) => codes.push(c) });
  assert.deepEqual(codes, [{ userCode: 'ABCD-1234', verificationUri: 'https://www.microsoft.com/link', expiresIn: 900 }]);
  assert.deepEqual(result.profile, { id: UUID, name: 'Raphou', skinUrl: 'http://textures.minecraft.net/texture/abc' });
  assert.equal(result.minecraft.accessToken, 'MC-ACCESS');
  assert.equal(result.microsoft.refreshToken, 'MS-REFRESH');

  const device = calls.find((c) => c.url === AUTH.deviceCode);
  assert.deepEqual(device.form, { client_id: CLIENT, scope: 'XboxLive.signin offline_access' });
  assert.equal(calls.filter((c) => c.url === AUTH.token).length, 3, 'pending, slow_down, puis succès');
  const xbox = calls.find((c) => c.url === AUTH.xboxUser).json;
  assert.equal(xbox.Properties.RpsTicket, 'd=MS-ACCESS');
  assert.equal(xbox.RelyingParty, 'http://auth.xboxlive.com');
  const xsts = calls.find((c) => c.url === AUTH.xsts).json;
  assert.equal(xsts.RelyingParty, 'rp://api.minecraftservices.com/');
  assert.deepEqual(xsts.Properties.UserTokens, ['XBL']);
  assert.equal(calls.find((c) => c.url === AUTH.mcLogin).json.identityToken, 'XBL3.0 x=UHS;XSTS');
  assert.equal(calls.find((c) => c.url === AUTH.profile).bearer, 'MC-ACCESS');
});

test('ralentissement : slow_down ajoute 5 s à l’intervalle', async () => {
  const waits = [];
  const { transport } = fakeTransport();
  await auth.pollDeviceCode(transport, CLIENT, { deviceCode: 'DEV', interval: 5, expiresIn: 900 }, {
    sleep: async (ms) => waits.push(ms), now: () => 0,
  });
  assert.deepEqual(waits, [5000, 5000, 10000]);
});

async function expectCode(overrides, code, pattern) {
  const { transport } = fakeTransport(overrides);
  await assert.rejects(auth.loginWithDeviceCode(transport, CLIENT, fast), (error) => {
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    assert.ok(!/MS-|XSTS|XBL|MC-ACCESS|DEV\b/.test(error.message), 'aucun jeton dans le message');
    return true;
  });
}

test('XErr 2148916233 : pas de compte Xbox', () => expectCode(
  { [AUTH.xsts]: { status: 401, data: { XErr: 2148916233 } } }, 'NO_XBOX', /profil Xbox/));

test('XErr 2148916238 : compte enfant', () => expectCode(
  { [AUTH.xsts]: { status: 401, data: { XErr: 2148916238 } } }, 'CHILD', /compte enfant/));

test('autre XErr : erreur générique XSTS', () => expectCode(
  { [AUTH.xsts]: { status: 401, data: { XErr: 2148916999 } } }, 'XSTS_ERROR', /2148916999/));

test('403 sur login_with_xbox : app Azure non validée par Mojang', () => expectCode(
  { [AUTH.mcLogin]: { status: 403, data: { path: '/authentication/login_with_xbox', errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo' } } },
  'APP_NOT_APPROVED', /pas encore validée par Mojang/));

test('« Invalid app registration » même sans 403', () => expectCode(
  { [AUTH.mcLogin]: { status: 401, data: { error: 'Invalid app registration' } } }, 'APP_NOT_APPROVED'));

test('jeu non possédé (profil 404, aucun achat)', () => expectCode({
  [AUTH.entitlements]: { status: 200, data: { items: [] } },
  [AUTH.profile]: { status: 404, data: { error: 'NOT_FOUND' } },
}, 'NOT_OWNED', /ne possède pas/));

test('jeu acheté mais pseudo pas encore choisi', () => expectCode({
  [AUTH.profile]: { status: 404, data: { error: 'NOT_FOUND' } },
}, 'NO_PROFILE', /pseudo/));

test('Game Pass : liste d’achats vide mais profil présent = accepté', async () => {
  const { transport } = fakeTransport({ [AUTH.entitlements]: { status: 200, data: { items: [] } } });
  const result = await auth.loginWithDeviceCode(transport, CLIENT, fast);
  assert.equal(result.profile.name, 'Raphou');
});

test('code expiré (réponse du serveur ou délai dépassé)', async () => {
  await expectCode({ [AUTH.token]: { status: 400, data: { error: 'expired_token' } } }, 'CODE_EXPIRED', /expiré/);
  const { transport } = fakeTransport({ [AUTH.token]: { status: 400, data: { error: 'authorization_pending' } } });
  let t = 0;
  await assert.rejects(
    auth.pollDeviceCode(transport, CLIENT, { deviceCode: 'DEV', interval: 5, expiresIn: 20 }, { sleep: async () => { t += 5000; }, now: () => t }),
    (error) => error.code === 'CODE_EXPIRED',
  );
});

test('connexion refusée, annulée, ID client invalide ou refusé par Azure', async () => {
  await expectCode({ [AUTH.token]: { status: 400, data: { error: 'authorization_declined' } } }, 'DECLINED');
  await expectCode({ [AUTH.deviceCode]: { status: 400, data: { error: 'unauthorized_client' } } }, 'BAD_CLIENT_ID', /flux de clients publics/);
  // réponses réelles de Microsoft observées pour un ID inconnu
  await expectCode({ [AUTH.deviceCode]: { status: 400, data: { error: 'unauthorized_client', error_description: "AADSTS700016: Application with identifier 'x' was not found" } } },
    'BAD_CLIENT_ID', /n'existe pas/);
  await expectCode({ [AUTH.deviceCode]: { status: 503, data: { error: 'temporarily_unavailable' } } }, 'MS_UNAVAILABLE', /indisponible/);
  const { transport, calls } = fakeTransport();
  await assert.rejects(auth.loginWithDeviceCode(transport, 'pas-un-guid', fast), (e) => e.code === 'NO_CLIENT_ID');
  assert.equal(calls.length, 0, 'aucune requête sans ID client valide');
  await assert.rejects(
    auth.pollDeviceCode(fakeTransport().transport, CLIENT, { deviceCode: 'DEV', interval: 1, expiresIn: 60 }, { ...fast, isCancelled: () => true }),
    (e) => e.code === 'CANCELLED',
  );
});

test('rafraîchissement : refresh_token envoyé, nouveau refresh token gardé', async () => {
  const { transport, calls } = fakeTransport({
    [AUTH.token]: { status: 200, data: { access_token: 'MS-ACCESS-2', refresh_token: 'MS-REFRESH-2', expires_in: 3600 } },
  });
  const result = await auth.refreshAccount(transport, CLIENT, 'MS-REFRESH');
  const form = calls.find((c) => c.url === AUTH.token).form;
  assert.equal(form.grant_type, 'refresh_token');
  assert.equal(form.refresh_token, 'MS-REFRESH');
  assert.equal(result.microsoft.refreshToken, 'MS-REFRESH-2');
  assert.equal(result.minecraft.accessToken, 'MC-ACCESS');
  const expired = fakeTransport({ [AUTH.token]: { status: 400, data: { error: 'invalid_grant' } } });
  await assert.rejects(auth.refreshAccount(expired.transport, CLIENT, 'VIEUX'), (e) => e.code === 'SESSION_EXPIRED');
});

test('OAuth : toujours le tenant « consumers », jamais « common » ni un ID d’annuaire', () => {
  for (const url of [AUTH.deviceCode, AUTH.token]) {
    assert.match(url, /^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\//);
  }
  assert.equal(AUTH.scope, 'XboxLive.signin offline_access');
});

test('ID client : format GUID attendu', () => {
  assert.equal(auth.isClientId(CLIENT), true);
  assert.equal(auth.isClientId(` ${CLIENT.toUpperCase()} `), true);
  assert.equal(auth.isClientId('123'), false);
  assert.equal(auth.isClientId(undefined), false);
});
