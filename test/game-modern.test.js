'use strict';
// Lancement direct des profils Fabric : JSON de version au format moderne (arguments avec règles), fusion Fabric +
// Minecraft, ligne de commande Java. Fixtures : vrais JSON Mojang et Fabric de 1.21.1 et 26.3, réduits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../src/main/game');
const mojang = require('../src/main/mojang');
const catalog = require('../src/main/catalog');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const FILES = {
  '1.21.1': 'mc-1.21.1.json',
  '26.3': 'mc-26.3.json',
  'fabric-loader-0.19.5-1.21.1': 'fabric-loader-1.21.1.json',
  'fabric-loader-0.19.5-26.3': 'fabric-loader-26.3.json',
};
const read = async (_dir, id) => {
  if (!FILES[id]) throw new Error(`version inconnue : ${id}`);
  return fixture(FILES[id]);
};
const WIN64 = { name: 'windows', arch: '64', archName: 'x86_64' };
const MC = path.resolve('mc-test');
const GAME_DIR = 'C:\\Users\\Jean Dupont\\AppData\\Roaming\\.attack\\profiles\\fabric-1.21.1';
const NATIVES = 'C:\\mc\\versions\\fabric\\natives-attack';
const TOKEN = 'SECRET-TOKEN-0123456789';
const IDENTITY = { name: 'Raphou', uuid: '0123456789abcdef0123456789abcdef', accessToken: TOKEN, userType: 'msa' };

async function command(mc, { platform = 'win32', identity = IDENTITY, version: versionOverride } = {}) {
  const id = `fabric-loader-0.19.5-${mc}`;
  const version = versionOverride || await game.resolveVersion(MC, id, read);
  const { classpath } = game.libraryPlan(version, MC, mojang.currentEnv(platform, 'x64'));
  return {
    version,
    classpath,
    cmd: game.buildCommand({
      java: 'C:\\rt\\bin\\javaw.exe', version, minecraftDir: MC, gameDir: GAME_DIR, nativesDir: NATIVES, classpath,
      identity, ramMb: 3072, launcherVersion: '0.5.0', platform,
    }),
  };
}

const count = (args, predicate) => args.filter(predicate).length;

