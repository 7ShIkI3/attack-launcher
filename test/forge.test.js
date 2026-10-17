'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeZip, FORGE_PROFILE } = require('./helpers');
const { readEntries, readEntry } = require('../src/main/zip');
const forge = require('../src/main/forge');

const FORGE_NAME = FORGE_PROFILE.install.path;
const UNIVERSAL = Buffer.from('faux jar universal '.repeat(50));

function installer(profile = FORGE_PROFILE, extra = {}) {
  return makeZip({
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n',
    'install_profile.json': JSON.stringify(profile),
    [profile.install.filePath]: UNIVERSAL,
    ...extra,
  });
}

test('lecteur ZIP : entrées compressées et stockées', () => {
  for (const deflate of [true, false]) {
    const zip = makeZip({ 'a.txt': 'bonjour', 'dossier/b.bin': Buffer.alloc(1000, 7) }, { deflate });
    const entries = readEntries(zip);
    assert.deepEqual([...entries.keys()], ['a.txt', 'dossier/b.bin']);
    assert.equal(readEntry(zip, 'a.txt', entries).toString(), 'bonjour');
    assert.deepEqual(readEntry(zip, 'dossier/b.bin', entries), Buffer.alloc(1000, 7));
    assert.equal(readEntry(zip, 'absent', entries), null);
  }
  assert.throws(() => readEntries(Buffer.from('pas un zip')), /ZIP invalide/);
});

test('extraction de install_profile.json et du jar universal', () => {
  const { install, versionInfo, universal } = forge.readInstallProfile(installer());
  assert.equal(install.target, '1.8.9-forge1.8.9-11.15.1.2318-1.8.9');
  assert.equal(versionInfo.mainClass, 'net.minecraft.launchwrapper.Launch');
  assert.equal(versionInfo.inheritsFrom, '1.8.9');
  assert.deepEqual(universal, UNIVERSAL);
});

test('installateur incohérent ou piégé refusé', () => {
  assert.throws(() => forge.readInstallProfile(makeZip({ 'x.txt': 'x' })), /absent/);
  const badId = structuredClone(FORGE_PROFILE);
  badId.versionInfo.id = 'autre';
  assert.throws(() => forge.readInstallProfile(installer(badId)), /incohérent/);
  const traversal = structuredClone(FORGE_PROFILE);
  traversal.install.filePath = '../../evil.jar';
  assert.throws(() => forge.readInstallProfile(installer(traversal)), /suspect/);
  const noJar = makeZip({ 'install_profile.json': JSON.stringify(FORGE_PROFILE) });
  assert.throws(() => forge.readInstallProfile(noJar), /absent de l'installateur/);
});

test('bibliothèques client : clientreq:false (jline) exclue', () => {
  const names = forge.clientLibraries(FORGE_PROFILE.versionInfo).map((l) => l.name);
  assert.ok(!names.includes('jline:jline:2.13'));
  assert.equal(names.length, 4);
});

test('plan de téléchargement : dépôts officiels et checksums', () => {
  const [forgeLib, launchwrapper, , scala, continuations] = FORGE_PROFILE.versionInfo.libraries;
  assert.deepEqual(forge.libraryPlan(forgeLib, FORGE_NAME), {
    name: FORGE_NAME,
    path: 'net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar',
    url: '',
    sha1s: [],
    forge: true,
  });
  assert.equal(forge.libraryPlan(launchwrapper, FORGE_NAME).url,
    'https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar');
  const scalaPlan = forge.libraryPlan(scala, FORGE_NAME);
  assert.equal(scalaPlan.url, 'https://maven.minecraftforge.net/org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar');
  assert.equal(scalaPlan.sha1s.length, 2);
  // ancienne adresse http://files.minecraftforge.net/maven/ -> Maven Forge en HTTPS
  assert.ok(forge.libraryPlan(continuations, FORGE_NAME).url.startsWith('https://maven.minecraftforge.net/'));
  assert.throws(() => forge.libraryPlan({ name: 'a:b:1', url: 'https://evil.example/' }, FORGE_NAME), /non officiel/);
});

test('JSON de version Forge : bibliothèques au format downloads.artifact', () => {
  const resolved = new Map();
  for (const lib of forge.clientLibraries(FORGE_PROFILE.versionInfo)) {
    const plan = forge.libraryPlan(lib, FORGE_NAME);
    resolved.set(lib.name, { path: plan.path, url: plan.url, sha1: 'f'.repeat(40), size: 42 });
  }
  const json = forge.buildVersionJson(FORGE_PROFILE.versionInfo, resolved);
  assert.equal(json.id, FORGE_PROFILE.versionInfo.id);
  assert.equal(json.inheritsFrom, '1.8.9');
  assert.equal(json.libraries.length, 4);
  assert.deepEqual(json.libraries[0], {
    name: FORGE_NAME,
    downloads: { artifact: { path: 'net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar', url: '', sha1: 'f'.repeat(40), size: 42 } },
  });
  assert.ok(json.libraries.every((l) => !('clientreq' in l) && !('checksums' in l)));
  resolved.delete('net.minecraft:launchwrapper:1.12');
  assert.throws(() => forge.buildVersionJson(FORGE_PROFILE.versionInfo, resolved), /non installée/);
});
