'use strict';
// scripts/launch-test.js : les parties qui ne lancent pas le jeu (lecture du journal, OptiFine dans mods). Le lancement réel se fait à la main
// (npm run launch-test), avec un dossier d'essai sous %TEMP%.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers');
const catalog = require('../src/main/catalog');
const optifine = require('../src/main/optifine');
const launch = require('../scripts/launch-test');

const LOADED = 'Forge Mod Loader has successfully loaded 4 mods';
const ATTACK = 'FMLFileResourcePack:ATTACK Client';
const tweakerLog = (tweak, jar) => `[main/INFO] [FML]: Loading tweaker ${tweak} from ${jar}`;

test('journal Forge : écran titre, ATTACK chargé ; le tweaker d’OptiFine n’est cherché que si on l’attend (null sinon)', () => {
  const profile = catalog.get('forge-1.7.10');
  const log = `${ATTACK}\n${LOADED}\n`;
  assert.deepEqual(launch.readLog(log, profile), { ready: true, mods: 4, attack: true, tweaker: null, loader: 'Forge' });
  assert.equal(launch.readLog('Forge démarre…', profile).ready, false);
  assert.equal(launch.readLog(`${ATTACK}\n${LOADED}`, profile, { tweak: 'optifine.OptiFineForgeTweaker' }).tweaker, false, 'attendu mais absent');
});

