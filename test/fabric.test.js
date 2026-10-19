'use strict';
// Fabric Loader : adresse du profil, validation stricte du JSON de meta.fabricmc.net (vrais profils 1.21.1 et 26.3),
// plan de téléchargement des bibliothèques et JSON de version écrit pour le launcher officiel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../src/main/catalog');
const fabric = require('../src/main/fabric');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const profiles = {
  '1.21.1': { profile: catalog.get('fabric-1.21.1'), json: () => fixture('fabric-loader-1.21.1.json') },
  '26.3': { profile: catalog.get('fabric-26.3'), json: () => fixture('fabric-loader-26.3.json') },
};

test('adresse du profil de version Fabric Loader épinglé', () => {
  assert.equal(fabric.profileUrl('1.21.1', '0.19.5'), 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.19.5/profile/json');
  assert.equal(fabric.profileUrl('26.3', '0.19.5'), 'https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/profile/json');
  assert.throws(() => fabric.profileUrl('1.21.1/../..', '0.19.5'), /invalide/);
  assert.throws(() => fabric.profileUrl('1.21.1', '0.19.5?x=1'), /invalide/);
  assert.throws(() => fabric.profileUrl('', '0.19.5'), /invalide/);
});

test('profils réels acceptés : id, héritage, classe Knot, bibliothèques et arguments', () => {
  for (const [mc, { profile, json }] of Object.entries(profiles)) {
    const parsed = fabric.parseProfile(json(), profile);
    assert.equal(parsed.id, `fabric-loader-0.19.5-${mc}`);
    assert.equal(parsed.inheritsFrom, mc);
    assert.equal(parsed.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
    assert.deepEqual(parsed.arguments.game, []);
    assert.deepEqual(parsed.arguments.jvm, ['-DFabricMcEmu= net.minecraft.client.main.Main '], 'un seul argument, espaces compris');
    const names = parsed.libraries.map((l) => l.name);
    assert.ok(names.includes('net.fabricmc:fabric-loader:0.19.5'));
    assert.ok(names.includes('net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7'));
    assert.equal(names.includes(`net.fabricmc:intermediary:${mc}`), mc === '1.21.1', 'intermediary existe en 1.21.1 seulement');
    assert.ok(parsed.libraries.every((l) => l.repository === 'https://maven.fabricmc.net/'));
  }
  // accepte aussi un Buffer ou du texte (réponse HTTP brute)
  const raw = Buffer.from(JSON.stringify(profiles['1.21.1'].json()));
  assert.equal(fabric.parseProfile(raw, profiles['1.21.1'].profile).id, 'fabric-loader-0.19.5-1.21.1');
});

test('hashes : présents sur asm / mixin, absents sur fabric-loader et intermediary (plan avec .sha1 à chercher)', () => {
  const { profile, json } = profiles['1.21.1'];
  const plans = fabric.parseProfile(json(), profile).libraries.map(fabric.libraryPlan);
  const byName = Object.fromEntries(plans.map((p) => [p.name, p]));
  const asm = byName['org.ow2.asm:asm:9.10.1'];
  assert.equal(asm.path, 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
  assert.equal(asm.url, 'https://maven.fabricmc.net/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
  assert.match(asm.hashes.sha512, /^[0-9a-f]{128}$/);
  assert.match(asm.hashes.sha1, /^[0-9a-f]{40}$/);
  assert.equal(asm.size, 126151);
  assert.equal(byName['net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7'].path,
    'net/fabricmc/sponge-mixin/0.17.4+mixin.0.8.7/sponge-mixin-0.17.4+mixin.0.8.7.jar');
  for (const name of ['net.fabricmc:fabric-loader:0.19.5', 'net.fabricmc:intermediary:1.21.1']) {
    assert.deepEqual(byName[name].hashes, {}, `${name} : aucun hash dans le profil`);
    assert.equal(byName[name].url, `https://maven.fabricmc.net/${byName[name].path}`);
  }
});

function mutated(mc, change) {
  const json = profiles[mc].json();
  change(json);
  return () => fabric.parseProfile(json, profiles[mc].profile);
}

test('profil Fabric piégé ou inattendu refusé', () => {
  assert.throws(mutated('1.21.1', (j) => { j.id = 'fabric-loader-0.19.4-1.21.1'; }), /id inattendu/);
  assert.throws(mutated('1.21.1', (j) => { j.inheritsFrom = '1.21'; }), /version de Minecraft/);
  assert.throws(mutated('1.21.1', (j) => { j.mainClass = 'evil.Main'; }), /classe principale/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries = []; }), /bibliothèques absentes/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries = j.libraries.filter((l) => !l.name.includes('fabric-loader')); }), /fabric-loader:0.19.5 absent/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].url = 'https://evil.example/maven/'; }), /non officiel/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].url = 'http://maven.fabricmc.net/'; }), /non officiel/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].url = 'https://maven.fabricmc.net.evil.example/'; }), /non officiel/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].name = '../../evil:x:1'; }), /Coordonnée Maven/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].name = 'org.ow2.asm:asm:9.10.1@zip'; }), /extension refusée/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].sha1 = 'pas-un-hash'; }), /sha1 invalide/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].sha512 = 'ab'; }), /sha512 invalide/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0].size = -1; }), /taille invalide/);
  assert.throws(mutated('1.21.1', (j) => { j.libraries[0] = { url: 'https://maven.fabricmc.net/' }; }), /sans nom/);
  assert.throws(() => fabric.parseProfile('null', profiles['1.21.1'].profile), /format inattendu/);
  // une bibliothèque Mojang reste permise (dépôt officiel), pas un dépôt tiers
  assert.doesNotThrow(mutated('1.21.1', (j) => { j.libraries[0].url = 'https://libraries.minecraft.net/'; }));
});

