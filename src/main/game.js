'use strict';
// Lancement direct de Minecraft (1.8.9 + Forge, 1.21.1 / 26.3 + Fabric), sans le launcher officiel : fusion du JSON
// du chargeur avec celui de Minecraft (inheritsFrom), classpath, natives extraites, arguments du jeu (ancien format
// `minecraftArguments`, ou format moderne `arguments` avec règles), sortie dans un fichier journal.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const mojang = require('./mojang');
const catalog = require('./catalog');
const { mavenPath, safeJoin } = require('./maven');
const { readEntries, readEntry } = require('./zip');
const { DEFAULT_JVM_ARGS } = require('./constants');

const HIDDEN = '<masqué>';

async function readVersion(minecraftDir, id) {
  const file = safeJoin(minecraftDir, `versions/${id}/${id}.json`);
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/** Fusionne une version et ses parents (inheritsFrom) : bibliothèques de l'enfant d'abord. */
async function resolveVersion(minecraftDir, id, read = readVersion) {
  const chain = [];
  let current = await read(minecraftDir, id);
  chain.push(current);
  while (current.inheritsFrom) {
    if (chain.length > 5) throw new Error('Héritage de versions trop profond');
    current = await read(minecraftDir, current.inheritsFrom);
    chain.push(current);
  }
  const pick = (key) => chain.find((v) => v[key] !== undefined)?.[key];
  const base = chain[chain.length - 1];
  // format moderne : les arguments du parent viennent avant ceux de l'enfant (comme le launcher officiel)
  const mergeArguments = (kind) => [...chain].reverse().flatMap((v) => v.arguments?.[kind] || []);
  const modern = chain.some((v) => v.arguments);
  return {
    id,
    mainClass: pick('mainClass'),
    minecraftArguments: pick('minecraftArguments'),
    arguments: modern ? { game: mergeArguments('game'), jvm: mergeArguments('jvm') } : null,
    assets: pick('assetIndex')?.id || pick('assets'),
    jar: chain[0].jar || base.id,
    logging: pick('logging'),
    javaComponent: pick('javaVersion')?.component || 'jre-legacy',
    javaMajor: pick('javaVersion')?.majorVersion || null,
    libraries: chain.flatMap((v) => v.libraries || []),
  };
}

/** Composant Java (jre-legacy, java-runtime-delta, java-runtime-epsilon…) que demande le JSON de version fusionné. */
async function javaComponent(minecraftDir, versionId, read = readVersion) {
  return (await resolveVersion(minecraftDir, versionId, read)).javaComponent;
}

function libraryKey(name) {
  const [group, artifact, , classifier] = name.split(':');
  return `${group}:${artifact}${classifier ? `:${classifier}` : ''}`;
}

/** Classpath (artefacts) et jars de natives, selon les règles de la plateforme ; doublons écartés (l'enfant gagne). */
function libraryPlan(version, minecraftDir, env = mojang.currentEnv()) {
  const librariesDir = path.join(minecraftDir, 'libraries');
  const seen = new Set();
  const classpath = [];
  const natives = [];
  for (const lib of version.libraries) {
    if (!mojang.rulesAllow(lib.rules, env)) continue;
    const nativeKey = lib.natives?.[env.name];
    if (nativeKey) {
      const classifier = nativeKey.replace('${arch}', env.arch);
      const artifact = lib.downloads?.classifiers?.[classifier];
      natives.push({ file: safeJoin(librariesDir, artifact?.path || mavenPath(lib.name, classifier)), exclude: lib.extract?.exclude || [] });
    }
    const key = libraryKey(lib.name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (lib.downloads?.artifact || !lib.natives) {
      classpath.push(safeJoin(librariesDir, lib.downloads?.artifact?.path || mavenPath(lib.name)));
    }
  }
  classpath.push(safeJoin(minecraftDir, `versions/${version.jar}/${version.jar}.jar`));
  return { classpath, natives };
}

/** Extrait les natives (.dll) dans `dir`, en sautant META-INF et les dossiers. */
async function extractNatives(natives, dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  let count = 0;
  for (const { file, exclude } of natives) {
    const buffer = await fsp.readFile(file);
    const entries = readEntries(buffer);
    for (const name of entries.keys()) {
      if (name.endsWith('/') || exclude.some((prefix) => name.startsWith(prefix))) continue;
      const target = safeJoin(dir, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, readEntry(buffer, name, entries));
      count++;
    }
  }
  return count;
}

const PLACEHOLDER = /\$\{(\w+)\}/g;

/**
 * Développe les arguments du format moderne : chaque entrée est une chaîne ou { rules, value: chaîne | [chaînes] },
 * filtrée par les règles de la plateforme (les options du launcher comme --demo ou la résolution sont exclues).
 * Les variables ${...} sont remplacées dans chaque argument SANS le découper : un argument avec des espaces reste entier.
 */
function expandArguments(list, values, env = mojang.currentEnv()) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && mojang.rulesAllow(entry.rules, env)) out.push(...(Array.isArray(entry.value) ? entry.value : [entry.value]));
  }
  return out.map((arg) => String(arg).replace(PLACEHOLDER, (match, key) => (key in values ? values[key] : match)));
}

