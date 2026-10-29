'use strict';
// Réglages du launcher (settings.json dans le dossier de données de l'app). Toute valeur venant de l'interface
// passe par sanitize() : type, bornes et chemins absolus.
// Réglages globaux (mémoire, langue, mode développeur, ID client Azure, profil choisi) + réglages PAR PROFIL
// (dossier de jeu, Java, arguments Java ajoutés, dossier des jars de développement, shaders, mods PvP) rangés dans `profiles`.
// Les clés à plat gameDir / javaPath / devJarDir / shaders / pvpMods d'un fichier ou d'une modification s'appliquent au profil
// courant : c'est ce qui migre l'ancien fichier (réglages globaux) vers le profil forge-1.8.9.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const catalog = require('./catalog');
const jvmargs = require('./jvmargs');
const { defaultGameDir, defaultDevJarDir } = require('./paths');

const LANGS = ['fr', 'en'];
const RAM_MIN = 1024;
const RAM_MAX = 16384;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * App Azure officielle d'ATTACK Launcher (annuaire de 7ShIkI3). Un ID client n'est pas un secret : il identifie
 * l'app aupres de Microsoft, comme le font tous les launchers open source.
 */
const DEFAULT_MS_CLIENT_ID = 'b904aac8-33e3-4ee6-a905-912a72de4859';

/** D'ou vient l'ID client effectif : 'settings' (Reglages), 'env' (ATTACK_MS_CLIENT_ID) ou 'default' (app officielle). */
function clientIdSource(settings, env = process.env) {
  if (settings.msClientId) return 'settings';
  return CLIENT_ID.test((env.ATTACK_MS_CLIENT_ID || '').trim()) ? 'env' : 'default';
}

/** ID client Azure effectif : celui des Reglages, sinon la variable ATTACK_MS_CLIENT_ID, sinon l'app officielle. */
function clientId(settings, env = process.env) {
  const source = clientIdSource(settings, env);
  if (source === 'settings') return settings.msClientId;
  return source === 'env' ? env.ATTACK_MS_CLIENT_ID.trim().toLowerCase() : DEFAULT_MS_CLIENT_ID;
}

/** Réglages par défaut d'un profil du catalogue. */
function profileDefaults(env, profile) {
  const values = { gameDir: defaultGameDir(env, profile), javaPath: '', jvmArgs: '', devJarDir: defaultDevJarDir(env, profile) };
  if (catalog.isFabric(profile)) {
    values.shaders = false;
    values.pvpMods = true; // mods PvP anti-latence du pack (Crystal Optimizer, Anchor Optimizer)
  }
  return values;
}

function defaults(env = process.env) {
  const profiles = {};
  for (const profile of catalog.list()) profiles[profile.id] = profileDefaults(env, profile);
  return {
    ramMb: 2048,
    lang: 'fr',
    devMode: false,
    msClientId: '',
    profileId: catalog.DEFAULT_PROFILE_ID,
    profiles,
  };
}

function cleanPath(value, fallback, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return allowEmpty ? '' : fallback;
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : fallback;
}

