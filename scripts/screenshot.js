'use strict';
// Ouvre l'app Electron dans des dossiers isolés et enregistre une capture de chaque page.
//   node scripts/screenshot.js <dossier-captures> [dossier-.minecraft] [dossier-de-jeu]
// Sans dossiers d'installation, l'app montre l'état « à installer ». Rien n'est écrit dans le vrai .minecraft.
// ATTACK_SCREENSHOT_INSTALL=1 clique d'abord sur INSTALLER (installation réelle dans les dossiers donnés),
// ATTACK_DEV=1 active le mode développeur (jar local), ATTACK_LANG=en passe l'interface en anglais,
// ATTACK_OFFLINE=<pseudo> ajoute un compte hors ligne actif et ATTACK_SCREENSHOT_PLAY=1 clique sur JOUER,
// ATTACK_PROFILE=<id> choisit le profil affiché (forge-1.8.9 par défaut, fabric-1.21.1, fabric-26.3, forge-1.7.10),
// ATTACK_SETTINGS='{"replayMod":true}' ajoute ces réglages à plat au profil affiché (essai d'un état « à appliquer »),
// ATTACK_SCREENSHOT_SIZE=940x600 prend les captures à la taille minimale de la fenêtre,
// ATTACK_SCREENSHOT_ERROR=<code> ajoute home-error.png (l'alerte de l'accueil pour ce code, par ex. LAUNCHER_NOT_FOUND),
// ATTACK_SCREENSHOT_OPTIFINE=waiting|refused|imported ajoute optifine-<état>.png et optifine-<état>-mods.png : l'assistant OptiFine
// avec un faux jar dans un dossier Téléchargements TEMPORAIRE (ATTACK_DOWNLOADS_DIR) ; optifine.net n'est pas ouvert (ATTACK_NO_BROWSER).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const electron = require('electron');

const [outDir, minecraftDir, gameDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!outDir) {
  console.error('Usage : node scripts/screenshot.js <dossier-captures> [dossier-.minecraft] [dossier-de-jeu]');
  process.exit(1);
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'attack-ui-'));
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'attack-empty-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  ramMb: 3072,
  gameDir: gameDir || path.join(empty, '.attack'),
  lang: process.env.ATTACK_LANG || 'fr',
  profileId: process.env.ATTACK_PROFILE || 'forge-1.8.9',
  devMode: Boolean(process.env.ATTACK_DEV),
  ...JSON.parse(process.env.ATTACK_SETTINGS || '{}'),
}));
// ATTACK_OFFLINE=<pseudo> : compte hors ligne factice actif (mode développeur), pour tester JOUER sans Microsoft
if (process.env.ATTACK_OFFLINE) {
  const { offlineUuid } = require('../src/main/accounts');
  const id = offlineUuid(process.env.ATTACK_OFFLINE);
  // ATTACK_SKIN=<png> : skin de ce compte (vue 3D) ; ATTACK_ACCOUNT_TYPE=msa : compte Microsoft factice (boutons du skin)
  const skin = process.env.ATTACK_SKIN ? `data:image/png;base64,${fs.readFileSync(process.env.ATTACK_SKIN).toString('base64')}` : undefined;
  const type = process.env.ATTACK_ACCOUNT_TYPE === 'msa' ? 'msa' : 'offline';
  fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify({
    version: 1, active: id, accounts: [{ id, name: process.env.ATTACK_OFFLINE, type, skin, skinVariant: 'classic' }],
  }));
}
// assistant OptiFine : faux jars (valide pour « imported », sans TweakClass pour « refused »), copiés dans le faux dossier Téléchargements
// par l'app APRÈS le départ de la surveillance (un fichier déjà présent serait seulement proposé, jamais importé)
const optifineMode = process.env.ATTACK_SCREENSHOT_OPTIFINE || '';
const optifineEnv = {};
if (optifineMode) {
  if (!['waiting', 'refused', 'imported'].includes(optifineMode)) {
    console.error('ATTACK_SCREENSHOT_OPTIFINE : waiting, refused ou imported');
    process.exit(1);
  }
  const { makeZip } = require('../test/helpers');
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'attack-downloads-'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'attack-stage-'));
  const tweak = optifineMode === 'imported' ? 'optifine.OptiFineForgeTweaker' : 'autre.Tweaker';
  const jar = path.join(stage, 'OptiFine_1.8.9_HD_U_M5.jar');
  fs.writeFileSync(jar, makeZip({
    'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\nTweakClass: ${tweak}\r\n\r\n`,
    'optifine/OptiFineForgeTweaker.class': 'classe factice',
  }));
  Object.assign(optifineEnv, {
    ATTACK_DOWNLOADS_DIR: downloads, ATTACK_NO_BROWSER: '1', ATTACK_SCREENSHOT_OPTIFINE: optifineMode, ATTACK_SCREENSHOT_OPTIFINE_JAR: jar,
  });
}
const result = spawnSync(electron, ['.'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  timeout: 360000,
  env: {
    ...process.env,
    ATTACK_USER_DATA: userData,
    ATTACK_MINECRAFT_DIR: minecraftDir || path.join(empty, '.minecraft'),
    ATTACK_SCREENSHOT_DIR: outDir,
    ...optifineEnv,
  },
});
const shots = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png')) : [];
console.log(`Electron terminé (code ${result.status}) ; captures : ${shots.join(', ') || 'aucune'}`);
process.exit(result.status === 0 && shots.length >= 4 ? 0 : 1);
