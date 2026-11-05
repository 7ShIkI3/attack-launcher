'use strict';
// Test réel du lancement direct, avec un compte HORS LIGNE factice (mode développeur : pseudo seul, jeton « 0 »).
//   node scripts/launch-test.js <dossier d'une installation de test> [--profile <id>] [--keep] [--ram <Mo>] [--java <chemin javaw>]
// Le dossier doit contenir .minecraft et le dossier de jeu du profil (voir scripts/install-test.js). Installe le
// runtime Java officiel du profil (Java 8, 21 ou 25) dans <dossier>/runtime, lance le jeu et attend l'écran titre dans
// le journal. Sans --keep, le jeu est fermé ensuite.
// --ram   mémoire du jeu en Mo (2048 par défaut)
// --java  utilise ce javaw (ou java) au lieu d'installer le runtime officiel : rien n'est téléchargé, la version de Java est journalisée
// Quand un OptiFine de la version du profil est dans mods (profils Forge 1.8.9 et 1.7.10), le journal doit aussi montrer que Forge a
// chargé son tweaker : « Loading tweaker <TweakClass de la spec> » (TweakClass lu dans la spec d'optifine.js, optifine.OptiFineForgeTweaker
// en 1.8.9 comme en 1.7.10). Sans cette ligne, OptiFine est dans mods mais n'est pas chargé : échec.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installRuntime } = require('../src/main/runtime');
const { launchGame, javaComponent } = require('../src/main/game');
const { offlineUuid } = require('../src/main/accounts');
const catalog = require('../src/main/catalog');
const optifine = require('../src/main/optifine');
const { gameDirFor } = require('./install-test');

const DEFAULT_RAM_MB = 2048;

// Forge : fin du chargement de Forge (le 1er « Sound engine started » arrive avant l'écran titre).
const FORGE_TITLE = /Forge Mod Loader has successfully loaded (\d+) mods/;
// Fabric : liste des mods chargés par Fabric Loader, puis démarrage du moteur sonore (l'écran titre suit).
// (le journal du jeu est au format XML de Mojang : le texte du message est dans un bloc CDATA)
const FABRIC_LOADED = /Loading (\d+) mods?:/;
const FABRIC_READY = /Sound engine started/;
const FABRIC_ATTACK_LISTED = /^\s*-\s+attack\s+\S+/m;
// Forge écrit un faux « Crash Report » (Loading screen debug info) au démarrage : on cherche le vrai marqueur.
const CRASH = /#@!@# Game crashed!|Exception in thread "main"|Could not find or load main class|Incompatible mod set|Incompatible mods found|Mod resolution failed|Mod discovery failed/;

/** Ligne que Forge écrit quand il charge le tweaker d'un jar de mods (« Loading tweaker optifine.OptiFineForgeTweaker from OptiFine_…jar »). */
function tweakerLine(tweak) {
  return new RegExp(`Loading tweaker ${String(tweak).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.])`);
}

/**
 * OptiFine posé dans le dossier mods d'un profil : { name, tweak } (nom du jar, TweakClass attendu d'après la spec de sa version), ou null
 * (profil sans OptiFine, ou aucun jar OptiFine de cette version dans mods).
 */
function optifineInMods(gameDir, profile) {
  if (!catalog.hasOptifine(profile)) return null;
  let names = [];
  try {
    names = fs.readdirSync(path.join(gameDir, 'mods'));
  } catch {
    return null;
  }
  const name = names.find((n) => /\.jar$/i.test(n) && optifine.nameMatches(n, profile.mc));
  return name ? { name, tweak: optifine.forVersion(profile.mc).tweak } : null;
}

/**
 * Analyse le journal du jeu : { ready, mods, attack, tweaker } ; ready = écran titre atteint ; tweaker = le tweaker d'OptiFine a été chargé
 * (null quand `options.tweak` n'est pas donné : aucun OptiFine attendu).
 */
function readLog(log, profile, options = {}) {
  if (profile.loader.type === 'forge') {
    const loaded = FORGE_TITLE.exec(log);
    return {
      ready: Boolean(loaded),
      mods: loaded ? Number(loaded[1]) : null,
      attack: /FMLFileResourcePack:ATTACK Client/.test(log),
      tweaker: options.tweak ? tweakerLine(options.tweak).test(log) : null,
      loader: 'Forge',
    };
  }
  const loaded = FABRIC_LOADED.exec(log);
  return {
    ready: Boolean(loaded) && FABRIC_READY.test(log),
    mods: loaded ? Number(loaded[1]) : null,
    attack: loaded ? FABRIC_ATTACK_LISTED.test(log.slice(loaded.index)) : false,
    loader: 'Fabric',
  };
}

/**
 * Options de la ligne de commande : { root, profileId, keep, ramMb, java }. `ramMb` vaut 2048 sans --ram ; `java` (chemin absolu) est null sans
 * --java. Une valeur manquante ou invalide (--ram 0, --ram abc, --java sans chemin) est une erreur, jamais une valeur par défaut silencieuse.
 */