test('fusion Fabric + Minecraft : arguments du parent avant ceux de l’enfant, Java et ressources hérités', async () => {
  for (const [mc, component, major, assets] of [['1.21.1', 'java-runtime-delta', 21, '17'], ['26.3', 'java-runtime-epsilon', 25, '34']]) {
    const version = await game.resolveVersion(MC, `fabric-loader-0.19.5-${mc}`, read);
    assert.equal(version.id, `fabric-loader-0.19.5-${mc}`);
    assert.equal(version.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
    assert.equal(version.minecraftArguments, undefined);
    assert.equal(version.jar, mc, 'le jar du jeu est celui de Minecraft');
    assert.equal(version.assets, assets);
    assert.equal(version.javaComponent, component);
    assert.equal(version.javaMajor, major);
    assert.equal(await game.javaComponent(MC, `fabric-loader-0.19.5-${mc}`, read), component);
    const jvm = version.arguments.jvm;
    assert.ok(jvm.indexOf('-cp') >= 0, 'les arguments Java de Minecraft sont là');
    assert.equal(jvm.at(-1), '-DFabricMcEmu= net.minecraft.client.main.Main ', 'celui de Fabric vient en dernier');
    assert.ok(jvm.indexOf('-cp') < jvm.length - 1);
    assert.equal(version.arguments.game[0], '--username');
    assert.equal(version.libraries[0].name, 'org.ow2.asm:asm:9.10.1', 'bibliothèques de Fabric d’abord');
  }
  // le profil Forge historique reste au format ancien
  const legacy = await game.resolveVersion(MC, '1.8.9', async () => ({ id: '1.8.9', mainClass: 'x', minecraftArguments: '--username a', libraries: [] }));
  assert.equal(legacy.arguments, null);
  assert.equal(legacy.javaComponent, 'jre-legacy');
});

test('classpath Fabric : bibliothèques Fabric puis Minecraft, jar du jeu en dernier, natives LWJGL de Windows seules', async () => {
  const version = await game.resolveVersion(MC, 'fabric-loader-0.19.5-1.21.1', read);
  const { classpath, natives } = game.libraryPlan(version, MC, WIN64);
  const rel = classpath.map((p) => path.relative(MC, p).split(path.sep).join('/'));
  assert.equal(rel[0], 'libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
  assert.ok(rel.includes('libraries/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar'));
  assert.ok(rel.includes('libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar'));
  assert.ok(!rel.some((p) => p.includes('natives-linux') || p.includes('natives-macos')));
  assert.equal(rel.at(-1), 'versions/1.21.1/1.21.1.jar');
  assert.equal(new Set(rel).size, rel.length, 'aucun doublon');
  assert.deepEqual(natives, [], 'les bibliothèques modernes se chargent depuis le classpath, rien à extraire');
});

test('1.21.1 : commande moderne complète, un seul -cp, une seule marque, aucune variable restante', async () => {
  const { classpath, cmd } = await command('1.21.1');
  const a = cmd.args;
  const after = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(cmd.command, 'C:\\rt\\bin\\javaw.exe');
  assert.equal(a[0], '-Xmx3072M');
  assert.ok(a.includes('-XX:+UseG1GC'));
  assert.equal(count(a, (x) => x === '-cp'), 1);
  assert.equal(after('-cp'), classpath.join(path.delimiter));
  assert.equal(count(a, (x) => x.startsWith('-Djava.library.path=')), 1);
  assert.ok(a.includes(`-Djava.library.path=${NATIVES}`));
  assert.ok(a.includes(`-Djna.tmpdir=${NATIVES}`));
  assert.ok(a.includes(`-Dorg.lwjgl.system.SharedLibraryExtractPath=${NATIVES}`));
  assert.ok(a.includes(`-Dio.netty.native.workdir=${NATIVES}`));
  assert.equal(count(a, (x) => x.startsWith('-Dminecraft.launcher.brand=')), 1);
  assert.ok(a.includes('-Dminecraft.launcher.brand=attack-launcher'));
  assert.equal(count(a, (x) => x.startsWith('-Dminecraft.launcher.version=')), 1);
  assert.ok(a.includes('-Dminecraft.launcher.version=0.5.0'));
  assert.equal(count(a, (x) => x === '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump'), 1);
  assert.ok(!a.includes('-XstartOnFirstThread'), 'option macOS exclue sous Windows');
  assert.ok(a.includes(`-Dlog4j.configurationFile=${path.join(MC, 'assets', 'log_configs', 'client-1.12.xml')}`));
  // l'astuce de Fabric reste UN argument, espaces compris, placée avant la classe principale
  const trick = a.indexOf('-DFabricMcEmu= net.minecraft.client.main.Main ');
  assert.ok(trick > a.indexOf('-cp'));
  assert.equal(count(a, (x) => x === '-DFabricMcEmu= net.minecraft.client.main.Main '), 1);
  const main = a.indexOf('net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.ok(main > trick, 'la classe principale Knot est le premier argument qui n’est pas une option Java');
  assert.ok(!a.slice(0, main).includes('--username'));
  // arguments du jeu
  assert.equal(after('--username'), 'Raphou');
  assert.equal(after('--version'), 'fabric-loader-0.19.5-1.21.1');
  assert.equal(after('--gameDir'), GAME_DIR, 'un dossier avec espaces reste un seul argument');
  assert.equal(after('--assetsDir'), path.join(MC, 'assets'));
  assert.equal(after('--assetIndex'), '17');
  assert.equal(after('--uuid'), IDENTITY.uuid);
  assert.equal(after('--accessToken'), TOKEN);
  assert.equal(after('--userType'), 'msa');
  assert.equal(after('--versionType'), 'release');
  assert.equal(after('--clientId'), '');
  assert.equal(after('--xuid'), '');
  for (const gated of ['--demo', '--width', '--height', '--quickPlayPath', '--quickPlaySingleplayer', '--quickPlayMultiplayer', '--quickPlayRealms']) {
    assert.ok(!a.includes(gated), `${gated} dépend d’une option du launcher officiel : exclu`);
  }
  assert.ok(!a.some((x) => /\$\{/.test(x)), 'aucune variable non remplacée');
});

test('26.3 : sous-dossiers de natives, Java 25, options natives, pas de --userType', async () => {
  const { cmd, version } = await command('26.3');
  const a = cmd.args;
  const after = (flag) => a[a.indexOf(flag) + 1];
  assert.ok(a.includes(`-Djava.library.path=${NATIVES}/java`));
  assert.ok(a.includes(`-Djna.tmpdir=${NATIVES}/jna`));
  assert.ok(a.includes(`-Dorg.lwjgl.system.SharedLibraryExtractPath=${NATIVES}/lwjgl`));
  assert.ok(a.includes(`-Dio.netty.native.workdir=${NATIVES}/netty`));
  assert.ok(a.includes('--enable-native-access=ALL-UNNAMED'));
  assert.ok(a.includes('-XX:StackShadowPages=32'));
  assert.equal(a[a.indexOf('--add-exports') + 1], 'java.base/jdk.internal.misc=ALL-UNNAMED');
  assert.equal(count(a, (x) => x === '-cp'), 1);
  assert.equal(count(a, (x) => x.startsWith('-Djava.library.path=')), 1);
  assert.equal(count(a, (x) => x === '-DFabricMcEmu= net.minecraft.client.main.Main '), 1);
  assert.equal(after('--assetIndex'), '34');
  assert.equal(after('--version'), 'fabric-loader-0.19.5-26.3');
  assert.ok(!a.includes('--userType'), '26.3 n’a pas cet argument');
  assert.equal(after('--versionType'), 'release');
  assert.ok(!a.includes('-Xms2G') && !a.includes('-XX:+UseZGC'), 'les options « default-user-jvm » du launcher officiel ne sont pas reprises');
  assert.ok(!a.some((x) => /\$\{/.test(x)));
  assert.deepEqual(game.nativesSubdirs(version), ['java', 'jna', 'lwjgl', 'netty']);
  assert.deepEqual(game.nativesSubdirs(await game.resolveVersion(MC, 'fabric-loader-0.19.5-1.21.1', read)), []);
});

test('règles par plateforme : option macOS seulement sous macOS', async () => {
  const mac = await command('1.21.1', { platform: 'darwin' });
  assert.ok(mac.cmd.args.includes('-XstartOnFirstThread'));
  assert.ok(!mac.cmd.args.includes('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump'));
});

test('jeton masqué dans le texte journalisé, présent dans la vraie commande', async () => {
  const { cmd } = await command('1.21.1');
  assert.ok(cmd.args.includes(TOKEN), 'le jeu reçoit le vrai jeton');
  assert.ok(!cmd.redacted.includes(TOKEN));
  assert.match(cmd.redacted, /--accessToken <masqué>/);
  assert.match(cmd.redacted, /--username Raphou/);
  assert.match(cmd.redacted, /"-DFabricMcEmu= net.minecraft.client.main.Main "/);
  assert.match(cmd.redacted, /--gameDir "C:\\Users\\Jean Dupont/);
});

test('développement des arguments : règles, valeurs en liste, variables sans découpage', () => {
  const env = mojang.currentEnv('win32', 'x64');
  const values = { dir: 'C:\\Mes Documents\\x', n: '1' };
  const out = game.expandArguments([
    '-Da=${dir}',
    { rules: [{ action: 'allow', os: { name: 'windows' } }], value: ['-Db=${n}', '-Dc'] },
    { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-Dmac' },
    { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
    { value: '${inconnue}' },
    null,
  ], values, env);
  assert.deepEqual(out, ['-Da=C:\\Mes Documents\\x', '-Db=1', '-Dc', '${inconnue}']);
  assert.deepEqual(game.expandArguments(undefined, values, env), []);
});

test('variable inconnue dans le JSON de version : lancement refusé plutôt que d’envoyer ${...} au jeu', async () => {
  const version = await game.resolveVersion(MC, 'fabric-loader-0.19.5-1.21.1', read);
  version.arguments.game.push('--nouveau', '${variable_inconnue}');
  const { classpath } = game.libraryPlan(version, MC, WIN64);
  assert.throws(() => game.buildCommand({
    java: 'java', version, minecraftDir: MC, gameDir: GAME_DIR, nativesDir: NATIVES, classpath, identity: IDENTITY, ramMb: 2048, platform: 'win32',
  }), /non résolu/);
});

test('un JSON moderne sans -cp ni marque : ils sont ajoutés une seule fois', async () => {
  const version = await game.resolveVersion(MC, 'fabric-loader-0.19.5-1.21.1', read);
  version.arguments.jvm = ['-Dseul=1'];
  const { classpath } = game.libraryPlan(version, MC, WIN64);
  const cmd = game.buildCommand({
    java: 'java', version, minecraftDir: MC, gameDir: GAME_DIR, nativesDir: NATIVES, classpath, identity: IDENTITY, ramMb: 2048, launcherVersion: '9', platform: 'win32',
  });
  assert.equal(count(cmd.args, (x) => x === '-cp'), 1);
  assert.equal(count(cmd.args, (x) => x.startsWith('-Djava.library.path=')), 1);
  assert.equal(count(cmd.args, (x) => x.startsWith('-Dminecraft.launcher.brand=')), 1);
  assert.ok(cmd.args.includes('-Dminecraft.launcher.version=9'));
});

test('détection d’une partie : la version Fabric de chaque profil est reconnue, pas Minecraft seul', () => {
  const line = (versionId) => `"C:\\rt\\bin\\javaw.exe" -Xmx3072M -cp a.jar net.fabricmc.loader.impl.launch.knot.KnotClient --username Steve --version ${versionId} --gameDir C:\\x`;
  for (const profile of catalog.list()) {
    assert.equal(game.isGameCommandLine(line(profile.loader.versionId)), true, profile.id);
  }
  assert.equal(game.isGameCommandLine(line('1.21.1')), false, 'Minecraft vanilla n’est pas une partie ATTACK');
  assert.equal(game.isGameCommandLine(line('fabric-loader-0.19.5-1.21.1'), 'fabric-loader-0.19.5-26.3'), false);
  assert.equal(game.isGameCommandLine(line('fabric-loader-0.19.5-26.3'), ['x', 'fabric-loader-0.19.5-26.3']), true);
});

test('règles d’OS : version et plage de versions Windows (options « default-user-jvm » de 26.x), inconnue = jamais appliquée', () => {
  const zgc = [{ action: 'allow', os: { name: 'windows', versionRange: { min: '10.0.17134' } } }];
  const g1 = [{ action: 'allow', os: { name: 'windows', versionRange: { max: '10.0.17134' } } }];
  const win11 = mojang.currentEnv('win32', 'x64', '10.0.26200');
  const old = mojang.currentEnv('win32', 'x64', '10.0.10240');
  assert.equal(mojang.rulesAllow(zgc, win11), true);
  assert.equal(mojang.rulesAllow(g1, win11), false, 'jamais ZGC et G1 ensemble');
  assert.equal(mojang.rulesAllow(zgc, old), false);
  assert.equal(mojang.rulesAllow(g1, old), true);
  assert.equal(mojang.rulesAllow(zgc, { ...win11, osVersion: undefined }), false);
  assert.equal(mojang.rulesAllow([{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], win11), true);
  assert.equal(mojang.rulesAllow([{ action: 'allow', os: { name: 'windows', version: '^6\\.' } }], win11), false);
  assert.equal(mojang.rulesAllow([{ action: 'allow', os: { name: 'osx', versionRange: { min: '1' } } }], win11), false);
  assert.equal(mojang.compareVersions('10.0.9', '10.0.17134'), -1);
  assert.equal(mojang.compareVersions('10.0.17134', '10.0.17134'), 0);
  assert.equal(mojang.compareVersions('11', '10.9.9'), 1);
});

test('variable non résolue : le message ne cite que son nom, jamais l’argument (qui pourrait contenir le jeton)', async () => {
  const version = await game.resolveVersion(MC, 'fabric-loader-0.19.5-1.21.1', read);
  version.arguments.game.push('--x=${auth_access_token}${zzz}');
  const { classpath } = game.libraryPlan(version, MC, WIN64);
  assert.throws(() => game.buildCommand({
    java: 'java', version, minecraftDir: MC, gameDir: GAME_DIR, nativesDir: NATIVES, classpath, identity: IDENTITY, ramMb: 2048, platform: 'win32',
  }), (error) => /variable de lancement non résolue : zzz/i.test(error.message) && !error.message.includes(TOKEN));
});

test('Fabric : arguments Java du joueur après ceux par défaut, avant ceux du JSON (-cp une seule fois)', async () => {
  const version = await game.resolveVersion(MC, 'fabric-loader-0.19.5-1.21.1', read);
  const { classpath } = game.libraryPlan(version, MC, mojang.currentEnv('win32', 'x64'));
  const a = game.buildCommand({
    java: 'C:\\rt\\bin\\javaw.exe', version, minecraftDir: MC, gameDir: GAME_DIR, nativesDir: NATIVES, classpath,
    identity: IDENTITY, ramMb: 3072, jvmArgs: '-XX:+UseZGC -XX:+ZGenerational', launcherVersion: '0.5.2', platform: 'win32',
  }).args;
  const extra = a.indexOf('-XX:+UseZGC');
  assert.ok(extra > a.indexOf('-XX:G1HeapRegionSize=32M'));
  assert.equal(a[extra + 1], '-XX:+ZGenerational');
  assert.ok(extra < a.indexOf('-cp'));
  assert.equal(count(a, (x) => x === '-cp'), 1);
});

test('Windows ARM64 (1.21.1 et 26.3) : jars natifs x64 et arm64 au classpath, LWJGL choisit selon l’architecture de Java', async () => {
  // Mojang liste toutes les architectures avec la seule règle « os = windows » ; les DLL sont rangées par architecture
  // dans les jars (windows/x64/..., windows/arm64/...) et LWJGL extrait celle de la JVM (SharedLibraryExtractPath).
  // Le launcher ne doit donc rien extraire lui-même ni filtrer par architecture : même plan sur x64 et sur arm64.
  for (const mc of ['1.21.1', '26.3']) {
    const version = await game.resolveVersion(MC, `fabric-loader-0.19.5-${mc}`, read);
    const x64 = game.libraryPlan(version, MC, mojang.currentEnv('win32', 'x64'));
    const arm64 = game.libraryPlan(version, MC, mojang.currentEnv('win32', 'arm64'));
    assert.deepEqual(arm64.classpath, x64.classpath, `${mc} : même classpath sur ARM64`);
    assert.deepEqual(arm64.natives, [], `${mc} : aucune extraction par le launcher`);
    const jars = arm64.classpath.map((p) => path.basename(p));
    assert.ok(jars.some((j) => /^lwjgl-3[\d.]+-natives-windows\.jar$/.test(j)), `${mc} : natives x64`);
    assert.ok(jars.some((j) => /^lwjgl-3[\d.]+-natives-windows-arm64\.jar$/.test(j)), `${mc} : natives arm64`);
    const extract = JSON.stringify(version.arguments.jvm);
    if (mc === '26.3') assert.match(extract, /SharedLibraryExtractPath=\$\{natives_directory\}/);
  }
});