/** Sous-dossiers de natives_directory cités par les arguments Java (26.x : java, jna, lwjgl, netty). */
function nativesSubdirs(version) {
  const text = JSON.stringify(version.arguments?.jvm || []);
  return [...new Set([...text.matchAll(/\$\{natives_directory\}[\\/]+([\w.-]+)/g)].map((m) => m[1]))];
}

/** Ligne de commande du format moderne (`arguments`) : le JSON de version fournit -cp, java.library.path et la marque. */
function modernCommand({ java, version, minecraftDir, nativesDir, classpath, identity, ramMb, launcherVersion, platform, values, assetsDir }) {
  const env = mojang.currentEnv(platform);
  const modernValues = {
    ...values,
    natives_directory: nativesDir,
    launcher_name: 'attack-launcher',
    launcher_version: launcherVersion,
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: path.join(minecraftDir, 'libraries'),
    // identifiants du launcher officiel que nous n'avons pas : valeur vide plutôt qu'une variable non remplacée
    clientid: '',
    auth_xuid: '',
    resolution_width: '',
    resolution_height: '',
  };
  const fromJson = expandArguments(version.arguments.jvm, modernValues, env);
  const jvmArgs = [`-Xmx${ramMb}M`, ...DEFAULT_JVM_ARGS.split(' '), ...fromJson];
  // ajoutés seulement s'ils manquent : jamais deux fois
  if (!fromJson.some((a) => a === '-cp' || a === '-classpath' || a === '--class-path')) jvmArgs.push('-cp', modernValues.classpath);
  if (!fromJson.some((a) => a.startsWith('-Djava.library.path='))) jvmArgs.push(`-Djava.library.path=${nativesDir}`);
  if (!fromJson.some((a) => a.startsWith('-Dminecraft.launcher.brand='))) jvmArgs.push('-Dminecraft.launcher.brand=attack-launcher');
  if (!fromJson.some((a) => a.startsWith('-Dminecraft.launcher.version='))) jvmArgs.push(`-Dminecraft.launcher.version=${launcherVersion}`);
  const logging = version.logging?.client;
  if (logging?.file?.id) {
    jvmArgs.push(logging.argument.replace('${path}', path.join(assetsDir, 'log_configs', logging.file.id)));
  }
  const args = [...jvmArgs, version.mainClass, ...expandArguments(version.arguments.game, modernValues, env)];
  // le message ne cite que le nom de la variable : jamais l'argument entier, qui pourrait contenir un jeton déjà remplacé
  const unresolved = args.map((arg) => /\$\{(\w+)\}/.exec(arg)).find(Boolean);
  if (unresolved) throw new Error(`Variable de lancement non résolue : ${unresolved[1]}`);
  return { command: java, args, redacted: redact([java, ...args], identity.accessToken) };
}

