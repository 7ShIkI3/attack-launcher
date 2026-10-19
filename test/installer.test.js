'use strict';
// Étapes de l'installateur testées sans réseau : le `fetch` global est remplacé par un faux serveur (Fabric, GitHub),
// et le pack de mods utilise un petit serveur local. Couvre installFabric, installMod (release Fabric), installPack
// (fichier d'état) et ses échecs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { tempDir } = require('./helpers');
const catalog = require('../src/main/catalog');
const installer = require('../src/main/installer');
const { mavenPath } = require('../src/main/maven');

const hash = (algorithm, body) => crypto.createHash(algorithm).update(body).digest('hex');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const noReport = () => {};

// ---------- faux serveur réseau (fetch global) ----------

const realFetch = global.fetch;
let routes = new Map();
let requested = [];

function fakeFetch(url, init) {
  // le serveur local du pack de mods (127.0.0.1) répond pour de vrai ; tout le reste vient des routes ci-dessous
  if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
  requested.push(String(url));
  const route = routes.get(String(url));
  if (route === undefined) return Promise.resolve(new Response('absent', { status: 404 }));
  return Promise.resolve(new Response(route, { status: 200 }));
}
test.before(() => {
  global.fetch = fakeFetch;
});
test.after(() => {
  global.fetch = realFetch;
});
test.beforeEach(() => {
  routes = new Map();
  requested = [];
});

// ---------- installFabric ----------

/**
 * Profil Fabric 26.3 dont toutes les bibliothèques sont des faux jars : le profil de version est celui de la fixture,
 * avec les hash recalculés. fabric-loader n'a pas de hash dans le profil : son SHA-1 est « figé » dans le catalogue.
 */
function fabricWorld({ pinLoader = true } = {}) {
  const base = catalog.get('fabric-26.3');
  const meta = fixture('fabric-loader-26.3.json');
  const bodies = new Map();
  for (const lib of meta.libraries) {
    const body = Buffer.from(`faux jar ${lib.name}`);
    bodies.set(lib.name, body);
    if (lib.sha512) {
      lib.sha1 = hash('sha1', body);
      lib.sha256 = hash('sha256', body);
      lib.sha512 = hash('sha512', body);
      lib.size = body.length;
      delete lib.md5;
    }
  }
  const loaderName = `net.fabricmc:fabric-loader:${base.loader.version}`;
  const profile = { ...base, loader: { ...base.loader, pinnedSha1: pinLoader ? { [loaderName]: hash('sha1', bodies.get(loaderName)) } : {} } };
  routes.set('https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/profile/json', JSON.stringify(meta));
  for (const [name, body] of bodies) routes.set(`https://maven.fabricmc.net/${mavenPath(name)}`, body);
  return { profile, meta, bodies, loaderName };
}

