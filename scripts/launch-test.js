'use strict';
// Test réel du lancement direct, avec un compte HORS LIGNE factice (mode développeur : pseudo seul, jeton « 0 »).
//   node scripts/launch-test.js <dossier d'une installation de test> [--keep]
// Le dossier doit contenir .minecraft et .attack (voir scripts/install-test.js). Installe le runtime Java officiel
// dans <dossier>/runtime, lance le jeu et attend l'écran titre dans le journal. Sans --keep, le jeu est fermé ensuite.
const fs = require('node:fs');
const path = require('node:path');
const { installRuntime } = require('../src/main/runtime');
const { launchGame } = require('../src/main/game');
const { offlineUuid } = require('../src/main/accounts');
const C = require('../src/main/constants');

// Fin du chargement de Forge : l'écran titre s'affiche juste après (le 1er « Sound engine started » arrive avant).
const TITLE_SCREEN = /Forge Mod Loader has successfully loaded (\d+) mods/;
// Forge écrit un faux « Crash Report » (Loading screen debug info) au démarrage : on cherche le vrai marqueur.
const CRASH = /#@!@# Game crashed!|Exception in thread "main"|Could not find or load main class/;

async function main() {
  const root = path.resolve(process.argv[2] || '');
  const keep = process.argv.includes('--keep');
  const minecraftDir = path.join(root, '.minecraft');
  const gameDir = path.join(root, '.attack');
  if (!fs.existsSync(path.join(minecraftDir, 'versions', C.FORGE_VERSION_ID))) throw new Error('Installation de test introuvable');

  console.log('Runtime Java (jre-legacy officiel)…');
  const runtime = await installRuntime({ runtimeDir: path.join(root, 'runtime') });
  console.log(`  ${runtime.version} ${runtime.cached ? '(déjà présent)' : '(téléchargé, SHA-1 vérifiés)'} : ${runtime.java}`);

  const identity = { name: 'AttackDev', uuid: offlineUuid('AttackDev'), accessToken: '0', userType: 'legacy' };
  const started = Date.now();
  const { pid, logFile, child } = await launchGame({
    java: runtime.java, minecraftDir, gameDir, versionId: C.FORGE_VERSION_ID, identity, ramMb: 2048, launcherVersion: 'test',
  });
  console.log(`Jeu lancé (pid ${pid}), journal : ${logFile}`);
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });

  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const log = fs.readFileSync(logFile, 'utf8');
    const loaded = TITLE_SCREEN.exec(log);
    if (loaded) {
      const attack = /FMLFileResourcePack:ATTACK Client/.test(log);
      console.log(`ÉCRAN TITRE atteint en ${((Date.now() - started) / 1000).toFixed(1)} s (Forge : ${loaded[1]} mods chargés, ` +
        `ATTACK Client ${attack ? 'chargé' : 'ABSENT'})`);
      if (!attack) throw new Error('ATTACK Client ne figure pas parmi les mods chargés');
      break;
    }
    if (CRASH.test(log) || exited !== null) throw new Error(`Le jeu s'est arrêté (code ${exited}) : voir ${logFile}`);
    if (Date.now() - started > 180000) throw new Error('Écran titre non atteint en 3 minutes');
  }
  if (!keep) {
    await new Promise((r) => setTimeout(r, 4000));
    process.kill(pid);
    console.log('Jeu fermé.');
  }
}

main().catch((error) => {
  console.error(`ÉCHEC : ${error.message}`);
  process.exit(1);
});
