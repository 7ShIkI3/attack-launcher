'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mojang = require('../src/main/mojang');

const WIN64 = { name: 'windows', arch: '64', archName: 'x86_64' };
const SHA = (c) => c.repeat(40);

const MANIFEST = {
  latest: { release: '1.21', snapshot: '1.21' },
  versions: [
    { id: '1.21', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/x/1.21.json', sha1: SHA('a') },
    { id: '1.8.9', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/d546/1.8.9.json', sha1: 'd546f1707a3f2b7d034eece5ea2e311eda875787' },
  ],
};

const VERSION = {
  id: '1.8.9',
  downloads: { client: { sha1: '3870888a6c3d349d3771a3e9d16c9bf5e076b908', size: 8461484, url: 'https://launcher.mojang.com/v1/objects/3870/client.jar' } },
  logging: { client: { file: { id: 'client-1.7.xml', sha1: SHA('b'), size: 966, url: 'https://launcher.mojang.com/v1/objects/50c9/client-1.7.xml' } } },
  libraries: [
    { name: 'com.mojang:netty:1.8.8', downloads: { artifact: { path: 'com/mojang/netty/1.8.8/netty-1.8.8.jar', sha1: SHA('1'), size: 1, url: 'https://libraries.minecraft.net/com/mojang/netty/1.8.8/netty-1.8.8.jar' } } },
    {
      name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209',
      rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }],
      downloads: { artifact: { path: 'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar', sha1: SHA('2'), size: 2, url: 'u' } },
    },
    {
      name: 'org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822',
      rules: [{ action: 'allow', os: { name: 'osx' } }],
      downloads: { artifact: { path: 'org/lwjgl/lwjgl/lwjgl/2.9.2-nightly-20140822/lwjgl-2.9.2-nightly-20140822.jar', sha1: SHA('3'), size: 3, url: 'u' } },
    },
    {
      name: 'tv.twitch:twitch-external-platform:4.5',
      natives: { windows: 'natives-windows-${arch}' },
      rules: [{ action: 'allow', os: { name: 'windows' } }],
      downloads: {
        classifiers: {
          'natives-windows-32': { path: 'tv/twitch/twitch-external-platform/4.5/twitch-external-platform-4.5-natives-windows-32.jar', sha1: SHA('4'), size: 4, url: 'u32' },
          'natives-windows-64': { path: 'tv/twitch/twitch-external-platform/4.5/twitch-external-platform-4.5-natives-windows-64.jar', sha1: SHA('5'), size: 5, url: 'u64' },
        },
      },
    },
  ],
};

test('trouve 1.8.9 dans le manifeste avec son hash', () => {
  const entry = mojang.findVersion(MANIFEST, '1.8.9');
  assert.equal(entry.sha1, 'd546f1707a3f2b7d034eece5ea2e311eda875787');
  assert.throws(() => mojang.findVersion(MANIFEST, '1.7.10'), /absente/);
  assert.throws(() => mojang.findVersion({ versions: [{ id: '1.8.9', url: 'x' }] }, '1.8.9'), /Hash/);
});

test('règles Mojang (os, architecture, options)', () => {
  assert.equal(mojang.rulesAllow(undefined, WIN64), true);
  assert.equal(mojang.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], WIN64), true);
  assert.equal(mojang.rulesAllow([{ action: 'allow', os: { name: 'osx' } }], WIN64), false);
  assert.equal(mojang.rulesAllow([{ action: 'allow', os: { arch: 'x86' } }], WIN64), false);
  assert.equal(mojang.rulesAllow([{ action: 'allow', os: { arch: 'x86' } }], { ...WIN64, arch: '32', archName: 'x86' }), true);
  assert.equal(mojang.rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], WIN64), false);
});

test('bibliothèques Windows 64 bits : artefacts + natives ${arch}', () => {
  const files = mojang.libraryDownloads(VERSION, WIN64);
  assert.deepEqual(files.map((f) => f.path), [
    'com/mojang/netty/1.8.8/netty-1.8.8.jar',
    'org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar',
    'tv/twitch/twitch-external-platform/4.5/twitch-external-platform-4.5-natives-windows-64.jar',
  ]);
  assert.equal(files[2].url, 'u64');
});

test('chemin d’artefact incohérent refusé', () => {
  const evil = { libraries: [{ name: 'a:b:1', downloads: { artifact: { path: '../../evil.jar', sha1: SHA('c'), url: 'u' } } }] };
  assert.throws(() => mojang.libraryDownloads(evil, WIN64), /Chemin inattendu/);
});

test('jar client et configuration log4j', () => {
  assert.deepEqual(mojang.clientDownload(VERSION), {
    path: 'versions/1.8.9/1.8.9.jar', url: VERSION.downloads.client.url, sha1: VERSION.downloads.client.sha1, size: 8461484,
  });
  assert.equal(mojang.loggingDownload(VERSION).path, 'assets/log_configs/client-1.7.xml');
  assert.equal(mojang.loggingDownload({}), null);
});

test('assets : chemins objets/xx/hash, URL officielle, sans doublon', () => {
  const index = {
    objects: {
      'minecraft/sounds/a.ogg': { hash: 'ABCDEF0123456789abcdef0123456789abcdef01', size: 10 },
      'minecraft/sounds/b.ogg': { hash: 'abcdef0123456789abcdef0123456789abcdef01', size: 10 },
      'minecraft/lang/fr_FR.lang': { hash: '0123456789abcdef0123456789abcdef01234567', size: 5 },
    },
  };
  const objects = mojang.assetDownloads(index);
  assert.equal(objects.length, 2);
  assert.deepEqual(objects[0], {
    path: 'objects/ab/abcdef0123456789abcdef0123456789abcdef01',
    url: 'https://resources.download.minecraft.net/ab/abcdef0123456789abcdef0123456789abcdef01',
    sha1: 'abcdef0123456789abcdef0123456789abcdef01',
    size: 10,
  });
  assert.throws(() => mojang.assetDownloads({ objects: { x: { hash: '../../etc', size: 1 } } }), /invalide/);
});
