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
  'continuity-1.jar': Buffer.from('continuity '.repeat(40)),
  'replay-1.jar': Buffer.from('replay '.repeat(40)),
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

/** localPack() + un mod de chacun des groupes pvp, optifine et replay (dans cet ordre). */
function groupPack() {
  const pack = pvpPack();
  for (const [slug, filename, group] of [['continuity', 'continuity-1.jar', 'optifine'], ['replaymod', 'replay-1.jar', 'replay']]) {
    pack.mods.push({ slug, name: slug, version: '1', filename, url: `${base}/${filename}`, sha512: sha512(FILES[filename]), size: FILES[filename].length, group });
  }
  return pack;
}

const list = (dir) => fs.readdirSync(path.join(dir, 'mods')).sort();

test('packs figés du dépôt : valides, cdn.modrinth.com, SHA-512, un par profil (Fabric et Forge 1.8.9)', () => {
  for (const profile of catalog.list()) {
    const pack = modpack.loadPack(profile);
    assert.equal(pack.profileId, profile.id);
    assert.equal(pack.mc, profile.mc);
    assert.equal(pack.loader, profile.loader.type);
    for (const m of pack.mods) {
      assert.equal(new URL(m.url).hostname, 'cdn.modrinth.com');
      assert.match(m.sha512, /^[0-9a-f]{128}$/);
      assert.match(m.filename, /^[\w.+-]+\.jar$/);
      assert.match(m.license, /^[A-Za-z0-9][A-Za-z0-9.+-]*$/, `${profile.id} ${m.slug} : licence Modrinth`);
    }
    if (!catalog.isFabric(profile)) continue;
    const slugs = pack.mods.map((m) => m.slug);
    for (const needed of ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'modmenu', 'iris']) {
      assert.ok(slugs.includes(needed), `${profile.id} : ${needed}`);
    }
    assert.deepEqual(pack.mods.filter((m) => m.optional).map((m) => m.slug), ['iris'], 'seul Iris est optionnel');
  }
});

test('pack Forge 1.8.9 : Phosphor Legacy 5, Client Side Sounds 1.1 et Replay Mod 2.6.24 (groupe replay)', () => {
  const pack = modpack.loadPack(catalog.get('forge-1.8.9'));
  assert.equal(pack.loader, 'forge');
  assert.deepEqual(pack.mods.map((m) => [m.slug, m.version, m.group || null, m.optional || false]), [
    ['phosphorlegacyforge', '5', null, false],
    ['client-side-sounds', '1.1', null, false],
    ['replaymod', '2.6.24', 'replay', false],
  ]);
  assert.deepEqual(modpack.selectedMods(pack).map((m) => m.slug), ['phosphorlegacyforge', 'client-side-sounds'], 'Replay Mod coupé par défaut');
  assert.deepEqual(modpack.selectedMods(pack, { replay: true }).map((m) => m.slug), ['phosphorlegacyforge', 'client-side-sounds', 'replaymod']);
});

