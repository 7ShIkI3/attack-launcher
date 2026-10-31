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

/** Faux gh : `release view` rend la release, `release download` écrit le fichier demandé ou rend SHA256SUMS. */
function fakeGh({ jars, digest = true, tag = 'v0.8.0', draft = true, bodies = {}, sums = true, calls = [] }) {
  const assets = [...jars, ...(sums ? ['SHA256SUMS'] : [])].map((name) => ({
    name, size: 10, url: `https://github.com/7ShIkI3/attack-launcher/releases/download/${tag}/${name}`,
    ...(digest && name !== 'SHA256SUMS' ? { digest: `sha256:${sha('sha256', bodies[name] ?? `jar ${name}`)}` } : {}),
  }));
  const run = (args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ tagName: tag, isDraft: draft, isPrerelease: false, assets });
    const pattern = args[args.indexOf('--pattern') + 1];
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