/**
 * Ligne de commande Java : { command, args, redacted }.
 * identity = { name, uuid, accessToken, userType } ; `redacted` est la version à journaliser (jeton masqué).
 * Deux formats de JSON de version : `minecraftArguments` (1.8.9 + Forge) et `arguments` avec règles (Fabric 1.21.1 / 26.3).
 */
function buildCommand({ java, version, minecraftDir, gameDir, nativesDir, classpath, identity, ramMb, launcherVersion = '0', platform = process.platform }) {
  const assetsDir = path.join(minecraftDir, 'assets');
  const values = {
    auth_player_name: identity.name,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: assetsDir,
    game_assets: assetsDir,
    assets_index_name: version.assets,
    auth_uuid: identity.uuid,
    auth_access_token: identity.accessToken,
    auth_session: identity.accessToken,
    user_properties: '{}',
    user_type: identity.userType,
    version_type: 'release',
  };
  if (version.arguments) {
    return modernCommand({ java, version, minecraftDir, gameDir, nativesDir, classpath, identity, ramMb, launcherVersion, platform, values, assetsDir });
  }
  const gameArgs = version.minecraftArguments.split(' ').filter(Boolean)
    .map((arg) => arg.replace(/\$\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match)));

  const jvmArgs = [`-Xmx${ramMb}M`, ...DEFAULT_JVM_ARGS.split(' ')];
  if (platform === 'win32') jvmArgs.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
  jvmArgs.push(
    `-Djava.library.path=${nativesDir}`,
    '-Dminecraft.launcher.brand=attack-launcher',
    `-Dminecraft.launcher.version=${launcherVersion}`,
  );
  const logging = version.logging?.client;
  if (logging?.file?.id) {
    // configuration log4j de Mojang : corrige aussi la faille Log4Shell des anciennes versions
    jvmArgs.push(logging.argument.replace('${path}', path.join(assetsDir, 'log_configs', logging.file.id)));
  }
  const args = [...jvmArgs, '-cp', classpath.join(path.delimiter), version.mainClass, ...gameArgs];
  return { command: java, args, redacted: redact([java, ...args], identity.accessToken) };
}

/** Texte journalisable : le jeton (et tout argument qui le contient) est masqué. */
function redact(argv, secret) {
  return argv.map((arg, i) => {
    if (argv[i - 1] === '--accessToken' || argv[i - 1] === '--session') return HIDDEN;
    if (secret && secret.length > 4 && arg.includes(secret)) return arg.split(secret).join(HIDDEN);
    return /\s/.test(arg) ? `"${arg}"` : arg;
  }).join(' ');
}

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * Prépare et lance le jeu. Renvoie { pid, logFile, child }. La sortie du jeu va dans <gameDir>/logs/launcher/game-*.log.
 * options : { java, minecraftDir, gameDir, versionId, identity, ramMb, launcherVersion }
 */
async function launchGame(options) {
  const { java, minecraftDir, gameDir, versionId, identity, ramMb, launcherVersion } = options;
  if (!fs.existsSync(java)) throw new Error(`Java introuvable : ${java}`);
  const version = await resolveVersion(minecraftDir, versionId);
  const { classpath, natives } = libraryPlan(version, minecraftDir);
  const missing = [...classpath, ...natives.map((n) => n.file)].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) throw new Error(`Fichiers manquants (${missing.length}) : lance « Vérifier / réparer l'installation »`);
  const nativesDir = path.join(minecraftDir, 'versions', versionId, 'natives-attack');
  await extractNatives(natives, nativesDir);
  for (const sub of nativesSubdirs(version)) await fsp.mkdir(safeJoin(nativesDir, sub), { recursive: true });
  await fsp.mkdir(gameDir, { recursive: true });
  const command = buildCommand({ java, version, minecraftDir, gameDir, nativesDir, classpath, identity, ramMb, launcherVersion });

  const logDir = path.join(gameDir, 'logs', 'launcher');
  await fsp.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `game-${timestamp()}.log`);
  await fsp.writeFile(logFile, `[ATTACK Launcher] ${new Date().toISOString()} — joueur ${identity.name}\n[ATTACK Launcher] ${command.redacted}\n\n`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(command.command, command.args, { cwd: gameDir, detached: true, stdio: ['ignore', fd, fd], windowsHide: false });
  fs.closeSync(fd);
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return { pid: child.pid, logFile, child };
}

