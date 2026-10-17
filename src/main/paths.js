'use strict';
// Dossiers par défaut : .minecraft (versions, bibliothèques, assets, profils du launcher officiel)
// et .attack (dossier de jeu séparé : mods, configs, captures) pour ne pas mélanger avec d'autres mods.
const os = require('node:os');
const path = require('node:path');

function appData(env = process.env) {
  return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function defaultMinecraftDir(env = process.env) {
  return path.join(appData(env), '.minecraft');
}

function defaultGameDir(env = process.env) {
  return path.join(appData(env), '.attack');
}

/** Dossier des jars compilés du mod (mode développeur). */
function defaultDevJarDir(env = process.env) {
  return env.ATTACK_DEV_JAR_DIR || path.join(os.homedir(), 'Documents', 'pvp-essentials', 'build', 'libs');
}

module.exports = { appData, defaultMinecraftDir, defaultGameDir, defaultDevJarDir };
