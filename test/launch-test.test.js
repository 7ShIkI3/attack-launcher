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
