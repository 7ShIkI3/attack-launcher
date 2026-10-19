'use strict';
// Comptes : refresh token chiffré sur disque, jamais exposé par list(), rafraîchissement automatique.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const { AccountStore, offlineUuid } = require('../src/main/accounts');
const settings = require('../src/main/settings');

// faux chiffrement réversible (en production : safeStorage / DPAPI)
const cipher = {
  encrypt: (text) => Buffer.from(`ENC:${[...text].reverse().join('')}`),
  decrypt: (buffer) => [...buffer.toString().slice(4)].reverse().join(''),
};

const UUID = '0123456789abcdef0123456789abcdef';
const login = (refresh = 'REFRESH-SECRET', expiresAt = Date.now() + 86400000) => ({
  profile: { id: UUID, name: 'Raphou', skinUrl: null },
  minecraft: { accessToken: 'MC-SECRET', expiresAt },
  microsoft: { accessToken: 'MS', refreshToken: refresh, expiresAt: 0 },
});

test('compte Microsoft : refresh token chiffré sur disque, absent de la vue publique', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  const store = new AccountStore(file, cipher);
  await store.saveMicrosoft(login(), { skin: 'data:image/png;base64,AAAA' });
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('REFRESH-SECRET'), 'refresh token en clair sur disque');
  assert.ok(!onDisk.includes('MC-SECRET'), 'jeton Minecraft sur disque');
  const view = JSON.stringify(store.list());
  assert.ok(!/SECRET|refreshToken|ENC:/.test(view), 'jeton visible par l’interface');
  assert.deepEqual(store.list(), [{ id: UUID, name: 'Raphou', type: 'msa', skin: 'data:image/png;base64,AAAA', skinVariant: 'classic', active: true }]);

  const reloaded = await new AccountStore(file, cipher).load();
  assert.equal(reloaded.active().name, 'Raphou');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('identité de lancement : jeton en mémoire, puis rafraîchi automatiquement à l’expiration', async () => {
  const dir = tempDir();
  const store = new AccountStore(path.join(dir, 'accounts.json'), cipher);
  await store.saveMicrosoft(login('R1'));
  let refreshed = 0;
  const refresh = async (token) => {
    refreshed++;
    assert.equal(token, refreshed === 1 ? 'R1' : 'R2');
    return { ...login(`R${refreshed + 1}`), minecraft: { accessToken: `MC-${refreshed}`, expiresAt: Date.now() + 86400000 } };
  };
  const first = await store.launchIdentity(UUID, refresh);
  assert.deepEqual(first, { name: 'Raphou', uuid: UUID, accessToken: 'MC-SECRET', userType: 'msa' });
  assert.equal(refreshed, 0, 'jeton encore valide : pas de rafraîchissement');

  // redémarrage du launcher : plus de jeton en mémoire -> rafraîchissement avec le refresh token déchiffré
  const restarted = await new AccountStore(store.file, cipher).load();
  const second = await restarted.launchIdentity(UUID, refresh);
  assert.equal(second.accessToken, 'MC-1');
  assert.equal(refreshed, 1);
  // le nouveau refresh token (R2) a remplacé l'ancien
  const third = await new AccountStore(store.file, cipher).load();
  await third.launchIdentity(UUID, refresh);
  assert.equal(refreshed, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plusieurs comptes : choix du compte actif, déconnexion', async () => {
  const dir = tempDir();
  const store = new AccountStore(path.join(dir, 'accounts.json'), cipher);
  await store.saveMicrosoft(login());
  const offlineId = await store.addOffline('AttackDev');
  assert.equal(store.active().id, offlineId);
  await store.setActive(UUID);
  assert.equal(store.active().name, 'Raphou');
  // un rafraîchissement ne change pas le compte actif
  await store.setActive(offlineId);
  await store.refresh(UUID, async () => login('R9'));
  assert.equal(store.active().id, offlineId);
  await store.remove(offlineId);
  assert.equal(store.active().id, UUID);
  await store.remove(UUID);
  assert.equal(store.active(), null);
  await assert.rejects(store.setActive('inconnu'), /inconnu/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compte hors ligne : UUID v3 « OfflinePlayer », jeton « 0 », pseudo validé', async () => {
  // valeur de référence calculée par Minecraft pour « Notch » hors ligne
  assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
  const dir = tempDir();
  const store = new AccountStore(path.join(dir, 'accounts.json'), cipher);
  const id = await store.addOffline('AttackDev');
  assert.deepEqual(await store.launchIdentity(id, async () => assert.fail('pas de réseau hors ligne')),
    { name: 'AttackDev', uuid: id, accessToken: '0', userType: 'legacy' });
  await assert.rejects(store.addOffline('a b'), /Pseudo invalide/);
  await assert.rejects(store.addOffline('ab'), /Pseudo invalide/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ID client Azure : réglage validé, sinon variable ATTACK_MS_CLIENT_ID, sinon app officielle', () => {
  const base = settings.defaults({ APPDATA: 'C:\\x' });
  const id = 'AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(settings.sanitize({ msClientId: id }, base).msClientId, id.toLowerCase());
  assert.equal(settings.sanitize({ msClientId: 'nimporte quoi' }, base).msClientId, '');
  assert.equal(settings.clientId(base, { ATTACK_MS_CLIENT_ID: id }), id.toLowerCase());
  assert.equal(settings.clientIdSource(base, { ATTACK_MS_CLIENT_ID: id }), 'env');
  // variable absente ou invalide : app officielle d'ATTACK Launcher
  assert.equal(settings.clientId(base, { ATTACK_MS_CLIENT_ID: 'faux' }), settings.DEFAULT_MS_CLIENT_ID);
  assert.equal(settings.clientId(base, {}), settings.DEFAULT_MS_CLIENT_ID);
  assert.equal(settings.clientIdSource(base, {}), 'default');
  assert.match(settings.DEFAULT_MS_CLIENT_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // le réglage passe avant tout
  assert.equal(settings.clientId({ ...base, msClientId: '11111111-2222-3333-4444-555555555555' }, { ATTACK_MS_CLIENT_ID: id }),
    '11111111-2222-3333-4444-555555555555');
  assert.equal(settings.clientIdSource({ ...base, msClientId: '11111111-2222-3333-4444-555555555555' }, {}), 'settings');
});

test('setSkin : nouveau skin et modele enregistres, visibles dans la vue publique', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { AccountStore } = require('../src/main/accounts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attack-skin-'));
  const cipher = { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() };
  const store = new AccountStore(path.join(dir, 'accounts.json'), cipher);
  await store.saveMicrosoft({
    profile: { id: 'b'.repeat(32), name: 'Bob', skinVariant: 'slim' },
    minecraft: { accessToken: 'mc', expiresAt: Date.now() + 3600000 },
    microsoft: { refreshToken: 'r' },
  }, { skin: 'data:image/png;base64,OLD' });
  assert.equal(store.list()[0].skinVariant, 'slim');
  await store.setSkin('b'.repeat(32), 'data:image/png;base64,NEW', 'classic');
  const again = await new AccountStore(path.join(dir, 'accounts.json'), cipher).load();
  assert.equal(again.list()[0].skin, 'data:image/png;base64,NEW');
  assert.equal(again.list()[0].skinVariant, 'classic');
  await assert.rejects(store.setSkin('inconnu', null, 'classic'), /Compte inconnu/);
  fs.rmSync(dir, { recursive: true, force: true });
});
