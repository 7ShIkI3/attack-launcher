'use strict';
// Dossiers par défaut : .minecraft (versions, bibliothèques, assets, profils du launcher officiel)
// et .attack (dossiers de jeu séparés : mods, configs, captures) pour ne pas mélanger avec d'autres mods.
// Chaque profil du catalogue a son dossier de jeu : .attack pour Forge 1.8.9 (inchangé),
// .attack/profiles/<profil> pour les profils Fabric.
const os = require('node:os');
const path = require('node:path');

function appData(env = process.env) {
  return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function defaultMinecraftDir(env = process.env) {
  return path.join(appData(env), '.minecraft');
}

/** Dossier de jeu par défaut d'un profil du catalogue (profil historique si aucun n'est donné). */
function defaultGameDir(env = process.env, profile = null) {
  const name = profile?.gameDirName || '.attack';
  return path.join(appData(env), ...name.split('/'));
}

/**
 * Dossier des jars compilés du mod (mode développeur). Surcharge par variable d'environnement :
 * ATTACK_DEV_JAR_DIR pour le profil Forge 1.8.9, ATTACK_DEV_JAR_DIR_<PROFIL> (FABRIC_1_21_1…) pour les autres.
 */
function defaultDevJarDir(env = process.env, profile = null) {
  if (profile && profile.id !== 'forge-1.8.9') {
    const key = `ATTACK_DEV_JAR_DIR_${profile.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    return env[key] || path.join(os.homedir(), ...profile.attackJar.devDir);
  }
  return env.ATTACK_DEV_JAR_DIR || path.join(os.homedir(), ...(profile?.attackJar.devDir || ['Documents', 'pvp-essentials', 'build', 'libs']));
}

module.exports = { appData, defaultMinecraftDir, defaultGameDir, defaultDevJarDir };