/** Lignes de commande des processus Java en cours (Windows), sans barre de progression parasite. */
const JAVA_PROCESSES_PS = "$ProgressPreference='SilentlyContinue'; " +
  "Get-CimInstance Win32_Process -Filter \"Name='javaw.exe' OR Name='java.exe'\" | ForEach-Object { $_.CommandLine }";

/**
 * Lignes de commande de la sortie qui sont une partie ATTACK : le --version du jeu est l'id de version d'un profil du
 * catalogue (Forge 1.8.9, Fabric 1.21.1 ou 26.3), quel que soit le launcher. `versionIds` : une chaîne ou une liste.
 */
function gameCommandLines(output, versionIds = catalog.versionIds()) {
  const ids = [].concat(versionIds);
  return String(output || '').split(/\r?\n/).filter((line) => ids.some((id) => line.includes(id)));
}

/** Vrai si une de ces lignes de commande est une partie ATTACK. */
function isGameCommandLine(output, versionIds) {
  return gameCommandLines(output, versionIds).length > 0;
}

/**
 * Lignes de commande des parties ATTACK en cours, lancées par ce launcher ou par le launcher officiel.
 * Vide si la détection échoue : on ne bloque pas les mises à jour pour toujours.
 */
function runningGameLines({ run = execFile, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve([]);
  const encoded = Buffer.from(JAVA_PROCESSES_PS, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000 },
      (error, stdout) => resolve(error ? [] : gameCommandLines(stdout)));
  });
}

/** Une partie tourne-t-elle, lancée par ce launcher ou par le launcher officiel ? */
async function detectRunningGame(options) {
  return (await runningGameLines(options)).length > 0;
}

/** Dossier de jeu (--gameDir) d'une ligne de commande Java ; null s'il manque ou n'est pas un chemin absolu. */
function gameDirOfCommandLine(line) {
  const match = /--gameDir(?:\s+|=)("[^"]*"|.*?)(?=\s+--|\s*$)/.exec(String(line));
  const dir = match ? match[1].replace(/^"|"$/g, '') : '';
  return path.isAbsolute(dir) ? dir : null;
}

/**
 * Une partie en cours empêche-t-elle d'installer dans `gameDir` ? Seule une partie qui joue dans CE dossier bloque
 * (chemins résolus, casse ignorée) : une partie d'un autre profil ne gêne pas.
 * `ownGameDirs` : dossiers de jeu des parties lancées par ce launcher et encore ouvertes.
 * `commandLines` : parties ATTACK détectées (runningGameLines), lancées par le launcher officiel ou non.
 * Une ligne dont le --gameDir est introuvable ne peut pas être comparée : par prudence, elle bloque.
 */
function gameBlocksInstall(gameDir, ownGameDirs = [], commandLines = []) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (ownGameDirs.some((dir) => same(dir, gameDir))) return true;
  return commandLines.some((line) => {
    const dir = gameDirOfCommandLine(line);
    return dir === null || same(dir, gameDir);
  });
}

module.exports = {
  HIDDEN, readVersion, resolveVersion, javaComponent, libraryPlan, extractNatives, expandArguments, nativesSubdirs, buildCommand, redact, launchGame,
  JAVA_PROCESSES_PS, gameCommandLines, isGameCommandLine, runningGameLines, detectRunningGame, gameDirOfCommandLine, gameBlocksInstall,
};