test('Fabric Loader : profil validé, bibliothèques vérifiées, JSON de version écrit pour le launcher officiel', async () => {
  const { profile, meta, bodies, loaderName } = fabricWorld();
  const dir = tempDir();
  const progress = [];
  const result = await installer.installFabric(dir, profile, (...a) => progress.push(a), { concurrency: 4 });
  assert.equal(result.libraries, meta.libraries.length);
  const id = 'fabric-loader-0.19.5-26.3';
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'versions', id, `${id}.json`), 'utf8'));
  assert.equal(written.id, id);
  assert.equal(written.inheritsFrom, '26.3');
  assert.equal(written.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.deepEqual(written.arguments.jvm, ['-DFabricMcEmu= net.minecraft.client.main.Main ']);
  assert.equal(written.libraries.length, meta.libraries.length);
  for (const lib of written.libraries) {
    const artifact = lib.downloads.artifact;
    const body = bodies.get(lib.name);
    assert.equal(artifact.sha1, hash('sha1', body), lib.name);
    assert.equal(artifact.size, body.length);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'libraries', ...artifact.path.split('/'))), body);
  }
  assert.ok(written.libraries.some((l) => l.name === loaderName));
  assert.ok(progress.every(([step]) => step === 'fabric'));
  // le .sha1 du serveur n'a pas servi : fabric-loader est contrôlé par le SHA-1 figé du catalogue
  assert.ok(!requested.some((u) => u.endsWith('.sha1')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Fabric Loader : jar qui ne correspond pas au SHA-1 figé ou au SHA-512 du profil rejeté, rien n’est écrit', async () => {
  const { profile, bodies, loaderName } = fabricWorld();
  const url = `https://maven.fabricmc.net/${mavenPath(loaderName)}`;
  routes.set(url, Buffer.from('jar remplacé par quelqu un d autre'));
  const dir = tempDir();
  await assert.rejects(installer.installFabric(dir, profile, noReport, { concurrency: 1 }), /SHA1 incorrect/);
  assert.ok(!fs.existsSync(path.join(dir, 'versions')), 'aucun JSON de version tant que tout n’est pas vérifié');
  assert.ok(!fs.existsSync(path.join(dir, 'libraries', ...mavenPath(loaderName).split('/'))));

  const world = fabricWorld();
  const asm = [...world.bodies.keys()].find((n) => n.includes('asm:asm:'));
  routes.set(`https://maven.fabricmc.net/${mavenPath(asm)}`, Buffer.from('autre contenu'));
  await assert.rejects(installer.installFabric(tempDir(), world.profile, noReport, { concurrency: 1 }), /SHA512 incorrect/);
  assert.ok(bodies.size > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Fabric Loader : sans SHA-1 figé, repli sur le .sha1 publié à côté du jar (et rejet s’il ne correspond pas)', async () => {
  const { profile, bodies, loaderName } = fabricWorld({ pinLoader: false });
  const url = `https://maven.fabricmc.net/${mavenPath(loaderName)}`;
  routes.set(`${url}.sha1`, `${hash('sha1', bodies.get(loaderName))}\n`);
  const dir = tempDir();
  await installer.installFabric(dir, profile, noReport, { concurrency: 2 });
  assert.ok(requested.includes(`${url}.sha1`));
  fs.rmSync(dir, { recursive: true, force: true });

  routes.set(`${url}.sha1`, `${'0'.repeat(40)}\n`);
  await assert.rejects(installer.installFabric(tempDir(), profile, noReport, { concurrency: 2 }), /SHA1 incorrect/);
});

test('Fabric Loader : profil de version piégé refusé avant tout téléchargement de bibliothèque', async () => {
  const { profile } = fabricWorld();
  const key = 'https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/profile/json';
  const evil = JSON.parse(routes.get(key));
  evil.libraries[0].url = 'https://evil.example/maven/';
  routes.set(key, JSON.stringify(evil));
  await assert.rejects(installer.installFabric(tempDir(), profile, noReport, { concurrency: 2 }), /non officiel/);
  assert.deepEqual(requested.filter((u) => u.includes('maven.fabricmc.net')), []);

  const jvm = JSON.parse(routes.get(key));
  jvm.libraries[0].url = 'https://maven.fabricmc.net/';
  jvm.arguments.jvm = ['-javaagent:C:\\evil.jar'];
  routes.set(key, JSON.stringify(jvm));
  await assert.rejects(installer.installFabric(tempDir(), profile, noReport, { concurrency: 2 }), /option Java refusée/);
});

// ---------- jar ATTACK depuis la release GitHub ----------

const RELEASE_URL = 'https://api.github.com/repos/7ShIkI3/attack-launcher/releases/latest';
const asset = (name, extra = {}) => ({ name, size: 1, browser_download_url: `https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.0/${name}`, ...extra });

test('release GitHub : le jar Fabric du profil est téléchargé et vérifié (SHA-256), celui de l’autre version est ignoré', async () => {
  const jar121 = Buffer.from('attack fabric 1.21.1');
  const jar263 = Buffer.from('attack fabric 26.3');
  routes.set(RELEASE_URL, JSON.stringify({
    tag_name: 'v0.5.0',
    assets: [
      asset('attack-client-2.3.0.jar', { digest: `sha256:${hash('sha256', 'forge')}` }),
      asset('attack-fabric-3.0.0+mc1.21.1.jar', { digest: `sha256:${hash('sha256', jar121)}`, size: jar121.length }),
      asset('attack-fabric-3.0.0+mc26.3.jar', { digest: `sha256:${hash('sha256', jar263)}`, size: jar263.length }),
    ],
  }));
  routes.set('https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.0/attack-fabric-3.0.0+mc1.21.1.jar', jar121);
  routes.set('https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.0/attack-fabric-3.0.0+mc26.3.jar', jar263);
  const dir = tempDir();
  const info = await installer.installMod(dir, { devMode: false }, noReport, {}, catalog.get('fabric-26.3'));
  assert.equal(info.source, 'release');
  assert.equal(info.version, 'v0.5.0');
  assert.equal(info.sha256, hash('sha256', jar263));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'mods', 'attack-fabric.jar')), jar263);
  assert.ok(!requested.some((u) => u.includes('mc1.21.1')), 'le jar de l’autre version de Minecraft n’est jamais demandé');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('release GitHub : pas de jar pour ce profil = erreur claire (NO_PROFILE_JAR) ; jar altéré rejeté', async () => {
  routes.set(RELEASE_URL, JSON.stringify({
    assets: [asset('attack-client-2.3.0.jar', { digest: `sha256:${hash('sha256', 'forge')}` }), asset('attack-fabric-3.0.0-beta.1+mc26.3.jar', { digest: `sha256:${'a'.repeat(64)}` })],
  }));
  const dir = tempDir();
  await assert.rejects(installer.installMod(dir, { devMode: false }, noReport, {}, catalog.get('fabric-26.3')),
    (error) => error.code === 'NO_PROFILE_JAR' && /attack-fabric-3\.0\.0-beta\.1\+mc26\.3\.jar/.test(error.message));
  await assert.rejects(installer.installMod(dir, { devMode: false }, noReport, {}, catalog.get('fabric-1.21.1')), (error) => error.code === 'NO_PROFILE_JAR');
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'attack-fabric.jar')));

  const good = Buffer.from('vrai jar');
  routes.set(RELEASE_URL, JSON.stringify({ assets: [asset('attack-fabric-3.0.0+mc1.21.1.jar', { digest: `sha256:${hash('sha256', good)}`, size: good.length })] }));
  routes.set('https://github.com/7ShIkI3/attack-launcher/releases/download/v0.5.0/attack-fabric-3.0.0+mc1.21.1.jar', Buffer.from('jar modifié !'));
  await assert.rejects(installer.installMod(dir, { devMode: false }, noReport, {}, catalog.get('fabric-1.21.1')), /SHA256 incorrect|Taille incorrecte/);
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'attack-fabric.jar')));

  routes.delete(RELEASE_URL);
  await assert.rejects(installer.installMod(dir, { devMode: false }, noReport, {}, catalog.get('fabric-1.21.1')), (error) => error.code === 'NO_RELEASE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mode développeur : le jar du dossier du profil, jamais celui d’un autre profil', async () => {
  const jars = tempDir();
  fs.writeFileSync(path.join(jars, 'attack-fabric-3.0.0+mc1.21.1.jar'), 'fabric 1.21.1');
  fs.writeFileSync(path.join(jars, 'attack-client-2.3.0.jar'), 'forge');
  const dir = tempDir();
  const info = await installer.installMod(dir, { devMode: true, devJarDir: jars }, noReport, {}, catalog.get('fabric-1.21.1'));
  assert.equal(info.source, 'dev');
  assert.equal(info.version, '3.0.0');
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'attack-fabric.jar'), 'utf8'), 'fabric 1.21.1');
  await assert.rejects(installer.installMod(tempDir(), { devMode: true, devJarDir: jars }, noReport, {}, catalog.get('fabric-26.3')),
    (error) => error.code === 'NO_DEV_JAR' && /attack-fabric-\*\+mc26\.3\.jar/.test(error.message));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(jars, { recursive: true, force: true });
});

