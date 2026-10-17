'use strict';
// Profil « ATTACK Client » dans launcher_profiles.json du launcher officiel. On fusionne : les autres profils
// et réglages restent intacts, et une copie .bak est faite avant chaque écriture.
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
 * Renvoie une copie de `data` (contenu de launcher_profiles.json, ou null) avec le profil ATTACK à jour.
 * options : { gameDir, ramMb, javaPath, icon, now }.
 */
function mergeProfile(data, { gameDir, ramMb, javaPath, icon, now = new Date() }) {
  const result = data && typeof data === 'object' ? structuredClone(data) : {};
  if (!result.profiles || typeof result.profiles !== 'object') result.profiles = {};
  if (!result.settings) result.settings = {};
  if (!result.version) result.version = 3;
  const previous = result.profiles[PROFILE_ID] || {};
  const profile = {
    ...previous,
    name: PROFILE_NAME,
    type: 'custom',
    lastVersionId: FORGE_VERSION_ID,
    gameDir,
    javaArgs: withXmx(previous.javaArgs, ramMb),
    created: previous.created || now.toISOString(),
    lastUsed: previous.lastUsed || now.toISOString(),
  };
  if (icon) profile.icon = icon;
  if (javaPath) profile.javaDir = javaPath;
  else delete profile.javaDir;
  result.profiles[PROFILE_ID] = profile;
  return result;
}

/** Met le profil ATTACK en dernier utilisé : avec le tri « par dernière partie », il est présélectionné. */
function markLastUsed(data, now = new Date()) {
  const result = structuredClone(data);
  if (!result.profiles?.[PROFILE_ID]) throw new Error('Profil ATTACK absent : installe le client d’abord');
  result.profiles[PROFILE_ID].lastUsed = now.toISOString();
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
  mergeProfile,
  markLastUsed,
  readProfiles,
  writeProfiles,
  updateProfiles,
};