/** Deux dossiers de jeu sont les mêmes une fois résolus, sans tenir compte de la casse (Windows). */
function sameDir(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Fusionne les réglages d'un profil (dossier de jeu, Java, jars de développement, shaders, mods PvP) sur `base`.
 * `otherDirs` : dossiers de jeu effectifs des autres profils ; un profil ne peut pas prendre l'un d'eux.
 */
function sanitizeProfile(input, base, profile, otherDirs = []) {
  const s = { ...base };
  if ('gameDir' in input) {
    // chaîne vide = revenir au dossier par défaut
    const wanted = input.gameDir === '' ? defaultGameDir(process.env, profile) : cleanPath(input.gameDir, base.gameDir);
    if (!otherDirs.some((dir) => sameDir(dir, wanted))) s.gameDir = wanted;
  }
  if ('javaPath' in input) {
    const java = cleanPath(input.javaPath, base.javaPath, { allowEmpty: true });
    // nom de fichier exact (pas « notjava.exe ») : java.exe, javaw.exe, ou java sous Linux / macOS
    s.javaPath = java === '' || /(^|[\\/])javaw?\.exe$|[\\/]java$/i.test(java) ? java : base.javaPath;
  }
  if ('jvmArgs' in input) {
    // invalide : on garde l'ancienne valeur (l'interface reçoit l'erreur de settings:set)
    const args = jvmargs.normalize(input.jvmArgs);
    if (args !== null) s.jvmArgs = args;
  }
  if ('devJarDir' in input) s.devJarDir = cleanPath(input.devJarDir, base.devJarDir);
  if (catalog.isFabric(profile) && typeof input.shaders === 'boolean') s.shaders = input.shaders;
  if (catalog.isFabric(profile) && typeof input.pvpMods === 'boolean') s.pvpMods = input.pvpMods;
  return s;
}

const PROFILE_KEYS = ['gameDir', 'javaPath', 'jvmArgs', 'devJarDir', 'shaders', 'pvpMods'];

/** Fusionne `input` sur `base` en ne gardant que des valeurs valides. */
function sanitize(input, base = defaults()) {
  const s = { ...base, profiles: {} };
  for (const profile of catalog.list()) {
    s.profiles[profile.id] = { ...profileDefaults(process.env, profile), ...(base.profiles?.[profile.id] || {}) };
  }
  if (!catalog.isValidId(s.profileId)) s.profileId = catalog.DEFAULT_PROFILE_ID;
  if (!input || typeof input !== 'object') return s;
  if (Number.isFinite(Number(input.ramMb))) {
    s.ramMb = Math.min(RAM_MAX, Math.max(RAM_MIN, Math.round(Number(input.ramMb) / 256) * 256));
  }
  if (LANGS.includes(input.lang)) s.lang = input.lang;
  if (typeof input.devMode === 'boolean') s.devMode = input.devMode;
  // ID client Azure (pas un secret) : GUID, ou vide
  if (typeof input.msClientId === 'string') {
    const id = input.msClientId.trim();
    if (id === '' || CLIENT_ID.test(id)) s.msClientId = id.toLowerCase();
  }
  if (catalog.isValidId(input.profileId)) s.profileId = input.profileId;
  // dossiers de jeu effectifs des autres profils (lus à chaque appel : ils suivent les modifications déjà faites)
  const otherDirs = (id) => catalog.list().filter((p) => p.id !== id).map((p) => s.profiles[p.id].gameDir);
  // réglages rangés par profil (fichier enregistré). Les dossiers de jeu sont arbitrés en deux temps, sinon le profil
  // lu en premier serait comparé aux dossiers PAR DÉFAUT des suivants et perdrait, à la relecture, un dossier pourtant
  // libre (l'autre profil ayant déménagé) : un profil qui ne change pas de dossier garde le sien ; parmi ceux qui
  // changent, dans l'ordre du catalogue, un dossier déjà pris est refusé et l'ancien conservé.
  if (input.profiles && typeof input.profiles === 'object') {
    const current = {};
    const wanted = {};
    for (const profile of catalog.list()) {
      const entry = input.profiles[profile.id];
      current[profile.id] = s.profiles[profile.id];
      wanted[profile.id] = entry && typeof entry === 'object' ? sanitizeProfile(entry, s.profiles[profile.id], profile) : s.profiles[profile.id];
    }
    const taken = catalog.list().filter((p) => sameDir(wanted[p.id].gameDir, current[p.id].gameDir)).map((p) => wanted[p.id].gameDir);
    for (const profile of catalog.list()) {
      const next = wanted[profile.id];
      if (sameDir(next.gameDir, current[profile.id].gameDir)) continue;
      if (taken.some((dir) => sameDir(dir, next.gameDir))) {
        next.gameDir = taken.some((dir) => sameDir(dir, current[profile.id].gameDir)) ? defaultGameDir(process.env, profile) : current[profile.id].gameDir;
      }
      taken.push(next.gameDir);
    }
    for (const profile of catalog.list()) s.profiles[profile.id] = wanted[profile.id];
  }
  // clés à plat : elles concernent le profil courant (ancien fichier de réglages, modification faite dans l'interface)
  if (PROFILE_KEYS.some((key) => key in input)) {
    s.profiles[s.profileId] = sanitizeProfile(input, s.profiles[s.profileId], catalog.get(s.profileId), otherDirs(s.profileId));
  }
  return s;
}

/**
 * Réglages effectifs d'un profil (le courant par défaut), à plat : globaux + gameDir, javaPath, jvmArgs, devJarDir, shaders, pvpMods.
 * C'est cette vue que reçoivent l'installateur, le lancement et l'interface.
 */
function forProfile(settings, profileId = settings.profileId) {
  const id = catalog.isValidId(profileId) ? profileId : catalog.DEFAULT_PROFILE_ID;
  const own = settings.profiles?.[id] || profileDefaults(process.env, catalog.get(id));
  return {
    ramMb: settings.ramMb,
    lang: settings.lang,
    devMode: settings.devMode,
    msClientId: settings.msClientId,
    profileId: id,
    gameDir: own.gameDir,
    javaPath: own.javaPath,
    jvmArgs: own.jvmArgs || '',
    devJarDir: own.devJarDir,
    shaders: Boolean(own.shaders),
    pvpMods: own.pvpMods !== false, // activé par défaut (sans effet hors profils Fabric)
  };
}

/**
 * Lit le fichier ; illisible (coupure pendant une écriture, édition à la main) : il est mis de côté en `.corrupt`
 * plutôt qu'écrasé en silence par les défauts au prochain enregistrement, et les défauts sont rendus.
 */
async function load(file, env = process.env) {
  if (!fs.existsSync(file)) return defaults(env);
  try {
    return sanitize(JSON.parse(await fsp.readFile(file, 'utf8')), defaults(env));
  } catch {
    try {
      await fsp.copyFile(file, `${file}.corrupt`);
    } catch {
      // le fichier d'origine reste en place : rien de plus à faire
    }
    return defaults(env);
  }
}

let saving = Promise.resolve();

/** Écriture atomique (fichier temporaire puis renommage), les enregistrements successifs étant mis en file. */
function save(file, settings) {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  const run = async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  };
  const next = saving.then(run, run);
  saving = next.catch(() => {});
  return next;
}

module.exports = {
  LANGS, RAM_MIN, RAM_MAX, DEFAULT_MS_CLIENT_ID, defaults, profileDefaults, sanitize, forProfile, clientId, clientIdSource, load, save,
};