for (const spec of Object.values(optifine.SPECS)) {
  const profile = catalog.list().find((p) => p.optifine === spec);
  const jar = `OptiFine_${spec.mc}_${spec.edition}.jar`;

  test(`[${spec.mc}] critère « Loading tweaker ${spec.tweak} » : la ligne de Forge est reconnue, y compris dans le format XML du journal, et seulement elle`, () => {
    const options = { tweak: spec.tweak };
    const ok = `${ATTACK}\n${tweakerLog(spec.tweak, jar)}\n${LOADED}\n`;
    assert.equal(launch.readLog(ok, profile, options).tweaker, true);
    assert.equal(launch.readLog(`<log4j:Message><![CDATA[Loading tweaker ${spec.tweak} from ${jar}]]></log4j:Message>\n${LOADED}`, profile, options).tweaker, true);
    // pas la même classe : préfixe ou suite collée, point remplacé par un autre caractère, ligne d'un autre tweaker
    for (const bad of [
      `Loading tweaker ${spec.tweak}Extra from x.jar`, `Loading tweaker ${spec.tweak}.Autre from x.jar`, `Loading tweaker ${spec.tweak.replace('.', '_')} from x.jar`,
      'Loading tweaker net.minecraftforge.fml.common.launcher.FMLTweaker from forge.jar', `${spec.tweak} sans la formule`,
    ]) assert.equal(launch.readLog(`${bad}\n${LOADED}`, profile, options).tweaker, false, bad);
  });

  test(`[${spec.mc}] OptiFine dans mods : le jar de la version du profil est détecté avec le TweakClass de la spec ; celui d’une autre version, non`, () => {
    const dir = tempDir('atk-launch-');
    const mods = path.join(dir, 'mods');
    fs.mkdirSync(mods);
    assert.equal(launch.optifineInMods(dir, profile), null, 'mods vide');
    const other = Object.values(optifine.SPECS).find((s) => s !== spec);
    fs.writeFileSync(path.join(mods, `OptiFine_${other.mc}_${other.edition}.jar`), 'x');
    fs.writeFileSync(path.join(mods, 'attack-forge.jar'), 'x');
    assert.equal(launch.optifineInMods(dir, profile), null, 'l’OptiFine d’une autre version ne compte pas');
    fs.writeFileSync(path.join(mods, `OptiFine-${spec.mc}_${spec.edition}.jar`), 'x');
    assert.deepEqual(launch.optifineInMods(dir, profile), { name: `OptiFine-${spec.mc}_${spec.edition}.jar`, tweak: spec.tweak });
    assert.equal(launch.optifineInMods(path.join(dir, 'absent'), profile), null, 'dossier absent');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('profil sans OptiFine (Fabric) : jamais de critère de tweaker, même avec un jar OptiFine dans mods', () => {
  const dir = tempDir('atk-launch-');
  fs.mkdirSync(path.join(dir, 'mods'));
  fs.writeFileSync(path.join(dir, 'mods', 'OptiFine_1.8.9_HD_U_M5.jar'), 'x');
  assert.equal(launch.optifineInMods(dir, catalog.get('fabric-26.3')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('le TweakClass du critère est celui de la spec : le changer dans optifine.js change aussi le test de lancement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'launch-test.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/['"`]optifine\.OptiFineForgeTweaker['"`]/.test(code), false, 'aucune copie en dur du TweakClass dans le code de launch-test.js');
  assert.match(code, /optifine\.forVersion\(profile\.mc\)\.tweak/);
});

test('lancement réel d’OptiFine 1.7.10 HD U E7 (journal relevé le 05/11 par launch-test) : la ligne de Forge est reconnue, les lignes voisines du lanceur ne comptent pas', () => {
  const profile = catalog.get('forge-1.7.10');
  const options = { tweak: optifine.forVersion('1.7.10').tweak };
  const event = (logger, message) => `  <log4j:Event logger="${logger}" timestamp="1793884590810" level="INFO" thread="main">\n    <log4j:Message><![CDATA[${message}]]></log4j:Message>\n  </log4j:Event>\n`;
  // ces deux lignes de LaunchWrapper nomment le tweaker d'OptiFine sans prouver que Forge l'a pris dans mods : elles ne suffisent pas
  const neighbours = event('LaunchWrapper', 'Loading tweak class name optifine.OptiFineForgeTweaker') + event('LaunchWrapper', 'Calling tweak class optifine.OptiFineForgeTweaker');
  const ready = event('FML', LOADED);
  assert.equal(launch.readLog(neighbours + ready, profile, options).tweaker, false);
  // la copie du launcher s'appelle OptiFine-1.7.10_HD_U_E7.jar (trait d'union) : c'est le nom qui figure dans la vraie ligne
  const real = event('FML', 'Loading tweaker optifine.OptiFineForgeTweaker from OptiFine-1.7.10_HD_U_E7.jar');
  assert.equal(launch.readLog(neighbours + real + ready, profile, options).tweaker, true);
});

test('options de la ligne de commande : mémoire de 2048 Mo et runtime officiel par défaut, --ram et --java en plus, les valeurs ne sont pas prises pour le dossier', () => {
  const root = path.resolve('essai');
  assert.deepEqual(launch.parseOptions(['essai']), { root, profileId: null, keep: false, ramMb: 2048, java: null });
  assert.equal(launch.DEFAULT_RAM_MB, 2048);
  const java = path.join(path.resolve('jdk'), 'bin', 'javaw.exe');
  assert.deepEqual(launch.parseOptions(['--ram', '4096', '--java', java, 'essai', '--profile', 'forge-1.7.10', '--keep']),
    { root, profileId: 'forge-1.7.10', keep: true, ramMb: 4096, java });
  // le dossier peut aussi venir après les options, et --java relatif est résolu
  assert.equal(launch.parseOptions(['--java', 'bin/javaw.exe', 'essai']).java, path.resolve('bin/javaw.exe'));
  assert.equal(launch.parseOptions(['--ram', '1024', 'essai']).root, root);
});

test('options de la ligne de commande : --ram invalide, valeur manquante ou option inconnue = erreur claire, jamais une valeur par défaut silencieuse', () => {
  for (const bad of ['0', '-5', 'abc', '2048.5', '', '1e3']) assert.throws(() => launch.parseOptions(['essai', '--ram', bad]), /--ram attend un nombre entier/, bad);
  assert.throws(() => launch.parseOptions(['essai', '--ram']), /--ram demande une valeur/);
  assert.throws(() => launch.parseOptions(['essai', '--java']), /--java demande une valeur/);
  assert.throws(() => launch.parseOptions(['essai', '--java', '--keep']), /--java demande une valeur/);
  assert.throws(() => launch.parseOptions(['essai', '--ramm', '1']), /Option inconnue/);
});

test('version de Java : lue dans la sortie de « java -version » (Java 8 et Java moderne) ; javaw est interrogé par son java.exe voisin quand il existe', () => {
  assert.equal(launch.parseJavaVersion('openjdk version "1.8.0_402"\nOpenJDK Runtime Environment'), '1.8.0_402');
  assert.equal(launch.parseJavaVersion('java version "21.0.2" 2024-01-16 LTS'), '21.0.2');
  assert.equal(launch.parseJavaVersion('rien d’utile'), null);
  assert.equal(launch.parseJavaVersion(undefined), null);

  const dir = tempDir('atk-launch-');
  const calls = [];
  const run = (file, args) => {
    calls.push([file, args]);
    return { stderr: 'openjdk version "1.8.0_402"\n' };
  };
  const javaw = path.join(dir, 'javaw.exe');
  fs.writeFileSync(javaw, 'x');
  assert.equal(launch.javaVersion(javaw, run), '1.8.0_402');
  assert.equal(calls[0][0], javaw, 'pas de java.exe voisin : javaw lui-même');
  fs.writeFileSync(path.join(dir, 'java.exe'), 'x');
  launch.javaVersion(javaw, run);
  assert.equal(calls[1][0], path.join(dir, 'java.exe'));
  assert.deepEqual(calls[1][1], ['-version']);
  assert.equal(launch.javaVersion(path.join(dir, 'java.exe'), () => ({ error: new Error('x') })), null, 'lancement impossible : null, pas d’exception');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launch-test.js : la mémoire du jeu vient de --ram (plus de 2048 en dur dans le lancement) et --java contourne installRuntime', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'launch-test.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/ramMb:\s*2048/.test(code), false);
  assert.match(code, /launchGame\(\{[^}]*\bramMb\b/);
  assert.match(code, /if \(java\) \{[\s\S]*?\} else \{[\s\S]*?installRuntime/);
});
