'use strict';
// scripts/install-test.js : les parties qui ne demandent pas le réseau (jar factice de la 1.7.10, attentes des bibliothèques Forge,
// jar exact d'un brouillon lu avec gh, options). L'installation réelle elle-même se lance à la main (npm run install-test).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, makeZip } = require('./helpers');
const catalog = require('../src/main/catalog');
const forge = require('../src/main/forge');
const mod = require('../src/main/mod');
const optifine = require('../src/main/optifine');
const installer = require('../src/main/installer');
const { readEntries, readEntry } = require('../src/main/zip');
const it = require('../scripts/install-test');

const sha = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

/** Lit un class file (constantes, annotations de la classe) en vérifiant que tout le fichier est consommé : le jar factice est un vrai .class. */
function readClass(buffer) {
  let at = 0;
  const u1 = () => buffer[at++];
  const u2 = () => { at += 2; return buffer.readUInt16BE(at - 2); };
  const u4 = () => { at += 4; return buffer.readUInt32BE(at - 4); };
  assert.equal(u4(), 0xcafebabe);
  const minor = u2();
  const major = u2();
  const count = u2();
  const pool = [null];
  for (let i = 1; i < count; i++) {
    const tag = u1();
    if (tag === 1) { const length = u2(); pool.push({ tag, text: buffer.toString('utf8', at, at + length) }); at += length; }
    else if (tag === 7) pool.push({ tag, name: u2() });
    else if (tag === 12) pool.push({ tag, name: u2(), type: u2() });
    else if (tag === 10) pool.push({ tag, klass: u2(), nameAndType: u2() });
    else throw new Error(`constante ${tag} non gérée`);
  }
  const text = (index) => pool[index].text;
  const access = u2();
  const thisClass = text(pool[u2()].name);
  const superClass = text(pool[u2()].name);
  assert.equal(u2(), 0, 'aucune interface');
  assert.equal(u2(), 0, 'aucun champ');
  const methods = [];
  for (let n = u2(); n > 0; n--) {
    const method = { access: u2(), name: text(u2()), descriptor: text(u2()), attributes: [] };
    for (let a = u2(); a > 0; a--) { const name = text(u2()); const length = u4(); method.attributes.push(name); at += length; }
    methods.push(method);
  }
  const annotations = [];
  for (let a = u2(); a > 0; a--) {
    const name = text(u2());
    const length = u4();
    const end = at + length;
    if (name === 'RuntimeVisibleAnnotations') {
      for (let n = u2(); n > 0; n--) {
        const type = text(u2());
        const values = {};
        for (let p = u2(); p > 0; p--) { const key = text(u2()); assert.equal(String.fromCharCode(u1()), 's'); values[key] = text(u2()); }
        annotations.push({ type, values });
      }
    }
    assert.equal(at, end, `attribut ${name} lu en entier`);
  }
  assert.equal(at, buffer.length, 'tout le class file est consommé');
  return { minor, major, access, thisClass, superClass, methods, annotations };
}