function parseOptions(args) {
  const withValue = new Set(['--profile', '--ram', '--java']);
  const flags = new Set(['--keep']);
  const values = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (withValue.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} demande une valeur`);
      values[arg] = value;
      i++;
    } else if (flags.has(arg)) {
      values[arg] = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Option inconnue : ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  let ramMb = DEFAULT_RAM_MB;
  if (values['--ram'] !== undefined) {
    if (!/^[1-9]\d*$/.test(values['--ram'])) throw new Error(`--ram attend un nombre entier de Mo (reçu « ${values['--ram']} »)`);
    ramMb = Number(values['--ram']);
  }
  return {
    root: path.resolve(positional[0] || ''),
    profileId: values['--profile'] || null,
    keep: values['--keep'] === true,
    ramMb,
    java: values['--java'] ? path.resolve(values['--java']) : null,
  };
}

/** Version de Java d'après la sortie de `java -version` (« openjdk version "1.8.0_402" », « java version "21.0.2" »), ou null. */
function parseJavaVersion(output) {
  const match = /version "([^"]+)"/.exec(String(output));
  return match ? match[1] : null;
}

/** Version de Java du binaire donné. javaw n'écrit rien dans une console : son java.exe voisin est interrogé à sa place s'il existe. */
function javaVersion(javaPath, run = spawnSync) {
  const sibling = path.join(path.dirname(javaPath), 'java.exe');
  const probe = /javaw(\.exe)?$/i.test(javaPath) && fs.existsSync(sibling) ? sibling : javaPath;
  const result = run(probe, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return parseJavaVersion(`${result.stderr || ''}\n${result.stdout || ''}`);
}

async function main() {
  const { root, profileId, keep, ramMb, java } = parseOptions(process.argv.slice(2));
  const profile = catalog.get(profileId || catalog.DEFAULT_PROFILE_ID);
  const minecraftDir = path.join(root, '.minecraft');
  const gameDir = gameDirFor(root, profile);
  const versionId = profile.loader.versionId;
  if (!fs.existsSync(path.join(minecraftDir, 'versions', versionId))) throw new Error('Installation de test introuvable');
  const withOptifine = optifineInMods(gameDir, profile);
  if (withOptifine) console.log(`OptiFine dans mods (${withOptifine.name}) : le journal doit montrer « Loading tweaker ${withOptifine.tweak} »`);

  let runtime;
  if (java) {
    if (!fs.existsSync(java)) throw new Error(`--java : fichier introuvable (${java})`);
    const version = javaVersion(java);
    console.log(`Profil ${profile.id} : Java imposé par --java, installation du runtime ignorée : ${java}`);
    console.log(`  version de Java : ${version || 'illisible'} ; mémoire du jeu : ${ramMb} Mo`);
    runtime = { java };
  } else {
    const component = await javaComponent(minecraftDir, versionId);
    console.log(`Profil ${profile.id} : runtime Java ${component} officiel…`);
    runtime = await installRuntime({ runtimeDir: path.join(root, 'runtime'), component });
    console.log(`  ${runtime.version} ${runtime.cached ? '(déjà présent)' : '(téléchargé, SHA-1 vérifiés)'} : ${runtime.java}`);
    console.log(`  mémoire du jeu : ${ramMb} Mo`);
  }

  const identity = { name: 'AttackDev', uuid: offlineUuid('AttackDev'), accessToken: '0', userType: 'legacy' };
  const started = Date.now();
  const { pid, logFile, child } = await launchGame({
    java: runtime.java, minecraftDir, gameDir, versionId, identity, ramMb, launcherVersion: 'test',
  });
  console.log(`Jeu lancé (pid ${pid}), journal : ${logFile}`);
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });

  // en cas d'échec le jeu est fermé (Fabric laisse sinon une fenêtre d'erreur ouverte)
  const stop = () => {
    try {
      process.kill(pid);
    } catch {
      // déjà fermé
    }
  };
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const log = fs.readFileSync(logFile, 'utf8');
    const state = readLog(log, profile, { tweak: withOptifine?.tweak });
    if (state.ready) {
      console.log(`ÉCRAN TITRE atteint en ${((Date.now() - started) / 1000).toFixed(1)} s (${state.loader} : ${state.mods} mods chargés, ` +
        `ATTACK ${state.attack ? 'chargé' : 'ABSENT'}${withOptifine ? `, tweaker d'OptiFine ${state.tweaker ? 'chargé' : 'ABSENT'}` : ''})`);
      if (!state.attack) {
        stop();
        throw new Error('ATTACK ne figure pas parmi les mods chargés');
      }
      if (withOptifine && !state.tweaker) {
        stop();
        throw new Error(`OptiFine (${withOptifine.name}) est dans mods mais « Loading tweaker ${withOptifine.tweak} » est absent du journal ` +
          `(TweakClass lu dans la spec d'optifine.js)`);
      }
      break;
    }
    if (CRASH.test(log) || exited !== null) {
      stop();
      throw new Error(`Le jeu s'est arrêté (code ${exited}) : voir ${logFile}`);
    }
    if (Date.now() - started > 180000) {
      stop();
      throw new Error('Écran titre non atteint en 3 minutes');
    }
  }
  if (!keep) {
    await new Promise((r) => setTimeout(r, 4000));
    stop(); // le jeu a pu se fermer seul entre-temps : process.kill lèverait ESRCH alors que le test a réussi
    console.log('Jeu fermé.');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ÉCHEC : ${error.message}`);
    process.exit(1);
  });
}

module.exports = { readLog, tweakerLine, optifineInMods, parseOptions, parseJavaVersion, javaVersion, DEFAULT_RAM_MB };
