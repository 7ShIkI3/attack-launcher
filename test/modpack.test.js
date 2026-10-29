'use strict';
// Packs de mods figés : validation stricte (vrais fichiers src/main/packs/*.json) et installation dans <gameDir>/mods
// contre un petit serveur local (127.0.0.1 autorisé seulement dans ce test).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { tempDir } = require('./helpers');
const catalog = require('../src/main/catalog');
const modpack = require('../src/main/modpack');

const sha512 = (buffer) => crypto.createHash('sha512').update(buffer).digest('hex');
const FILES = {
  'sodium-1.jar': Buffer.from('sodium '.repeat(40)),
  'lithium-1.jar': Buffer.from('lithium '.repeat(40)),
  'iris-1.jar': Buffer.from('iris '.repeat(40)),
  'crystal-1.jar': Buffer.from('crystal '.repeat(40)),
};
let server;
let base;
let hits = 0;
const net = { allowedHosts: new Set(['127.0.0.1']), retries: 0 };

test.before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const file = FILES[decodeURIComponent(req.url.slice(1))];
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    return res.end(file);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

/** Pack de test sur le serveur local (installPack ne valide pas l'hôte : validatePack le fait au chargement). */
function localPack() {
  const mod = (slug, filename, extra = {}) => ({
    slug, name: slug, version: '1', filename, url: `${base}/${filename}`, sha512: sha512(FILES[filename]), size: FILES[filename].length, ...extra,
  });
  return {
    profileId: 'fabric-1.21.1',
    mc: '1.21.1',
    loader: 'fabric',
    mods: [mod('sodium', 'sodium-1.jar'), mod('lithium', 'lithium-1.jar'), mod('iris', 'iris-1.jar', { optional: true })],
  };
}

/** localPack() + un mod du groupe PvP (localPack() reste sans groupe : ses tests attendent deux jars). */
function pvpPack() {
  const pack = localPack();
  pack.mods.push({
    slug: 'crystal', name: 'crystal', version: '1', filename: 'crystal-1.jar', url: `${base}/crystal-1.jar`,
    sha512: sha512(FILES['crystal-1.jar']), size: FILES['crystal-1.jar'].length, group: 'pvp',
  });
  return pack;
}

const list = (dir) => fs.readdirSync(path.join(dir, 'mods')).sort();

test('packs figés du dépôt : valides, cdn.modrinth.com, SHA-512, un par profil Fabric', () => {
  for (const profile of catalog.list().filter(catalog.isFabric)) {
    const pack = modpack.loadPack(profile);
    assert.equal(pack.profileId, profile.id);
    assert.equal(pack.mc, profile.mc);
    const slugs = pack.mods.map((m) => m.slug);
    for (const needed of ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'modmenu', 'iris']) {
      assert.ok(slugs.includes(needed), `${profile.id} : ${needed}`);
    }
    assert.deepEqual(pack.mods.filter((m) => m.optional).map((m) => m.slug), ['iris'], 'seul Iris est optionnel');
    for (const m of pack.mods) {
      assert.equal(new URL(m.url).hostname, 'cdn.modrinth.com');
      assert.match(m.sha512, /^[0-9a-f]{128}$/);
      assert.match(m.filename, /^[\w.+-]+\.jar$/);
    }
  }
  assert.equal(modpack.loadPack(catalog.get('forge-1.8.9')), null, 'Forge 1.8.9 n’a pas de pack');
});

test('versions figées demandées (1.21.1 et 26.3)', () => {
  const version = (id, slug) => modpack.loadPack(catalog.get(id)).mods.find((m) => m.slug === slug).version;
  assert.deepEqual(
    ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'modmenu', 'iris'].map((s) => version('fabric-1.21.1', s)),
    ['0.116.17', '0.8.13', '0.15.4', '7.0.3', '1.6.15', '11.0.5', '1.8.14-beta.1'],
  );
  assert.deepEqual(
    ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'modmenu', 'iris'].map((s) => version('fabric-26.3', s)),
    ['0.164.0', '0.9.2', '0.26.2', '9.0.0', '1.17.1', '21.0.0', '1.11.7'],
  );
});