// ---------- pack de mods et fichier d'état ----------

const FILES = {
  'sodium-1.jar': Buffer.from('sodium '.repeat(40)),
  'sodium-2.jar': Buffer.from('sodium deux '.repeat(40)),
  'iris-1.jar': Buffer.from('iris '.repeat(40)),
};
let server;
let base;
const net = { allowedHosts: new Set(['127.0.0.1']), retries: 0, concurrency: 2 };

test.before(async () => {
  server = http.createServer((req, res) => {
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

function localPack(sodium = 'sodium-1.jar') {
  const mod = (slug, filename, extra = {}) => ({
    slug, name: slug, version: '1', filename, url: `${base}/${filename}`, sha512: hash('sha512', FILES[filename]), size: FILES[filename].length, ...extra,
  });
  return { profileId: 'fabric-1.21.1', mc: '1.21.1', loader: 'fabric', mods: [mod('sodium', sodium), mod('iris', 'iris-1.jar', { optional: true })] };
}

const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'attack-launcher.json'), 'utf8'));
const mods = (dir) => fs.readdirSync(path.join(dir, 'mods')).sort();

test('pack : l’état garde les jars gérés (écriture atomique), le reste de l’état est conservé, Iris suit l’option', async () => {
  const profile = catalog.get('fabric-1.21.1');
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'attack-launcher.json'), JSON.stringify({ mod: { source: 'release', version: 'v0.5.0' }, installedAt: '2026-10-19T00:00:00.000Z' }));
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mods', 'mon-mod.jar'), 'joueur');

  const on = await installer.installPack(dir, profile, { shaders: true }, noReport, net, localPack());
  assert.deepEqual(readState(dir).pack.managed, ['sodium-1.jar', 'iris-1.jar']);
  assert.equal(readState(dir).pack.shaders, true);
  assert.equal(readState(dir).mod.version, 'v0.5.0', 'les autres champs de l’état sont conservés');
  assert.ok(!fs.existsSync(path.join(dir, 'attack-launcher.json.tmp')), 'pas de fichier temporaire oublié');
  assert.deepEqual(on.removed, []);

  const off = await installer.installPack(dir, profile, { shaders: false }, noReport, net, localPack());
  assert.deepEqual(off.removed, ['iris-1.jar']);
  assert.deepEqual(readState(dir).pack.managed, ['sodium-1.jar']);
  assert.deepEqual(mods(dir), ['mon-mod.jar', 'sodium-1.jar']);

  // mise à jour du pack : l'ancien jar géré disparaît d'après l'état
  const next = await installer.installPack(dir, profile, { shaders: false }, noReport, net, localPack('sodium-2.jar'));
  assert.deepEqual(next.removed, ['sodium-1.jar']);
  assert.deepEqual(mods(dir), ['mon-mod.jar', 'sodium-2.jar']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pack : échec au milieu d’une mise à jour = les nouveaux jars sont retirés, les anciens restent, l’état n’est pas modifié', async () => {
  const profile = catalog.get('fabric-1.21.1');
  const dir = tempDir();
  await installer.installPack(dir, profile, { shaders: false }, noReport, net, localPack());
  const before = readState(dir);
  const broken = localPack('sodium-2.jar');
  broken.mods.push({ ...broken.mods[1], slug: 'iris2', filename: 'iris-1.jar', optional: false, sha512: 'f'.repeat(128) });
  await assert.rejects(installer.installPack(dir, profile, { shaders: true }, noReport, net, broken), /SHA512 incorrect/);
  assert.deepEqual(mods(dir), ['sodium-1.jar'], 'ni sodium-2.jar ni iris-1.jar ne restent');
  assert.deepEqual(readState(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pack : jar à retirer verrouillé = il reste suivi, erreur PACK_CLEANUP après avoir enregistré l’état', async () => {
  const profile = catalog.get('fabric-1.21.1');
  const dir = tempDir();
  await installer.installPack(dir, profile, { shaders: false }, noReport, net, localPack());
  const realRm = fsp.rm;
  fsp.rm = async (target, options) => {
    if (String(target).endsWith('sodium-1.jar')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return realRm(target, options);
  };
  try {
    await assert.rejects(installer.installPack(dir, profile, { shaders: false }, noReport, net, localPack('sodium-2.jar')), (error) => error.code === 'PACK_CLEANUP' && /sodium-1\.jar/.test(error.message));
  } finally {
    fsp.rm = realRm;
  }
  assert.deepEqual(readState(dir).pack.managed, ['sodium-2.jar', 'sodium-1.jar'], 'l’ancien jar reste suivi pour être retiré plus tard');
  assert.deepEqual(mods(dir), ['sodium-1.jar', 'sodium-2.jar']);
  // jeu fermé : l'installation suivante retire l'ancien jar
  const again = await installer.installPack(dir, profile, { shaders: false }, noReport, net, localPack('sodium-2.jar'));
  assert.deepEqual(again.removed, ['sodium-1.jar']);
  assert.deepEqual(readState(dir).pack.managed, ['sodium-2.jar']);
  assert.deepEqual(mods(dir), ['sodium-2.jar']);
  fs.rmSync(dir, { recursive: true, force: true });
});