test('arguments Fabric : chaînes seulement, aucune option Java qui charge du code', () => {
  assert.throws(mutated('26.3', (j) => { j.arguments.jvm = ['-javaagent:C:\\evil.jar']; }), /option Java refusée/);
  assert.throws(mutated('26.3', (j) => { j.arguments.jvm = ['-agentlib:jdwp=transport=dt_socket']; }), /option Java refusée/);
  assert.throws(mutated('26.3', (j) => { j.arguments.jvm = ['-cp']; }), /option Java refusée/);
  assert.throws(mutated('26.3', (j) => { j.arguments.jvm = ['-Xbootclasspath/a:x.jar']; }), /option Java refusée/);
  assert.throws(mutated('26.3', (j) => { j.arguments.jvm = [{ rules: [], value: '-Dx=1' }]; }), /argument jvm suspect/);
  assert.throws(mutated('26.3', (j) => { j.arguments.game = 'oops'; }), /arguments game invalides/);
  assert.doesNotThrow(mutated('26.3', (j) => { j.arguments.jvm = ['-Dfabric.debug=true', '-DFabricMcEmu= net.minecraft.client.main.Main ']; }));
  // sans arguments : listes vides
  const bare = mutated('26.3', (j) => { delete j.arguments; });
  assert.deepEqual(bare().arguments, { game: [], jvm: [] });
});

test('JSON de version écrit : bibliothèques en downloads.artifact, champs connus seulement', () => {
  const { profile, json } = profiles['26.3'];
  const raw = json();
  raw.unknownField = { dangereux: true };
  raw.libraries[0].extra = 'ignoré';
  const parsed = fabric.parseProfile(raw, profile);
  const resolved = new Map();
  for (const plan of parsed.libraries.map(fabric.libraryPlan)) {
    resolved.set(plan.name, { path: plan.path, url: plan.url, sha1: 'a'.repeat(40), size: 7 });
  }
  const out = fabric.buildVersionJson(parsed, resolved);
  assert.deepEqual(Object.keys(out), ['id', 'inheritsFrom', 'type', 'releaseTime', 'time', 'mainClass', 'arguments', 'libraries']);
  assert.equal(out.id, 'fabric-loader-0.19.5-26.3');
  assert.equal(out.inheritsFrom, '26.3');
  assert.equal(out.mainClass, fabric.KNOT_CLIENT);
  assert.deepEqual(out.arguments, { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] });
  assert.equal(out.libraries.length, raw.libraries.length);
  assert.deepEqual(out.libraries[0], {
    name: 'org.ow2.asm:asm:9.10.1',
    downloads: { artifact: { path: 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar', url: 'https://maven.fabricmc.net/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar', sha1: 'a'.repeat(40), size: 7 } },
  });
  assert.ok(out.libraries.every((l) => Object.keys(l).join() === 'name,downloads'));
  resolved.delete('net.fabricmc:fabric-loader:0.19.5');
  assert.throws(() => fabric.buildVersionJson(parsed, resolved), /non installée/);
});