test('packs figés : mods de performance communs, ModernFix en 1.21.1 seulement, groupe PvP désactivable', () => {
  const version = (id, slug) => modpack.loadPack(catalog.get(id)).mods.find((m) => m.slug === slug)?.version;
  const common = ['entityculling', 'moreculling', 'cloth-config', 'badoptimizations', 'krypton', 'fast-ip-ping', 'serverpingerfixer', 'reflex-antilag'];
  assert.deepEqual(
    common.map((s) => version('fabric-1.21.1', s)),
    ['1.11.3', '1.0.10', '15.0.140', '2.4.1', '0.2.8', '1.0.12', '1.0.6', '1.1.3'],
  );
  assert.deepEqual(
    common.map((s) => version('fabric-26.3', s)),
    ['1.11.3', '1.9.0', '26.3.159', '2.4.1', '0.3.2', '1.0.12', '1.1.1', '1.1.3'],
  );
  assert.equal(version('fabric-1.21.1', 'modernfix'), '5.25.1');
  assert.equal(version('fabric-26.3', 'modernfix'), undefined, 'pas de ModernFix pour 26.3');
  for (const id of ['fabric-1.21.1', 'fabric-26.3']) {
    const pack = modpack.loadPack(catalog.get(id));
    assert.deepEqual(pack.mods.filter((m) => m.group === 'pvp').map((m) => [m.slug, m.version]),
      [['marlow-crystal-optimizer', '2.0.0'], ['anchor-optimizer', '1.3.0'], ['walksylib', '2.0.4']], id);
    assert.ok(pack.mods.every((m) => m.group === undefined || m.group === 'pvp'));
    for (const m of pack.mods) assert.ok(m.name.length <= 64);
  }
});

test('packs figés : nombre de mods installés selon les réglages shaders et PvP', () => {
  const count = (id, options) => modpack.selectedMods(modpack.loadPack(catalog.get(id)), options).length;
  // 1.21.1 : 19 mods dont Iris (optionnel) et 3 mods PvP ; 26.3 : 18 (pas de ModernFix)
  assert.deepEqual([{}, { shaders: true }, { pvp: false }, { shaders: true, pvp: false }].map((o) => count('fabric-1.21.1', o)), [18, 19, 15, 16]);
  assert.deepEqual([{}, { shaders: true }, { pvp: false }, { shaders: true, pvp: false }].map((o) => count('fabric-26.3', o)), [17, 18, 14, 15]);
});

function checked(change) {
  const profile = catalog.get('fabric-1.21.1');
  const pack = structuredClone(modpack.loadPack(profile));
  change(pack);
  return () => modpack.validatePack(pack, profile);
}

test('validation : URL, hash, nom de fichier, doublons', () => {
  assert.throws(checked((p) => { p.mods[0].url = p.mods[0].url.replace('cdn.modrinth.com', 'evil.example'); }), /adresse refusée/);
  assert.throws(checked((p) => { p.mods[0].url = p.mods[0].url.replace('https:', 'http:'); }), /adresse refusée/);
  assert.throws(checked((p) => { p.mods[0].url = 'https://cdn.modrinth.com.evil.example/data/x/versions/y/a.jar'; }), /adresse refusée/);
  assert.throws(checked((p) => { p.mods[0].url = 'https://api.modrinth.com/v2/version/x'; }), /adresse refusée/);
  assert.throws(checked((p) => { p.mods[0].url = 'https://cdn.modrinth.com/data/P7dR8mSH/versions/Mys3P7lK/autre.jar'; }), /ne désigne pas/);
  assert.throws(checked((p) => { p.mods[0].sha512 = 'ab'.repeat(32); }), /SHA-512 invalide/);
  assert.throws(checked((p) => { p.mods[0].sha512 = undefined; }), /SHA-512 invalide/);
  assert.throws(checked((p) => { p.mods[0].sha1 = 'zz'; }), /SHA-1 invalide/);
  assert.throws(checked((p) => { p.mods[0].filename = '../evil.jar'; }), /nom de fichier refusé/);
  assert.throws(checked((p) => { p.mods[0].filename = 'sub/evil.jar'; }), /nom de fichier refusé/);
  assert.throws(checked((p) => { p.mods[0].filename = 'evil.exe'; }), /nom de fichier refusé/);
  assert.throws(checked((p) => { p.mods[0].size = 0; }), /taille invalide/);
  assert.throws(checked((p) => { p.mods[1].slug = p.mods[0].slug; }), /doublon/);
  assert.throws(checked((p) => {
    // même fichier à la casse près (Windows ne distingue pas) : doublon
    const upper = p.mods[0].filename.toUpperCase().replace('.JAR', '.jar');
    p.mods[1].filename = upper;
    p.mods[1].url = `https://cdn.modrinth.com/data/AANobbMI/versions/u1OEbNKx/${encodeURIComponent(upper)}`;
  }), /doublon/);
  assert.throws(checked((p) => { p.mods = []; }), /vide/);
  assert.throws(checked((p) => { p.profileId = 'fabric-26.3'; }), /profil inattendu/);
  assert.throws(checked((p) => { p.mc = '1.21'; }), /version de Minecraft/);
  assert.throws(checked((p) => { p.loader = 'forge'; }), /chargeur/);
  // champs inconnus ignorés : la version nettoyée n'en garde aucun
  const clean = checked((p) => { p.mods[0].extra = '<script>'; p.hack = 1; })();
  assert.equal('hack' in clean, false);
  assert.equal('extra' in clean.mods[0], false);
});

