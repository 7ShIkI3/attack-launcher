'use strict';
// Profils ATTACK dans launcher_profiles.json du launcher officiel (« ATTACK Client » pour Forge 1.8.9, « ATTACK 1.21.1 »
// et « ATTACK 26.3 » pour Fabric). On fusionne : les autres profils et réglages restent intacts, et une copie .bak
// est faite avant chaque écriture.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { PROFILE_ID, PROFILE_NAME, FORGE_VERSION_ID, DEFAULT_JVM_ARGS } = require('./constants');

const PROFILES_FILE = 'launcher_profiles.json';

/** Remplace (ou ajoute) -Xmx dans des arguments Java. */
function withXmx(javaArgs, ramMb) {
  const xmx = `-Xmx${ramMb}M`;
  const args = (javaArgs || DEFAULT_JVM_ARGS).split(/\s+/).filter((a) => a && !/^-Xmx\d+[kKmMgG]?$/.test(a));
  return [xmx, ...args].join(' ');
}

/**
 * Renvoie une copie de `data` (contenu de launcher_profiles.json, ou null) avec un profil ATTACK à jour.
 * options : { id, name, versionId, gameDir, ramMb, javaPath, icon, now } ; sans id / name / versionId, c'est le profil
 * historique « ATTACK Client » (Forge 1.8.9).
 */
function mergeProfile(data, { id = PROFILE_ID, name = PROFILE_NAME, versionId = FORGE_VERSION_ID, gameDir, ramMb, javaPath, icon, now = new Date() }) {
  const result = data && typeof data === 'object' ? structuredClone(data) : {};
  if (!result.profiles || typeof result.profiles !== 'object') result.profiles = {};
  if (!result.settings) result.settings = {};
  if (!result.version) result.version = 3;
  const previous = result.profiles[id] || {};
  const profile = {
    ...previous,
    name,
    type: 'custom',
    lastVersionId: versionId,
    gameDir,
    javaArgs: withXmx(previous.javaArgs, ramMb),
    created: previous.created || now.toISOString(),
    lastUsed: previous.lastUsed || now.toISOString(),
  };
  if (icon) profile.icon = icon;
  if (javaPath) profile.javaDir = javaPath;
  else delete profile.javaDir;
  result.profiles[id] = profile;
  return result;
}

/** Options de mergeProfile qui viennent d'une entrée du catalogue (catalog.js). */
function identityOf(profile) {
  return { id: profile.launcherProfileId, name: profile.name, versionId: profile.loader.versionId };
}

/** Met un profil ATTACK en dernier utilisé : avec le tri « par dernière partie », il est présélectionné. */
function markLastUsed(data, now = new Date(), id = PROFILE_ID) {
  const result = structuredClone(data);
  if (!result.profiles?.[id]) throw new Error('Profil ATTACK absent : installe le client d’abord');
  result.profiles[id].lastUsed = now.toISOString();
  return result;
}

/** Lit launcher_profiles.json ; null s'il n'existe pas ; erreur s'il est illisible (on ne l'écrase jamais). */
async function readProfiles(minecraftDir) {
  const file = path.join(minecraftDir, PROFILES_FILE);
  if (!fs.existsSync(file)) return null;
  const text = await fsp.readFile(file, 'utf8');
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error(`${PROFILES_FILE} est illisible : il n'a pas été modifié`);
  }
}

/** Écrit launcher_profiles.json après avoir copié l'original en .bak ; écriture atomique (fichier temporaire + renommage). */
async function writeProfiles(minecraftDir, data) {
  const file = path.join(minecraftDir, PROFILES_FILE);
  await fsp.mkdir(minecraftDir, { recursive: true });
  if (fs.existsSync(file)) await fsp.copyFile(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

async function updateProfiles(minecraftDir, transform) {
  const next = transform(await readProfiles(minecraftDir));
  await writeProfiles(minecraftDir, next);
  return next;
}

module.exports = {
  PROFILES_FILE,
  withXmx,
  identityOf,
  mergeProfile,
  markLastUsed,
  readProfiles,
  writeProfiles,
  updateProfiles,
};
