'use strict';
// Lancement direct : fusion des versions, classpath, natives, ligne de commande Java, masquage du jeton,
// sélection du runtime Java.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, makeZip } = require('./helpers');
const game = require('../src/main/game');
const runtime = require('../src/main/runtime');

const WIN64 = { name: 'windows', arch: '64', archName: 'x86_64' };
const SHA = 'a'.repeat(40);
const art = (p) => ({ artifact: { path: p, sha1: SHA, size: 1, url: 'u' } });

const FORGE = {
  id: '1.8.9-forge1.8.9-11.15.1.2318-1.8.9',
  inheritsFrom: '1.8.9',
  jar: '1.8.9',
  mainClass: 'net.minecraft.launchwrapper.Launch',
  minecraftArguments: '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker',
  libraries: [
    { name: 'net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9', downloads: art('net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar') },
    { name: 'net.sf.jopt-simple:jopt-simple:4.6', downloads: art('net/sf/jopt-simple/jopt-simple/4.6/jopt-simple-4.6.jar') },
  ],
};

const VANILLA = {
  id: '1.8.9',
  mainClass: 'net.minecraft.client.main.Main',
  minecraftArguments: '--username ${auth_player_name}',
  assetIndex: { id: '1.8' },
  javaVersion: { component: 'jre-legacy', majorVersion: 8 },
  logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.7.xml' } } },
  libraries: [
    { name: 'net.sf.jopt-simple:jopt-simple:4.6', downloads: art('net/sf/jopt-simple/jopt-simple/4.6/jopt-simple-4.6.jar') },
    { name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209', rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], downloads: art('org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar') },
    { name: 'org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: art('org/lwjgl/lwjgl/lwjgl/2.9.2-nightly-20140822/lwjgl-2.9.2-nightly-20140822.jar') },
    {
      name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
      natives: { windows: 'natives-windows' },
      extract: { exclude: ['META-INF/'] },
      downloads: {
        ...art('org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209.jar'),
        classifiers: { 'natives-windows': { path: 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar', sha1: SHA, url: 'u' } },
      },
    },
    {
      name: 'tv.twitch:twitch-external-platform:4.5',
      natives: { windows: 'natives-windows-${arch}' },
      rules: [{ action: 'allow', os: { name: 'windows' } }],
      downloads: { classifiers: { 'natives-windows-64': { path: 'tv/twitch/twitch-external-platform/4.5/twitch-external-platform-4.5-natives-windows-64.jar', sha1: SHA, url: 'u' } } },
    },
  ],
};

const read = async (_dir, id) => structuredClone(id === '1.8.9' ? VANILLA : FORGE);
const MC = path.resolve('mc-test');
const IDENTITY = { name: 'Raphou', uuid: '0123456789abcdef0123456789abcdef', accessToken: 'eyJhbGciOiJIUzI1NiJ9.SECRET-TOKEN', userType: 'msa' };

test('fusion Forge + 1.8.9 (inheritsFrom)', async () => {
  const version = await game.resolveVersion(MC, FORGE.id, read);
  assert.equal(version.mainClass, 'net.minecraft.launchwrapper.Launch');
  assert.match(version.minecraftArguments, /FMLTweaker/);
  assert.equal(version.assets, '1.8');
  assert.equal(version.jar, '1.8.9');
  assert.equal(version.javaComponent, 'jre-legacy');
  assert.equal(version.libraries[0].name, FORGE.libraries[0].name, 'bibliothèques de Forge en premier');
});

test('classpath : Forge d’abord, sans doublon, règles appliquées, jar 1.8.9 en dernier ; natives ${arch}', async () => {
  const version = await game.resolveVersion(MC, FORGE.id, read);
  const { classpath, natives } = game.libraryPlan(version, MC, WIN64);
  const rel = classpath.map((p) => path.relative(MC, p).split(path.sep).join('/'));
  assert.deepEqual(rel, [
    'libraries/net/minecraftforge/forge/1.8.9-11.15.1.2318-1.8.9/forge-1.8.9-11.15.1.2318-1.8.9.jar',
    'libraries/net/sf/jopt-simple/jopt-simple/4.6/jopt-simple-4.6.jar',
    'libraries/org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar',
    'libraries/org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209.jar',
    'versions/1.8.9/1.8.9.jar',
  ]);
  assert.deepEqual(natives.map((n) => path.basename(n.file)), [
    'lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar',
    'twitch-external-platform-4.5-natives-windows-64.jar',
  ]);
  assert.deepEqual(natives[0].exclude, ['META-INF/']);
});

test('ligne de commande Java : arguments, classpath, -Xmx, log4j ; jeton masqué dans le texte journalisé', async () => {
  const version = await game.resolveVersion(MC, FORGE.id, read);
  const { classpath } = game.libraryPlan(version, MC, WIN64);
  const gameDir = 'C:\\Users\\x\\AppData\\Roaming\\.attack';
  const cmd = game.buildCommand({
    java: 'C:\\rt\\bin\\javaw.exe', version, minecraftDir: MC, gameDir, nativesDir: 'C:\\natives', classpath,
    identity: IDENTITY, ramMb: 3072, launcherVersion: '0.2.0', platform: 'win32',
  });
  const a = cmd.args;
  const after = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(cmd.command, 'C:\\rt\\bin\\javaw.exe');
  assert.equal(a[0], '-Xmx3072M');
  assert.ok(a.includes('-Djava.library.path=C:\\natives'));
  assert.ok(a.includes(`-Dlog4j.configurationFile=${path.join(MC, 'assets', 'log_configs', 'client-1.7.xml')}`));
  assert.equal(after('-cp'), classpath.join(path.delimiter));
  assert.equal(a[a.indexOf('-cp') + 2], 'net.minecraft.launchwrapper.Launch');
  assert.equal(after('--username'), 'Raphou');
  assert.equal(after('--uuid'), IDENTITY.uuid);
  assert.equal(after('--accessToken'), IDENTITY.accessToken);
  assert.equal(after('--userType'), 'msa');
  assert.equal(after('--gameDir'), gameDir);
  assert.equal(after('--assetsDir'), path.join(MC, 'assets'));
  assert.equal(after('--assetIndex'), '1.8');
  assert.equal(after('--version'), FORGE.id);
  assert.equal(after('--userProperties'), '{}');
  assert.equal(after('--tweakClass'), 'net.minecraftforge.fml.common.launcher.FMLTweaker');
  assert.ok(!a.some((x) => x.includes('${')), 'aucune variable non remplacée');

  assert.ok(!cmd.redacted.includes('SECRET-TOKEN'), 'jeton présent dans le texte journalisé');
  assert.match(cmd.redacted, /--accessToken <masqué>/);
  assert.match(cmd.redacted, /--username Raphou/);
});

test('masquage : le jeton est retiré même s’il apparaît ailleurs', () => {
  const text = game.redact(['java', '--accessToken', 'ABCDEFGH', '-Dx=ABCDEFGH', 'C:\\Program Files\\x'], 'ABCDEFGH');
  assert.equal(text, 'java --accessToken <masqué> -Dx=<masqué> "C:\\Program Files\\x"');
});

test('extraction des natives : fichiers seulement, META-INF exclu, pas de sortie du dossier', async () => {
  const dir = tempDir();
  const jar = path.join(dir, 'natives.jar');
  fs.writeFileSync(jar, makeZip({ 'META-INF/MANIFEST.MF': 'x', 'lwjgl64.dll': 'dll', 'sub/': '', 'sub/OpenAL64.dll': 'al' }));
  const out = path.join(dir, 'natives');
  assert.equal(await game.extractNatives([{ file: jar, exclude: ['META-INF/'] }], out), 2);
  assert.ok(fs.existsSync(path.join(out, 'lwjgl64.dll')));
  assert.ok(fs.existsSync(path.join(out, 'sub', 'OpenAL64.dll')));
  assert.ok(!fs.existsSync(path.join(out, 'META-INF')));
  fs.writeFileSync(jar, makeZip({ '../evil.dll': 'x' }));
  await assert.rejects(game.extractNatives([{ file: jar, exclude: [] }], out), /hors du dossier/);
  fs.rmSync(dir, { recursive: true, force: true });
});

const ALL = {
  'windows-x64': { 'jre-legacy': [{ manifest: { sha1: 'b'.repeat(40), size: 1, url: 'https://piston-meta.mojang.com/m.json' }, version: { name: '8u51' } }] },
  'windows-arm64': { 'jre-legacy': [] },
  'windows-x86': { 'jre-legacy': [{ manifest: { sha1: 'c'.repeat(40), size: 1, url: 'https://piston-meta.mojang.com/x86.json' }, version: { name: '8u51' } }] },
};

test('runtime Java : plateforme, repli ARM vers x64, composant absent', () => {
  assert.equal(runtime.platformKey('win32', 'x64'), 'windows-x64');
  assert.equal(runtime.platformKey('win32', 'ia32'), 'windows-x86');
  assert.equal(runtime.platformKey('win32', 'arm64'), 'windows-arm64');
  assert.deepEqual(runtime.selectRuntime(ALL, 'jre-legacy', 'windows-x64'),
    { key: 'windows-x64', version: '8u51', manifest: ALL['windows-x64']['jre-legacy'][0].manifest });
  assert.equal(runtime.selectRuntime(ALL, 'jre-legacy', 'windows-arm64').key, 'windows-x64');
  assert.equal(runtime.selectRuntime(ALL, 'jre-legacy', 'windows-x86').key, 'windows-x86');
  assert.throws(() => runtime.selectRuntime(ALL, 'java-runtime-delta', 'windows-x64'), /indisponible/);
  assert.equal(runtime.javaExecutable('C:\\rt', 'win32'), path.join('C:\\rt', 'bin', 'javaw.exe'));
});

test('runtime Java : fichiers du manifeste (hash exigé, chemins sûrs)', () => {
  const manifest = {
    files: {
      bin: { type: 'directory' },
      'bin/javaw.exe': { type: 'file', executable: true, downloads: { raw: { sha1: SHA, size: 10, url: 'https://piston-data.mojang.com/v1/objects/x/javaw.exe' } } },
      'lib/link': { type: 'link', target: '../x' },
    },
  };
  assert.deepEqual(runtime.runtimeFiles(manifest), {
    dirs: ['bin'],
    files: [{ path: 'bin/javaw.exe', url: 'https://piston-data.mojang.com/v1/objects/x/javaw.exe', sha1: SHA, size: 10, executable: true }],
  });
  assert.throws(() => runtime.runtimeFiles({ files: { '../evil.exe': { type: 'file', downloads: { raw: { sha1: SHA } } } } }), /suspect/);
  assert.throws(() => runtime.runtimeFiles({ files: { 'bin/x': { type: 'file', downloads: { raw: { sha1: 'court' } } } } }), /Hash/);
});
