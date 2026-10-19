'use strict';
// Test réel du lancement direct, avec un compte HORS LIGNE factice (mode développeur : pseudo seul, jeton « 0 »).
//   node scripts/launch-test.js <dossier d'une installation de test> [--profile <id>] [--keep]
// Le dossier doit contenir .minecraft et le dossier de jeu du profil (voir scripts/install-test.js). Installe le
// runtime Java officiel du profil (Java 8, 21 ou 25) dans <dossier>/runtime, lance le jeu et attend l'écran titre dans
// le journal. Sans --keep, le jeu est fermé ensuite.
const fs = require('node:fs');
const path = require('node:path');
const { installRuntime } = require('../src/main/runtime');
const { launchGame, javaComponent } = require('../src/main/game');
const { offlineUuid } = require('../src/main/accounts');
const catalog = require('../src/main/catalog');
const { gameDirFor } = require('./install-test');

// Forge : fin du chargement de Forge (le 1er « Sound engine started » arrive avant l'écran titre).
const FORGE_TITLE = /Forge Mod Loader has successfully loaded (\d+) mods/;
// Fabric : liste des mods chargés par Fabric Loader, puis démarrage du moteur sonore (l'écran titre suit).
// (le journal du jeu est au format XML de Mojang : le texte du message est dans un bloc CDATA)
const FABRIC_LOADED = /Loading (\d+) mods?:/;
const FABRIC_READY = /Sound engine started/;
const FABRIC_ATTACK_LISTED = /^\s*-\s+attack\s+\S+/m;
// Forge écrit un faux « Crash Report » (Loading screen debug info) au démarrage : on cherche le vrai marqueur.
const CRASH = /#@!@# Game crashed!|Exception in thread "main"|Could not find or load main class|Incompatible mod set|Mod resolution failed/;

/** Analyse le journal du jeu : { ready, mods, attack } ; ready = écran titre atteint. */
function readLog(log, profile) {
  if (profile.loader.type === 'forge') {
    const loaded = FORGE_TITLE.exec(log);
    return { ready: Boolean(loaded), mods: loaded ? Number(loaded[1]) : null, attack: /FMLFileResourcePack:ATTACK Client/.test(log), loader: 'Forge' };
  }
  const loaded = FABRIC_LOADED.exec(log);
  return {
    ready: Boolean(loaded) && FABRIC_READY.test(log),
    mods: loaded ? Number(loaded[1]) : null,
    attack: loaded ? FABRIC_ATTACK_LISTED.test(log.slice(loaded.index)) : false,
    loader: 'Fabric',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const profile = catalog.get(option('--profile') || catalog.DEFAULT_PROFILE_ID);
  const root = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--profile') || '');
  const keep = args.includes('--keep');
  const minecraftDir = path.join(root, '.minecraft');
  const gameDir = gameDirFor(root, profile);
  const versionId = profile.loader.versionId;
  if (!fs.existsSync(path.join(minecraftDir, 'versions', versionId))) throw new Error('Installation de test introuvable');

  const component = await javaComponent(minecraftDir, versionId);
  console.log(`Profil ${profile.id} : runtime Java ${component} officiel…`);
  const runtime = await installRuntime({ runtimeDir: path.join(root, 'runtime'), component });
  console.log(`  ${runtime.version} ${runtime.cached ? '(déjà présent)' : '(téléchargé, SHA-1 vérifiés)'} : ${runtime.java}`);

  const identity = { name: 'AttackDev', uuid: offlineUuid('AttackDev'), accessToken: '0', userType: 'legacy' };
  const started = Date.now();
  const { pid, logFile, child } = await launchGame({
    java: runtime.java, minecraftDir, gameDir, versionId, identity, ramMb: 2048, launcherVersion: 'test',
  });
  console.log(`Jeu lancé (pid ${pid}), journal : ${logFile}`);
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });

  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const log = fs.readFileSync(logFile, 'utf8');
    const state = readLog(log, profile);
    if (state.ready) {
      console.log(`ÉCRAN TITRE atteint en ${((Date.now() - started) / 1000).toFixed(1)} s (${state.loader} : ${state.mods} mods chargés, ` +
        `ATTACK ${state.attack ? 'chargé' : 'ABSENT'})`);
      if (!state.attack) throw new Error('ATTACK ne figure pas parmi les mods chargés');
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

if (require.main === module) {
  main().catch((error) => {
    console.error(`ÉCHEC : ${error.message}`);
    process.exit(1);
  });
}

module.exports = { readLog };