test('validation : groupe « pvp » conservé, toute autre valeur refusée', () => {
  assert.equal(checked((p) => { p.mods[0].group = 'pvp'; })().mods[0].group, 'pvp');
  assert.equal('group' in checked(() => {})().mods[0], false, 'sans groupe : le champ reste absent');
  for (const bad of ['combat', 'PVP', '', null, 1, true]) {
    assert.throws(checked((p) => { p.mods[0].group = bad; }), /groupe invalide/, String(bad));
  }
});

test('mods retenus : Iris seulement quand les shaders sont activés', () => {
  const pack = localPack();
  assert.deepEqual(modpack.selectedMods(pack).map((m) => m.slug), ['sodium', 'lithium']);
  assert.deepEqual(modpack.selectedMods(pack, { shaders: true }).map((m) => m.slug), ['sodium', 'lithium', 'iris']);
  assert.deepEqual(modpack.view(pack).map((m) => [m.slug, m.optional]), [['sodium', false], ['lithium', false], ['iris', true]]);
  assert.deepEqual(modpack.view(null), []);
});

test('mods retenus : les quatre combinaisons shaders / mods PvP (PvP activé par défaut)', () => {
  const pack = pvpPack();
  const slugs = (options) => modpack.selectedMods(pack, options).map((m) => m.slug);
  assert.deepEqual(slugs(), ['sodium', 'lithium', 'crystal'], 'sans option : PvP oui, shaders non');
  assert.deepEqual(slugs({ shaders: false, pvp: true }), ['sodium', 'lithium', 'crystal']);
  assert.deepEqual(slugs({ shaders: true, pvp: true }), ['sodium', 'lithium', 'iris', 'crystal']);
  assert.deepEqual(slugs({ shaders: false, pvp: false }), ['sodium', 'lithium']);
  assert.deepEqual(slugs({ shaders: true, pvp: false }), ['sodium', 'lithium', 'iris']);
  assert.deepEqual(modpack.view(pack).map((m) => [m.slug, m.group]), [['sodium', null], ['lithium', null], ['iris', null], ['crystal', 'pvp']]);
});