test('packs figés : licence de Modrinth et auteur du projet pour l’écran À propos', () => {
  const pack = modpack.loadPack(catalog.get('fabric-26.3'));
  const by = (slug) => pack.mods.find((m) => m.slug === slug);
  assert.equal(by('sodium').license, 'LicenseRef-Polyform-Shield-1.0.0');
  assert.equal(by('entityculling').license, 'LicenseRef-tr7zw-Protective-License');
  assert.equal(by('reflex-antilag').license, 'LicenseRef-All-Rights-Reserved');
  assert.equal(by('fabric-api').license, 'Apache-2.0');
  assert.equal(by('replaymod').author, 'Johni0702');
  assert.ok(pack.mods.every((m) => m.license && m.author), 'chaque mod a sa licence et son auteur');
  const view = modpack.view(pack).find((m) => m.slug === 'lithium');
  assert.deepEqual([view.license, view.author], ['LGPL-3.0-only', 'jellysquid3']);
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

test('packs figés : mods de performance communs, ModernFix en 1.21.1 seulement, groupes PvP, OptiFine et Replay désactivables', () => {
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
    const group = (name) => pack.mods.filter((m) => m.group === name).map((m) => [m.slug, m.version]);
    const is263 = id === 'fabric-26.3';
    assert.deepEqual(group('pvp'), [
      ['marlow-crystal-optimizer', '2.0.0'], ['anchor-optimizer', '1.3.0'], ['walksylib', '2.0.4'],
      ['betterhitreg', is263 ? '1.0.8-BETA' : '1.0.7'], ['complete-shield-fixes', '2.1.0'],
    ], id);
    assert.deepEqual(group('optifine'), [['continuity', is263 ? '3.0.1' : '3.0.0'], ['entitytexturefeatures', '7.2.6'], ['entity-model-features', '3.3.12']], id);
    assert.deepEqual(group('replay'), [['replaymod', '2.6.28']], id);
    assert.ok(pack.mods.every((m) => m.group === undefined || modpack.GROUPS.includes(m.group)));
    for (const m of pack.mods) assert.ok(m.name.length <= 64);
  }
});

test('packs figés : nombre de mods installés selon les réglages (shaders, mods PvP, packs OptiFine, Replay Mod)', () => {
  const count = (id, options) => modpack.selectedMods(modpack.loadPack(catalog.get(id)), options).length;
  const cases = [{}, { shaders: true }, { pvp: false }, { optifine: false }, { replay: true }, { shaders: true, replay: true }, { pvp: false, optifine: false }];
  // 1.21.1 : 25 mods dont Iris (optionnel), 5 mods PvP, 3 packs OptiFine et Replay Mod ; 26.3 : 24 (pas de ModernFix)
  assert.deepEqual(cases.map((o) => count('fabric-1.21.1', o)), [23, 24, 18, 20, 24, 25, 15]);
  assert.deepEqual(cases.map((o) => count('fabric-26.3', o)), [22, 23, 17, 19, 23, 24, 14]);
  assert.deepEqual([{}, { replay: true }, { pvp: false, optifine: false }].map((o) => count('forge-1.8.9', o)), [2, 3, 2], 'pas de groupe pvp ni optifine en 1.8.9');
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

test('validation : groupes « pvp », « optifine » et « replay » conservés, toute autre valeur refusée', () => {
  for (const group of ['pvp', 'optifine', 'replay']) assert.equal(checked((p) => { p.mods[0].group = group; })().mods[0].group, group);
  assert.equal('group' in checked((p) => { delete p.mods[0].group; })().mods[0], false, 'sans groupe : le champ reste absent');
  for (const bad of ['combat', 'PVP', 'Replay', '', null, 1, true]) {
    assert.throws(checked((p) => { p.mods[0].group = bad; }), /groupe invalide/, String(bad));
  }
});

test('validation : licence (identifiant Modrinth) et auteur conservés, valeurs douteuses refusées', () => {
  const mod = checked((p) => { p.mods[0].license = 'LGPL-3.0-only'; p.mods[0].author = 'jellysquid3'; })().mods[0];
  assert.deepEqual([mod.license, mod.author], ['LGPL-3.0-only', 'jellysquid3']);
  assert.equal(checked((p) => { p.mods[0].license = 'LicenseRef-All-Rights-Reserved'; })().mods[0].license, 'LicenseRef-All-Rights-Reserved');
  assert.equal('license' in checked((p) => { delete p.mods[0].license; })().mods[0], false);
  for (const bad of ['', 'MIT <script>', 'a b', 'x'.repeat(65), 5, null, '-MIT']) {
    assert.throws(checked((p) => { p.mods[0].license = bad; }), /licence invalide/, String(bad));
  }
  for (const bad of ['', 'x'.repeat(65), 5, null]) {
    assert.throws(checked((p) => { p.mods[0].author = bad; }), /auteur invalide/, String(bad));
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

test('mods retenus : pvp et optifine activés par défaut, replay coupé ; chaque groupe se règle seul', () => {
  const pack = groupPack();
  const slugs = (options) => modpack.selectedMods(pack, options).map((m) => m.slug);
  assert.deepEqual(slugs(), ['sodium', 'lithium', 'crystal', 'continuity'], 'sans option : Replay Mod absent');
  assert.deepEqual(slugs({ replay: true }), ['sodium', 'lithium', 'crystal', 'continuity', 'replaymod']);
  assert.deepEqual(slugs({ optifine: false }), ['sodium', 'lithium', 'crystal']);
  assert.deepEqual(slugs({ pvp: false, optifine: false, replay: false }), ['sodium', 'lithium']);
  assert.deepEqual(slugs({ pvp: false, replay: true }), ['sodium', 'lithium', 'continuity', 'replaymod']);
  assert.deepEqual(slugs({ pvp: undefined, optifine: 'non', replay: 1 }), ['sodium', 'lithium', 'crystal', 'continuity'], 'valeur non booléenne : défaut du groupe');
  assert.deepEqual(modpack.GROUP_DEFAULTS, { pvp: true, optifine: true, replay: false });
  assert.equal(modpack.groupEnabled('replay', {}), false);
  assert.equal(modpack.groupEnabled('optifine', {}), true);
});

test('groupes : jars retirés quand on coupe un groupe, remis quand on le réactive ; jars du joueur jamais touchés', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mods', 'mon-mod-perso.jar'), 'à moi');
  const first = await modpack.installPack(dir, groupPack(), { net });
  assert.deepEqual(list(dir), ['continuity-1.jar', 'crystal-1.jar', 'lithium-1.jar', 'mon-mod-perso.jar', 'sodium-1.jar']);
  const replay = await modpack.installPack(dir, groupPack(), { net, replay: true, previousManaged: first.managed });
  assert.deepEqual(list(dir), ['continuity-1.jar', 'crystal-1.jar', 'lithium-1.jar', 'mon-mod-perso.jar', 'replay-1.jar', 'sodium-1.jar']);
  const noOptifine = await modpack.installPack(dir, groupPack(), { net, replay: true, optifine: false, previousManaged: replay.managed });
  assert.deepEqual(noOptifine.removed, ['continuity-1.jar']);
  const none = await modpack.installPack(dir, groupPack(), { net, replay: false, optifine: false, pvp: false, previousManaged: noOptifine.managed });
  assert.deepEqual(none.removed.sort(), ['crystal-1.jar', 'replay-1.jar']);
  assert.deepEqual(list(dir), ['lithium-1.jar', 'mon-mod-perso.jar', 'sodium-1.jar']);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'mon-mod-perso.jar'), 'utf8'), 'à moi');
  fs.rmSync(dir, { recursive: true, force: true });
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
