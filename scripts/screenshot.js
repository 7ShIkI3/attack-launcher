'use strict';
// Ouvre l'app Electron dans des dossiers isolés et enregistre une capture de chaque page.
//   node scripts/screenshot.js <dossier-captures> [dossier-.minecraft] [dossier-de-jeu]
// Sans dossiers d'installation, l'app montre l'état « à installer ». Rien n'est écrit dans le vrai .minecraft.
// ATTACK_SCREENSHOT_INSTALL=1 clique d'abord sur INSTALLER (installation réelle dans les dossiers donnés),
// ATTACK_DEV=1 active le mode développeur (jar local), ATTACK_LANG=en passe l'interface en anglais,
// ATTACK_OFFLINE=<pseudo> ajoute un compte hors ligne actif et ATTACK_SCREENSHOT_PLAY=1 clique sur JOUER,
// ATTACK_PROFILE=<id> choisit le profil affiché (forge-1.8.9 par défaut, fabric-1.21.1, fabric-26.3),
// ATTACK_SETTINGS='{"replayMod":true}' ajoute ces réglages à plat au profil affiché (essai d'un état « à appliquer »),
// ATTACK_SCREENSHOT_SIZE=940x600 prend les captures à la taille minimale de la fenêtre.
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
const result = spawnSync(electron, ['.'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  timeout: 360000,
  env: {
    ...process.env,
    ATTACK_USER_DATA: userData,
    ATTACK_MINECRAFT_DIR: minecraftDir || path.join(empty, '.minecraft'),
    ATTACK_SCREENSHOT_DIR: outDir,
  },
});
const shots = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png')) : [];
console.log(`Electron terminé (code ${result.status}) ; captures : ${shots.join(', ') || 'aucune'}`);
process.exit(result.status === 0 && shots.length >= 4 ? 0 : 1);