test('installation : jars du pack vérifiés, liste gérée, second passage sans téléchargement', async () => {
  const dir = tempDir();
  const progress = [];
  const first = await modpack.installPack(dir, localPack(), { net, report: (...a) => progress.push(a) });
  assert.deepEqual(list(dir), ['lithium-1.jar', 'sodium-1.jar']);
  assert.deepEqual(first.managed, ['sodium-1.jar', 'lithium-1.jar']);
  assert.equal(first.downloaded, 2);
  assert.deepEqual(first.removed, []);
  assert.deepEqual(first.mods.map((m) => m.slug), ['sodium', 'lithium']);
  assert.equal(progress[0][0], 'pack');
  assert.equal(progress.at(-1)[1], 2);
  const before = hits;
  const second = await modpack.installPack(dir, localPack(), { net, previousManaged: first.managed });
  assert.equal(second.skipped, 2);
  assert.equal(second.downloaded, 0);
  assert.equal(hits, before, 'aucun retéléchargement');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shaders : Iris installé quand on active l’option, retiré quand on la coupe ; jars du joueur jamais touchés', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mods', 'mon-mod-perso.jar'), 'à moi');
  fs.writeFileSync(path.join(dir, 'mods', 'attack-fabric.jar'), 'le mod ATTACK');

  const on = await modpack.installPack(dir, localPack(), { net, shaders: true, protectedNames: ['attack-fabric.jar'] });
  assert.deepEqual(list(dir), ['attack-fabric.jar', 'iris-1.jar', 'lithium-1.jar', 'mon-mod-perso.jar', 'sodium-1.jar']);
  assert.deepEqual(on.removed, []);

  const off = await modpack.installPack(dir, localPack(), { net, shaders: false, previousManaged: on.managed, protectedNames: ['attack-fabric.jar'] });
  assert.deepEqual(off.removed, ['iris-1.jar']);
  assert.deepEqual(list(dir), ['attack-fabric.jar', 'lithium-1.jar', 'mon-mod-perso.jar', 'sodium-1.jar']);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'mon-mod-perso.jar'), 'utf8'), 'à moi');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mods PvP : retirés quand on les coupe, remis quand on les réactive ; jars du joueur jamais touchés', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mods', 'mon-mod-perso.jar'), 'à moi');

  const on = await modpack.installPack(dir, pvpPack(), { net });
  assert.deepEqual(list(dir), ['crystal-1.jar', 'lithium-1.jar', 'mon-mod-perso.jar', 'sodium-1.jar']);
  assert.deepEqual(on.managed, ['sodium-1.jar', 'lithium-1.jar', 'crystal-1.jar']);

  const off = await modpack.installPack(dir, pvpPack(), { net, pvp: false, previousManaged: on.managed });
  assert.deepEqual(off.removed, ['crystal-1.jar']);
  assert.deepEqual(off.managed, ['sodium-1.jar', 'lithium-1.jar']);
  assert.deepEqual(list(dir), ['lithium-1.jar', 'mon-mod-perso.jar', 'sodium-1.jar']);

  const back = await modpack.installPack(dir, pvpPack(), { net, pvp: true, previousManaged: off.managed });
  assert.deepEqual(back.removed, []);
  assert.deepEqual(list(dir), ['crystal-1.jar', 'lithium-1.jar', 'mon-mod-perso.jar', 'sodium-1.jar']);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'mon-mod-perso.jar'), 'utf8'), 'à moi');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mise à jour du pack : l’ancien jar géré disparaît, les noms suspects de l’état sont ignorés', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mods', 'sodium-0.jar'), 'ancienne version');
  fs.writeFileSync(path.join(dir, 'mods', 'attack-fabric.jar'), 'le mod ATTACK');
  fs.writeFileSync(path.join(dir, 'outside.jar'), 'hors du dossier mods');
  const result = await modpack.installPack(dir, localPack(), {
    net,
    // état modifié à la main : un chemin qui sort, le jar ATTACK, un nom qui n'est pas un jar
    previousManaged: ['sodium-0.jar', '../outside.jar', 'attack-fabric.jar', 'readme.txt', 42],
    protectedNames: ['attack-fabric.jar'],
  });
  assert.deepEqual(result.removed, ['sodium-0.jar']);
  assert.ok(fs.existsSync(path.join(dir, 'outside.jar')));
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'attack-fabric.jar')));
  assert.deepEqual(list(dir), ['attack-fabric.jar', 'lithium-1.jar', 'sodium-1.jar']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('échec de téléchargement : rien n’est supprimé, aucun .part ne reste', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mods', 'ancien.jar'), 'ancien jar géré');
  const pack = localPack();
  pack.mods[1].sha512 = 'f'.repeat(128); // hash faux : le jar reçu est rejeté
  await assert.rejects(modpack.installPack(dir, pack, { net, previousManaged: ['ancien.jar'] }), /SHA512 incorrect/);
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'ancien.jar')), 'les suppressions n’ont lieu qu’après les téléchargements');
  assert.ok(!fs.readdirSync(path.join(dir, 'mods')).some((n) => n.endsWith('.part')));
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'lithium-1.jar')));
  fs.rmSync(dir, { recursive: true, force: true });
});