test('jar factice de la 1.7.10 : mcmod.info et une classe @Mod valide (FML 1.7.10 ne voit un mod que par son annotation)', () => {
  const dir = tempDir();
  const profile = catalog.get('forge-1.7.10');
  const file = it.makeDummyForgeJar(dir, profile);
  assert.equal(path.basename(file), 'attack-forge-0.0.0+mc1.7.10.jar');
  // le nom suit la règle du profil 1.7.10, et seulement la sienne
  assert.equal(catalog.jarRule(profile).matches(path.basename(file)), true);
  assert.equal(catalog.jarRule(catalog.get('forge-1.8.9')).matches(path.basename(file)), false);
  assert.equal(mod.findDevJar(dir, profile).name, 'attack-forge-0.0.0+mc1.7.10.jar');
  assert.equal(mod.findDevJar(dir, 'forge-1.8.9'), null);
  assert.equal(mod.versionFromJarName(path.basename(file), profile), '0.0.0');

  const zip = fs.readFileSync(file);
  const entries = readEntries(zip);
  assert.deepEqual([...entries.keys()].sort(), ['DUMMY.txt', 'attack/dummy/DummyMod.class', 'mcmod.info']);
  const info = JSON.parse(readEntry(zip, 'mcmod.info', entries).toString('utf8'));
  assert.equal(info[0].modid, 'attack');
  assert.equal(info[0].name, 'ATTACK Client', 'le nom que scripts/launch-test.js cherche (FMLFileResourcePack:ATTACK Client)');
  assert.equal(info[0].mcversion, '1.7.10');
  const klass = readClass(readEntry(zip, 'attack/dummy/DummyMod.class', entries));
  assert.equal(klass.major, 49, 'class file version 49 : pas de StackMapTable à fournir');
  assert.equal(klass.thisClass, 'attack/dummy/DummyMod');
  assert.equal(klass.superClass, 'java/lang/Object');
  assert.deepEqual(klass.methods.map((m) => [m.name, m.descriptor, m.access]), [['<init>', '()V', 1]], 'un constructeur public sans argument');
  assert.deepEqual(klass.annotations, [{ type: 'Lcpw/mods/fml/common/Mod;', values: { modid: 'attack', name: 'ATTACK Client', version: '0.0.0-dummy' } }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('jar factice : Fabric et 1.7.10 seulement, jamais pour le profil Forge 1.8.9', () => {
  assert.deepEqual(catalog.list().map((p) => [p.id, it.allowsDummyJar(p)]), [
    ['forge-1.8.9', false], ['fabric-1.21.1', true], ['fabric-26.3', true], ['forge-1.7.10', true],
  ]);
  const dir = tempDir();
  assert.throws(() => it.makeDummyForgeJar(dir, catalog.get('forge-1.8.9')), /Pas de jar factice/);
  assert.throws(() => it.makeDummyJar(dir, catalog.get('forge-1.8.9')), /Pas de jar factice/);
  assert.equal(path.basename(it.makeDummyJar(dir, catalog.get('forge-1.7.10'))), 'attack-forge-0.0.0+mc1.7.10.jar');
  const fabric = it.makeDummyJar(dir, catalog.get('fabric-26.3'));
  assert.equal(path.basename(fabric), 'attack-fabric-0.0.0+mc26.3.jar');
  assert.ok(readEntries(fs.readFileSync(fabric)).has('fabric.mod.json'));
  assert.equal(it.makeDummyFabricJar(dir, catalog.get('fabric-1.21.1')).endsWith('attack-fabric-0.0.0+mc1.21.1.jar'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bibliothèques Forge 1.7.10 : attendues d’après l’install_profile.json de l’installateur, pas d’après le launcher', () => {
  const profile = catalog.get('forge-1.7.10');
  const real = fixture('forge-1.7.10-install_profile.json');
  const universal = Buffer.from('universal de l installateur '.repeat(30));
  const installer = makeZip({ 'install_profile.json': JSON.stringify(real), [real.install.filePath]: universal });
  const expected = it.forgeLibraryExpectations(installer, profile);
  assert.equal(expected.length, forge.clientLibraries(real.versionInfo).length);
  assert.equal(expected.length, 18);
  // le jar universal vaut le fichier de l'installateur
  const universalEntry = expected.find((e) => e.name === real.install.path);
  assert.deepEqual(universalEntry.sha1, [sha('sha1', universal)]);
  assert.equal(universalEntry.path, 'net/minecraftforge/forge/1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10.jar');
  assert.equal(universalEntry.source, 'jar universal de l’installateur');
  // une bibliothèque avec checksums : n'importe lequel des SHA-1 du profil ; sans checksum : le .sha1 du dépôt Maven
  const scala = expected.find((e) => e.name === 'org.scala-lang:scala-library:2.11.1');
  assert.deepEqual(scala.sha1, real.versionInfo.libraries.find((l) => l.name === scala.name).checksums.map((h) => h.toLowerCase()));
  assert.equal(scala.sha1.length, 2);
  assert.equal(scala.url, 'https://maven.minecraftforge.net/org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar');
  const launchwrapper = expected.find((e) => e.name === 'net.minecraft:launchwrapper:1.12');
  assert.equal(launchwrapper.sha1, null);
  assert.equal(launchwrapper.source, '.sha1 du dépôt Maven');
  assert.equal(launchwrapper.url, 'https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar');
  assert.ok(expected.every((e) => e.sha1 === null || e.sha1.every((h) => /^[0-9a-f]{40}$/.test(h))));

  // l'installateur d'un autre profil Forge n'est pas accepté pour celui-ci
  const other = makeZip({ 'install_profile.json': JSON.stringify(real), [real.install.filePath]: universal });
  assert.throws(() => it.forgeLibraryExpectations(other, catalog.get('forge-1.8.9')), /Installateur inattendu/);
});

/**
 * Faux gh : `release view` rend la release, `release download` écrit le fichier demandé ou rend SHA256SUMS.
 * `sidecars` : { nom du jar : texte de son fichier <jar>.sha256 } joints à la release (lus avec `--output -`) ; `sidecarsFail` : leur
 * téléchargement échoue.
 */
function fakeGh({ jars, digest = true, tag = 'v0.8.0', draft = true, bodies = {}, sums = true, calls = [], sidecars = {}, sidecarsFail = false }) {
  const sidecarAssets = Object.keys(sidecars).map((n) => `${n}.sha256`);
  const assets = [...jars, ...sidecarAssets, ...(sums ? ['SHA256SUMS'] : [])].map((name) => ({
    name, size: 10, url: `https://github.com/7ShIkI3/attack-launcher/releases/download/${tag}/${name}`,
    ...(digest && name !== 'SHA256SUMS' ? { digest: `sha256:${sha('sha256', bodies[name] ?? `jar ${name}`)}` } : {}),
  }));
  const run = (args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ tagName: tag, isDraft: draft, isPrerelease: false, assets });
    const pattern = args[args.indexOf('--pattern') + 1];
    if (sidecarAssets.includes(pattern)) {
      if (sidecarsFail) throw new Error('gh : introuvable');
      return sidecars[pattern.slice(0, -'.sha256'.length)];
    }
    if (pattern === 'SHA256SUMS') return `${jars.map((n) => `${sha('sha256', bodies[n] ?? `jar ${n}`)}  ${n}`).join('\n')}\n`;
    const dir = args[args.indexOf('--dir') + 1];
    fs.writeFileSync(path.join(dir, pattern), bodies[pattern] ?? `jar ${pattern}`);
    return '';
  };
  return run;
}

test('--tag : le jar exact du brouillon est lu avec gh, vérifié par son SHA-256, puis prêt pour une installation en mode développeur', () => {
  const dir = tempDir();
  const jars = ['attack-client-2.7.0.jar', 'attack-fabric-3.6.0+mc1.21.1.jar', 'attack-fabric-3.6.0+mc26.3.jar', 'attack-forge-1.0.0+mc1.7.10.jar'];
  const calls = [];
  const result = it.fetchTagJar({ tag: 'v0.8.0', profile: catalog.get('forge-1.7.10'), dir, run: fakeGh({ jars, calls }) });
  assert.equal(result.name, 'attack-forge-1.0.0+mc1.7.10.jar');
  assert.equal(result.tag, 'v0.8.0');
  assert.equal(result.draft, true);
  assert.equal(result.file, path.join(dir, 'attack-forge-1.0.0+mc1.7.10.jar'));
  assert.equal(fs.readFileSync(result.file, 'utf8'), 'jar attack-forge-1.0.0+mc1.7.10.jar');
  assert.equal(result.sha256, sha('sha256', 'jar attack-forge-1.0.0+mc1.7.10.jar'));
  // le jar téléchargé est celui que la règle du profil désigne, et le dossier ne contient que lui
  assert.equal(mod.findDevJar(dir, 'forge-1.7.10').name, result.name);
  assert.deepEqual(fs.readdirSync(dir), [result.name]);
  // gh : la release (brouillon compris) puis UN seul jar, choisi par son nom exact ; jamais les autres jars
  const downloads = calls.filter((c) => c[1] === 'download' && c.includes('--dir'));
  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0], ['release', 'download', 'v0.8.0', '--repo', '7ShIkI3/attack-launcher', '--pattern', 'attack-forge-1.0.0+mc1.7.10.jar', '--dir', dir, '--clobber']);
  assert.deepEqual(calls[0], ['release', 'view', 'v0.8.0', '--repo', '7ShIkI3/attack-launcher', '--json', 'tagName,isDraft,isPrerelease,assets']);

  // chaque profil prend SON jar dans la même release
  for (const [id, name] of [['forge-1.8.9', jars[0]], ['fabric-1.21.1', jars[1]], ['fabric-26.3', jars[2]]]) {
    const sub = path.join(dir, id);
    assert.equal(it.fetchTagJar({ tag: 'v0.8.0', profile: catalog.get(id), dir: sub, run: fakeGh({ jars }) }).name, name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--tag : jar altéré, jar absent du profil ou sans SHA-256 = refusé, rien n’est laissé dans le dossier', () => {
  const jars = ['attack-client-2.7.0.jar', 'attack-forge-1.0.0+mc1.7.10.jar'];
  const profile = catalog.get('forge-1.7.10');
  // le fichier téléchargé n'est pas celui du digest
  const dir = tempDir();
  const run = fakeGh({ jars });
  const tampered = (args) => {
    const out = run(args);
    if (args[1] === 'download' && args.includes('--dir')) fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], args[args.indexOf('--pattern') + 1]), 'jar remplacé');
    return out;
  };
  assert.throws(() => it.fetchTagJar({ tag: 'v0.8.0', profile, dir, run: tampered }), /SHA-256 incorrect pour attack-forge-1\.0\.0\+mc1\.7\.10\.jar/);
  assert.deepEqual(fs.readdirSync(dir), [], 'le jar altéré est supprimé');
  // pas de jar 1.7.10 dans la release
  assert.throws(() => it.fetchTagJar({ tag: 'v0.8.0', profile, dir, run: fakeGh({ jars: ['attack-client-2.7.0.jar'] }) }), (error) => error.code === 'NO_JAR');
  // ni digest ni SHA256SUMS : le launcher refuserait ce jar, le test aussi
  assert.throws(() => it.fetchTagJar({ tag: 'v0.8.0', profile, dir, run: fakeGh({ jars, digest: false, sums: false }) }), /ne publie pas de SHA-256/);
  // sans digest, la ligne de SHA256SUMS fait foi
  const viaSums = it.fetchTagJar({ tag: 'v0.8.0', profile, dir, run: fakeGh({ jars, digest: false }) });
  assert.equal(viaSums.sha256, sha('sha256', 'jar attack-forge-1.0.0+mc1.7.10.jar'));
  // gh n'a rien écrit
  assert.throws(() => it.fetchTagJar({ tag: 'v0.8.0', profile, dir: tempDir(), run: (args) => (args[1] === 'view' ? fakeGh({ jars })(args) : '') }), /n'a pas téléchargé/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('options : --tag et --release s’excluent, valeurs obligatoires, options inconnues refusées, dossier positionnel', () => {
  assert.deepEqual(it.parseArgs([]), {
    profile: 'forge-1.8.9', useRelease: false, tag: null, shaders: false, replay: false, cycle: false, optifine: null, positional: [],
  });
  const full = it.parseArgs(['C:\\temp\\essai', '--profile', 'forge-1.7.10', '--tag', 'v0.8.0', '--cycle']);
  assert.deepEqual([full.profile, full.tag, full.cycle, full.shaders, full.positional], ['forge-1.7.10', 'v0.8.0', true, true, ['C:\\temp\\essai']]);
  assert.equal(it.parseArgs(['--release']).useRelease, true);
  assert.throws(() => it.parseArgs(['--release', '--tag', 'v0.8.0']), /ne vont pas ensemble/);
  assert.throws(() => it.parseArgs(['--tag']), /--tag attend une valeur/);
  assert.throws(() => it.parseArgs(['--tag', '--release']), /--tag attend une valeur/);
  assert.throws(() => it.parseArgs(['--inconnue']), /Option inconnue/);
});

test('aide du script : profils, --tag et jar factice documentés', () => {
  const head = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-test.js'), 'utf8').split('\n').slice(0, 30).join('\n');
  assert.match(head, /--profile\s+forge-1\.8\.9 \(défaut\), forge-1\.7\.10, fabric-1\.21\.1 ou fabric-26\.3/);
  assert.match(head, /--tag\s+jar ATTACK EXACT d'une release précise, BROUILLON compris/);
  assert.match(head, /JAR FACTICE/);
  assert.match(head, /install_profile\.json/);
});

test('contre-vérification des bibliothèques Forge 1.7.10 : checksums de l’installateur, .sha1 Maven pour les autres, écarts signalés', async () => {
  const { hashFile } = require('../src/main/http');
  const profile = catalog.get('forge-1.7.10');
  const real = fixture('forge-1.7.10-install_profile.json');
  const universal = Buffer.from('universal de Forge 1.7.10 '.repeat(30));
  const bodies = new Map();
  for (const lib of real.versionInfo.libraries) {
    if (lib.name === real.install.path) continue;
    const body = Buffer.from(`jar ${lib.name}`);
    bodies.set(lib.name, body);
    if (lib.checksums) lib.checksums = lib.checksums.map((_, i, all) => (i === all.length - 1 ? sha('sha1', body) : 'f'.repeat(40)));
  }
  const installerJar = makeZip({ 'install_profile.json': JSON.stringify(real), [real.install.filePath]: universal });
  const installerUrl = forge.installerUrl(profile);
  const expected = it.forgeLibraryExpectations(installerJar, profile);

  /** Faux fetch : l'installateur, son .sha1 et le .sha1 Maven des bibliothèques sans checksum. */
  const routes = new Map([[installerUrl, installerJar], [`${installerUrl}.sha1`, sha('sha1', installerJar)]]);
  for (const lib of expected) if (lib.url && lib.sha1 === null) routes.set(`${lib.url}.sha1`, `${sha('sha1', bodies.get(lib.name))}  ${lib.name}\n`);
  const fakeFetch = (table) => async (url) => {
    const body = table.get(url);
    return { arrayBuffer: async () => Buffer.from(body ?? ''), text: async () => String(body ?? 'absent') };
  };

  /** Dossier .minecraft avec les bibliothèques posées par « le launcher » (les vrais faux jars), et le JSON de version qui les liste. */
  const install = () => {
    const dir = tempDir();
    for (const lib of expected) {
      const file = path.join(dir, 'libraries', ...lib.path.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lib.name === real.install.path ? universal : bodies.get(lib.name));
    }
    return { dir, loaderJson: { libraries: expected.map((e) => ({ name: e.name })) } };
  };
  const run = async ({ dir, loaderJson }, table = routes) => {
    const failures = [];
    const check = async (file, algorithm, wanted, label) => {
      if (!fs.existsSync(file)) return failures.push(`absent : ${label}`);
      const list = Array.isArray(wanted) ? wanted : [wanted];
      if (!list.includes(await hashFile(file, algorithm))) failures.push(`hash faux : ${label}`);
      return undefined;
    };
    const summary = await it.verifyForgeLibraries({ profile, minecraftDir: dir, loaderJson, check, fail: (m) => failures.push(m), fetchFn: fakeFetch(table) });
    return { failures, summary };
  };

  // tout est conforme : 18 bibliothèques, d'après trois sources
  let world = install();
  let result = await run(world);
  assert.deepEqual(result.failures, []);
  assert.match(result.summary, /^18 bibliothèques Forge recontrôlées avec l'installateur officiel/);
  assert.match(result.summary, /1 par jar universal de l’installateur/);
  assert.match(result.summary, /\d+ par checksums de install_profile\.json/);
  assert.match(result.summary, /\d+ par \.sha1 du dépôt Maven/);

  // une bibliothèque modifiée (avec checksums), une sans checksum (.sha1 Maven) et le jar universal : trois écarts nommés
  const scala = expected.find((e) => e.name === 'org.scala-lang:scala-library:2.11.1');
  const launchwrapper = expected.find((e) => e.name === 'net.minecraft:launchwrapper:1.12');
  const forgeJar = expected.find((e) => e.name === real.install.path);
  for (const lib of [scala, launchwrapper, forgeJar]) fs.writeFileSync(path.join(world.dir, 'libraries', ...lib.path.split('/')), 'remplacé');
  result = await run(world);
  assert.deepEqual([...result.failures].sort(), [
    `hash faux : ${forgeJar.name} (jar universal de l’installateur)`,
    `hash faux : ${scala.name} (checksums de install_profile.json)`,
    `hash faux : ${launchwrapper.name} (.sha1 du dépôt Maven)`,
  ].sort());

  // fichier absent, JSON de version qui ne liste pas les mêmes bibliothèques
  world = install();
  fs.rmSync(path.join(world.dir, 'libraries', ...scala.path.split('/')));
  world.loaderJson.libraries.pop();
  result = await run(world);
  assert.ok(result.failures.includes(`absent : ${scala.name} (${scala.source})`));
  assert.ok(result.failures.includes('bibliothèques Forge installées ≠ celles de l’installateur officiel'));

  // le .sha1 de Maven pour l'installateur ne correspond pas, ou le .sha1 d'une bibliothèque est introuvable
  world = install();
  const wrongInstaller = new Map(routes).set(`${installerUrl}.sha1`, 'a'.repeat(40));
  assert.ok((await run(world, wrongInstaller)).failures.includes('installateur Forge : SHA-1 différent de celui de Maven'));
  const noSha1 = new Map(routes);
  noSha1.delete(`${launchwrapper.url}.sha1`);
  assert.deepEqual((await run(world, noSha1)).failures, [`hash faux : ${launchwrapper.name} (.sha1 du dépôt Maven)`]);
  fs.rmSync(world.dir, { recursive: true, force: true });
});

// ---------- Copilot 1 : un jar de brouillon (sans digest GitHub) est vérifié par son fichier <jar>.sha256 ET par SHA256SUMS ----------

const TAG_JARS = ['attack-client-2.7.0.jar', 'attack-fabric-3.6.0+mc1.21.1.jar', 'attack-fabric-3.6.0+mc26.3.jar', 'attack-forge-1.0.0+mc1.7.10.jar'];
const TAG_NAME = 'attack-forge-1.0.0+mc1.7.10.jar';
const TAG_HASH = sha('sha256', `jar ${TAG_NAME}`);

test('--tag sans digest GitHub : le fichier <jar>.sha256 de la release est lu avec gh et doit dire la même chose que SHA256SUMS, sinon le jar est refusé sans rien télécharger', () => {
  const profile = catalog.get('forge-1.7.10');
  const attempt = (options) => {
    const dir = tempDir();
    return { dir, run: () => it.fetchTagJar({ tag: 'v0.8.0', profile, dir, run: fakeGh({ jars: TAG_JARS, digest: false, ...options }) }) };
  };

  // d'accord : le jar est téléchargé et les deux sources sont citées ; le .sha256 est lu avec --output - (jamais écrit sur le disque)
  const calls = [];
  const good = attempt({ sidecars: { [TAG_NAME]: `${TAG_HASH}  ${TAG_NAME}\n` }, calls });
  const ok = good.run();
  assert.equal(ok.sha256, TAG_HASH);
  assert.deepEqual(ok.sources, [`${TAG_NAME}.sha256`, 'SHA256SUMS']);
  assert.ok(calls.some((c) => c[1] === 'download' && c.includes('--output') && c[c.indexOf('--pattern') + 1] === `${TAG_NAME}.sha256`));
  assert.deepEqual(fs.readdirSync(good.dir), [TAG_NAME], 'seul le jar est dans le dossier');

  // le .sha256 contredit SHA256SUMS : refusé AVANT le téléchargement du jar
  const bad = attempt({ sidecars: { [TAG_NAME]: `${'a'.repeat(64)}  ${TAG_NAME}\n` } });
  assert.throws(bad.run, /SHA-256 incohérents pour attack-forge-1\.0\.0\+mc1\.7\.10\.jar.*attack-forge-1\.0\.0\+mc1\.7\.10\.jar\.sha256 aaaaaaaaaaaa….*SHA256SUMS/);
  assert.deepEqual(fs.readdirSync(bad.dir), [], 'rien n’est téléchargé');

  // le .sha256 est joint mais gh ne peut pas le lire : refusé (le launcher le lirait, pas ce contrôle)
  const lost = attempt({ sidecars: { [TAG_NAME]: 'x' }, sidecarsFail: true });
  assert.throws(lost.run, /attack-forge-1\.0\.0\+mc1\.7\.10\.jar\.sha256 est joint à la release v0\.8\.0 mais n'a pas pu être lu/);
  assert.deepEqual(fs.readdirSync(lost.dir), []);

  // sans hash lisible dans le .sha256
  assert.throws(attempt({ sidecars: { [TAG_NAME]: 'rien de lisible' } }).run, /sans hash valide/);

  // le .sha256 seul (SHA256SUMS absent) suffit à nommer le hash ; sans aucune source, refus
  const alone = attempt({ sums: false, sidecars: { [TAG_NAME]: `${TAG_HASH}\n` } }).run();
  assert.deepEqual(alone.sources, [`${TAG_NAME}.sha256`]);
  assert.throws(attempt({ sums: false }).run, /ne publie pas de SHA-256/);

  // le .sha256 d'un AUTRE jar de la release ne compte pas pour ce jar
  const other = attempt({ sidecars: { 'attack-client-2.7.0.jar': `${'e'.repeat(64)}  attack-client-2.7.0.jar\n` } }).run();
  assert.deepEqual(other.sources, ['SHA256SUMS']);
});

test('expectedSha256 : digest GitHub, fichier <jar>.sha256 et ligne de SHA256SUMS s’accordent ou le jar est refusé', () => {
  const name = 'attack-forge-1.0.0+mc1.7.10.jar';
  const hash = 'b'.repeat(64);
  const release = { tag_name: 'v0.8.0', assets: [{ name: `${name}.sha256` }] };
  const bare = { tag_name: 'v0.8.0', assets: [] };
  const sumsText = `${hash}  ${name}\n`;
  const sidecars = { [`${name}.sha256`]: `${hash}  ${name}\n` };
  // les trois sources d'accord
  assert.deepEqual(it.expectedSha256({ release, asset: { name, sha256: hash }, sumsText, sidecars }), { sha256: hash, sources: ['digest GitHub', `${name}.sha256`, 'SHA256SUMS'] });
  // le digest GitHub seul (aucune autre source jointe)
  assert.deepEqual(it.expectedSha256({ release: bare, asset: { name, sha256: hash } }), { sha256: hash, sources: ['digest GitHub'] });
  // digest contredit par le .sha256 et SHA256SUMS, ou seulement par SHA256SUMS
  assert.throws(() => it.expectedSha256({ release, asset: { name, sha256: 'c'.repeat(64) }, sumsText, sidecars }), /SHA-256 incohérents.*digest GitHub cccccccccccc….*SHA256SUMS bbbbbbbbbbbb…/);
  assert.throws(() => it.expectedSha256({ release: bare, asset: { name, sha256: hash }, sumsText: `${'d'.repeat(64)}  ${name}\n` }), /SHA-256 incohérents/);
  // SHA256SUMS sans la ligne du jar : toléré quand une autre source existe, refusé sinon (deux lignes d'autres jars ne sont pas la sienne)
  assert.equal(it.expectedSha256({ release: bare, asset: { name, sha256: hash }, sumsText: `${hash}  autre.jar\n` }).sha256, hash);
  assert.throws(() => it.expectedSha256({ release: bare, asset: { name }, sumsText: `${hash}  autre.jar\n${'e'.repeat(64)}  autre2.jar\n` }), /Aucun SHA-256 pour/);
  assert.throws(() => it.expectedSha256({ release: bare, asset: { name } }), /Aucun SHA-256 connu/);
});

// ---------- --optifine par spec : refus, jar déposé, cycle ----------

const optifineSpecs = Object.values(optifine.SPECS);
const specManifest = (spec, tweak = spec.tweak) => `Manifest-Version: 1.0\r\nTweakClass: ${tweak}\r\n\r\n`;
const specJar = (spec, salt = '') => makeZip({ 'META-INF/MANIFEST.MF': specManifest(spec), 'optifine/OptiFineForgeTweaker.class': `classe ${salt}` });
const specName = (spec) => `OptiFine_${spec.mc}_${spec.edition}.jar`;

test('--optifine : refusé pour un profil sans OptiFine, une racine hors du dossier temporaire, un jar sous .lunarclient ou d’une autre version', async () => {
  const tmp = tempDir('atk-it-'); // tient lieu de dossier temporaire du système
  const root = path.join(tmp, 'racine');
  const outside = tempDir('atk-it-hors-'); // ailleurs que sous `tmp`
  const spec89 = optifine.forVersion('1.8.9');
  const spec710 = optifine.forVersion('1.7.10');
  const good710 = path.join(tmp, specName(spec710));
  fs.writeFileSync(good710, specJar(spec710));
  const good89 = path.join(tmp, specName(spec89));
  fs.writeFileSync(good89, specJar(spec89));
  const args = (extra) => ({ profile: catalog.get('forge-1.7.10'), root, source: good710, tmp, ...extra });

  // accepté, pour chaque profil avec son jar
  const checked = await it.checkOptifineArgs(args({}));
  assert.deepEqual([checked.ok, checked.version, checked.mc], [true, 'HD_U_E7', '1.7.10']);
  assert.equal((await it.checkOptifineArgs(args({ profile: catalog.get('forge-1.8.9'), source: good89 }))).version, 'HD_U_M5');

  // profil sans OptiFine : Fabric
  for (const id of ['fabric-1.21.1', 'fabric-26.3']) {
    await assert.rejects(it.checkOptifineArgs(args({ profile: catalog.get(id) })), /ne s'applique pas au profil .*n'a pas OptiFine \(profils avec OptiFine : forge-1\.8\.9, forge-1\.7\.10\)/);
  }
  // racine hors du dossier temporaire, ou le dossier temporaire lui-même, ou une racine qui en sort par « .. »
  await assert.rejects(it.checkOptifineArgs(args({ root: outside })), /racine d'essai doit être sous le dossier temporaire/);
  await assert.rejects(it.checkOptifineArgs(args({ root: tmp })), /racine d'essai doit être sous le dossier temporaire/);
  await assert.rejects(it.checkOptifineArgs(args({ root: path.join(tmp, '..', 'ailleurs') })), /racine d'essai doit être sous le dossier temporaire/);
  // racine qui paraît sous le dossier temporaire mais en sort par une jonction (ou un lien symbolique) : refusée sur le chemin RÉEL.
  // Sans la seconde condition de la garde (chemins réels), cette racine serait acceptée et l'essai écrirait hors du dossier temporaire.
  const link = path.join(tmp, 'lien');
  fs.symlinkSync(outside, link, 'junction');
  assert.equal(it.isInside(path.join(link, 'racine'), tmp), true, 'lexicalement, la racine est bien sous le dossier temporaire');
  await assert.rejects(it.checkOptifineArgs(args({ root: path.join(link, 'racine') })), /racine d'essai doit être sous le dossier temporaire/, 'racine à créer sous la jonction');
  fs.mkdirSync(path.join(outside, 'existante'));
  await assert.rejects(it.checkOptifineArgs(args({ root: path.join(link, 'existante') })), /racine d'essai doit être sous le dossier temporaire/, 'racine existante sous la jonction');
  assert.equal(fs.existsSync(path.join(outside, 'racine')), false, 'rien n’a été créé hors du dossier temporaire');
  // un vrai sous-dossier du dossier temporaire reste accepté
  assert.equal((await it.checkOptifineArgs(args({ root: path.join(tmp, 'vraie-racine') }))).ok, true);
  fs.unlinkSync(link); // une jonction se retire comme un lien : le dossier visé (outside) n'est pas touché
  // jar du cache de Lunar : refusé même s'il est parfaitement valide
  const lunar = path.join(tmp, '.lunarclient', 'offline', 'multiver');
  fs.mkdirSync(lunar, { recursive: true });
  fs.writeFileSync(path.join(lunar, specName(spec710)), specJar(spec710));
  await assert.rejects(it.checkOptifineArgs(args({ source: path.join(lunar, specName(spec710)) })), /Lunar Client \(\.lunarclient\)/);
  await assert.rejects(it.checkOptifineArgs(args({ source: path.join(tmp, '.LunarClient', 'x', specName(spec710)) })), /Lunar Client/, 'casse ignorée, même si le fichier n’existe pas');
  // jar d'une autre version de Minecraft (1.8.9 donné pour la 1.7.10 et l'inverse), archive illisible, TweakClass absent, fichier absent
  await assert.rejects(it.checkOptifineArgs(args({ source: good89 })), /n'est pas un OptiFine 1\.7\.10 valide \(WRONG_NAME\).*ne contient pas 1\.7\.10/);
  await assert.rejects(it.checkOptifineArgs(args({ profile: catalog.get('forge-1.8.9'), source: good710 })), /n'est pas un OptiFine 1\.8\.9 valide \(WRONG_NAME\)/);
  const broken = path.join(tmp, 'OptiFine_1.7.10_HD_U_E8.jar');
  fs.writeFileSync(broken, 'pas une archive');
  await assert.rejects(it.checkOptifineArgs(args({ source: broken })), /\(BAD_ZIP\)/);
  fs.writeFileSync(broken, makeZip({ 'META-INF/MANIFEST.MF': specManifest(spec710, 'autre.Tweaker') }));
  await assert.rejects(it.checkOptifineArgs(args({ source: broken })), /\(NO_TWEAK\).*Forge 1\.7\.10/);
  await assert.rejects(it.checkOptifineArgs(args({ source: path.join(tmp, 'OptiFine_1.7.10_absent.jar') })), /\(UNREADABLE\)/);
  // isInside : strictement dedans, casse ignorée sous Windows
  assert.equal(it.isInside(path.join(tmp, 'a', 'b'), tmp), true);
  assert.equal(it.isInside(tmp, tmp), false);
  assert.equal(it.isInside(path.join(tmp, '..'), tmp), false);
  for (const dir of [tmp, outside]) fs.rmSync(dir, { recursive: true, force: true });
});

/** status() d'une installation de test complète, sauf le mod : version `modVersion` avec OptiFine actif (spec de la 1.7.10, minMod 1.1.0). */
const statusWith = (modVersion, over = {}) => {
  const optifineView = { ...over.optifine, minMod: '1.1.0', modOutdated: mod.olderThan(modVersion, '1.1.0'), pending: false };
  return { minecraft: true, loader: true, pack: null, mod: true, profile: true, modVersion, ...over, optifine: optifineView, installed: !optifineView.modOutdated };
};

test('contrôle final : le mod plus ancien que minMod avec OptiFine actif n’est toléré qu’avec le jar factice', () => {
  // jar factice 0.0.0 : la mise à jour du mod est demandée, c'est attendu
  const dummy = it.judgeStatus({ status: statusWith('0.0.0'), dummy: true });
  assert.equal(dummy.failure, undefined);
  assert.ok(dummy.note.includes('mod 0.0.0 plus ancien que 1.1.0 avec OptiFine actif') && dummy.note.includes('attendu avec le jar factice'), dummy.note);
  // le même état avec le jar d'une release (--tag, --release) ou d'un vrai build, resté en 1.0.0 : ÉCHEC
  for (const modVersion of ['1.0.0', '0.0.0', '1.0.9']) {
    const verdict = it.judgeStatus({ status: statusWith(modVersion), dummy: false });
    assert.equal(verdict.note, undefined, modVersion);
    assert.ok(verdict.failure.includes(`mod ${modVersion} plus ancien que 1.1.0 avec OptiFine actif`), verdict.failure);
    assert.ok(verdict.failure.includes('ne pourrait pas jouer') && verdict.failure.includes('mod 1.1.0 au moins'), verdict.failure);
  }
  assert.equal(it.judgeStatus({ status: statusWith('1.0.0') }).failure !== undefined, true, 'sans l’option dummy : un échec');
  // mod à jour : installé, rien à dire (jar factice ou non)
  for (const modVersion of ['1.1.0', '1.2.3']) {
    assert.deepEqual(it.judgeStatus({ status: statusWith(modVersion), dummy: false }), {}, modVersion);
  }
  // incohérent : installé alors que modOutdated est vrai
  const incoherent = { ...statusWith('1.1.0'), optifine: { modOutdated: true, minMod: '1.1.0' }, installed: true };
  assert.match(it.judgeStatus({ status: incoherent }).failure, /modOutdated alors que installed est vrai/);
  // le mod trop ancien ne cache jamais un autre manque : Minecraft ou un OptiFine à copier encore en attente = échec, même avec le jar factice
  for (const over of [{ minecraft: false }, { loader: false }, { mod: false }, { profile: false }, { pack: false }, { optifine: { pending: true } }]) {
    const status = statusWith('0.0.0', over);
    if (over.optifine) status.optifine.pending = true;
    const verdict = it.judgeStatus({ status, dummy: true });
    assert.ok(verdict.failure.startsWith('status() incomplet'), `${JSON.stringify(over)} : ${verdict.failure}`);
  }
  // sans OptiFine (profil Fabric, ou interrupteur coupé) : pas installé = incomplet, jamais « attendu »
  assert.ok(it.judgeStatus({ status: { minecraft: true, loader: true, pack: true, mod: false, profile: true, installed: false }, dummy: true }).failure.startsWith('status() incomplet'));
});

test('--cycle sans rien à cycler : le script le dit au lieu de ne rien faire en silence', () => {
  const message = (id, source) => it.noCycleMessage(catalog.get(id), source);
  // Forge 1.7.10 et 1.8.9 : pas de mod optionnel de pack ; sans --optifine, pas de cycle OptiFine non plus
  for (const id of ['forge-1.7.10', 'forge-1.8.9']) {
    assert.ok(message(id, null).startsWith(`--cycle : rien à cycler pour le profil ${id} (`), message(id, null));
    assert.ok(message(id, null).includes('pas de mod optionnel de pack'));
    assert.ok(message(id, null).includes('pas de --optifine <jar>'));
  }
  // Fabric : le cycle des shaders existe (Iris est optionnel), mais le profil n'a pas OptiFine
  assert.match(message('fabric-1.21.1', null), /n'a pas OptiFine/);
  assert.doesNotMatch(message('fabric-1.21.1', null), /pas de mod optionnel/);
  // le script affiche ce message quand aucun des deux cycles n'a tourné
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-test.js'), 'utf8');
  const block = source.slice(source.indexOf('if (cycle && !cycled) {'));
  assert.ok(block.startsWith('if (cycle && !cycled) {') && block.slice(0, 300).includes('noCycleMessage(profile, optifineSource)') && block.slice(0, 300).includes('console.log(notice)'));
});

for (const spec of optifineSpecs) {
  const profile = catalog.list().find((p) => p.optifine === spec);
  const other = optifineSpecs.find((s) => s !== spec);

  /** Une installation d'essai : .minecraft avec l'OptiFine du joueur dans libraries, dossier de jeu du profil, première copie faite. */
  async function world() {
    const root = tempDir('atk-it-cycle-');
    const minecraftDir = path.join(root, '.minecraft');
    const gameDir = path.join(root, ...profile.gameDirName.split('/'));
    const libDir = path.join(minecraftDir, 'libraries', 'optifine', 'OptiFine', `${spec.mc}_${spec.edition}`);
    fs.mkdirSync(libDir, { recursive: true });
    const source = path.join(libDir, `OptiFine-${spec.mc}_${spec.edition}.jar`);
    fs.writeFileSync(source, specJar(spec, 'joueur'));
    const run = async (settings) => ({ optifine: await installer.installOptifine(gameDir, minecraftDir, settings, profile) });
    assert.equal((await run({})).optifine.action, 'copied');
    const failures = [];
    const check = async (target, algorithm, expected, label) => {
      if (!fs.existsSync(target)) return failures.push(`absent : ${label}`);
      if (sha(algorithm, fs.readFileSync(target)) !== expected) failures.push(`hash faux : ${label}`);
      return undefined;
    };
    const decor = path.join(minecraftDir, 'libraries', 'optifine', 'OptiFine', `${other.mc}_${other.edition}`);
    return { root, minecraftDir, gameDir, source, run, failures, check, fail: (message) => failures.push(message), decor };
  }
  const cycleOf = (w, run) => it.optifineCycle({ profile, gameDir: w.gameDir, minecraftDir: w.minecraftDir, source: w.source, run, settings: {}, check: w.check, fail: w.fail });

  test(`[${spec.mc}] cycle OptiFine de install-test : copie retirée puis remise, jar du joueur et OptiFine du joueur intacts, OptiFine de l’autre version (même .minecraft) ignoré puis retiré`, async () => {
    const w = await world();
    let decorSeen = 0;
    const summary = await cycleOf(w, async (settings) => {
      if (fs.existsSync(w.decor)) decorSeen++;
      return w.run(settings);
    });
    assert.deepEqual(w.failures, []);
    assert.match(summary, new RegExp(`cycle OptiFine ${spec.mc.replace(/\./g, '\\.')} OK`));
    assert.equal(decorSeen, 4, 'le décor de l’autre version était dans la racine pendant les quatre installations du cycle');
    // état final : une seule copie OptiFine de cette version, l'original et le reste intacts ; ni faux jar du joueur ni décor
    assert.deepEqual(fs.readdirSync(path.join(w.gameDir, 'mods')), [`OptiFine-${spec.mc}_${spec.edition}.jar`]);
    assert.equal(fs.existsSync(w.decor), false, 'décor retiré');
    assert.deepEqual(fs.readFileSync(w.source), specJar(spec, 'joueur'));
    fs.rmSync(w.root, { recursive: true, force: true });
  });

  test(`[${spec.mc}] cycle OptiFine : un launcher qui garde la copie, supprime le jar du joueur ou copie l’OptiFine de l’autre version est pris en faute`, async () => {
    // 1. l'option coupée est ignorée : la copie reste dans mods
    let w = await world();
    await cycleOf(w, async (settings) => w.run({ ...settings, optifine: undefined }));
    assert.ok(w.failures.some((f) => /cycle OptiFine \(coupé\)/.test(f)), w.failures.join('\n'));
    fs.rmSync(w.root, { recursive: true, force: true });
    // 2. le jar du joueur est supprimé au passage
    w = await world();
    await cycleOf(w, async (settings) => {
      const result = await w.run(settings);
      fs.rmSync(path.join(w.gameDir, 'mods', 'mon-mod-perso-of.jar'), { force: true });
      return result;
    });
    assert.ok(w.failures.some((f) => /le jar du joueur a été supprimé/.test(f)), w.failures.join('\n'));
    fs.rmSync(w.root, { recursive: true, force: true });
    // 3. l'OptiFine de l'autre version est copié dans mods en plus du bon
    w = await world();
    await cycleOf(w, async (settings) => {
      const result = await w.run(settings);
      if (settings.optifine !== false) fs.writeFileSync(path.join(w.gameDir, 'mods', specName(other)), 'copie de l’autre version');
      return result;
    });
    assert.ok(w.failures.some((f) => /au lieu du seul OptiFine/.test(f)), w.failures.join('\n'));
    fs.rmSync(w.root, { recursive: true, force: true });
  });
}

test('install-test : OptiFine, --cycle et refus sont documentés dans l’en-tête', () => {
  const head = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-test.js'), 'utf8').split('\n').slice(0, 40).join('\n');
  assert.match(head, /--optifine\s+profils 1\.8\.9 et 1\.7\.10/);
  assert.match(head, /\.lunarclient/);
  assert.match(head, /Avec --optifine : coupe puis réactive OptiFine/);
});
