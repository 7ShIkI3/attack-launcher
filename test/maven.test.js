'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseCoordinate, mavenPath, mavenUrl, safeJoin } = require('../src/main/maven');

test('chemin Maven simple', () => {
  assert.equal(mavenPath('org.scala-lang:scala-library:2.11.1'), 'org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar');
});

test('chemin Maven de Forge (version avec tirets)', () => {
  assert.equal(
    mavenPath('net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9'),
    'net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar',
  );
});

test('classifier (natives) et extension', () => {
  assert.equal(
    mavenPath('org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209', 'natives-windows'),
    'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar',
  );
  assert.equal(mavenPath('a.b:c:1.0:client@zip'), 'a/b/c/1.0/c-1.0-client.zip');
  assert.deepEqual(parseCoordinate('a.b:c:1.0:client@zip'), { group: 'a.b', artifact: 'c', version: '1.0', classifier: 'client', ext: 'zip' });
});

test('URL Maven avec ou sans barre finale', () => {
  const name = 'net.minecraft:launchwrapper:1.12';
  const expected = 'https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar';
  assert.equal(mavenUrl('https://libraries.minecraft.net/', name), expected);
  assert.equal(mavenUrl('https://libraries.minecraft.net', name), expected);
});

test('coordonnées malveillantes ou invalides refusées', () => {
  assert.throws(() => mavenPath('..:evil:1.0'));
  assert.throws(() => mavenPath('a:b:../../x'));
  assert.throws(() => mavenPath('a:b'));
  assert.throws(() => mavenPath('a:b/c:1.0'));
  assert.throws(() => mavenPath(null));
});

test('safeJoin reste dans la racine', () => {
  const root = path.resolve('racine-test');
  assert.equal(safeJoin(root, 'a/b.jar'), path.join(root, 'a', 'b.jar'));
  assert.throws(() => safeJoin(root, '../dehors.jar'));
  assert.throws(() => safeJoin(root, 'a/../../dehors.jar'));
});
