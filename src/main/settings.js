'use strict';
// Réglages du launcher (settings.json dans le dossier de données de l'app). Toute valeur venant de l'interface
// passe par sanitize() : type, bornes et chemins absolus.
// Réglages globaux (mémoire, langue, mode développeur, ID client Azure, profil choisi) + réglages PAR PROFIL
// (dossier de jeu, Java, dossier des jars de développement, shaders) rangés dans `profiles`.
// Les clés à plat gameDir / javaPath / devJarDir / shaders d'un fichier ou d'une modification s'appliquent au profil
// courant : c'est ce qui migre l'ancien fichier (réglages globaux) vers le profil forge-1.8.9.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const catalog = require('./catalog');
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
  const values = { gameDir: defaultGameDir(env, profile), javaPath: '', devJarDir: defaultDevJarDir(env, profile) };
  if (catalog.isFabric(profile)) values.shaders = false;
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

/** Fusionne les réglages d'un profil (dossier de jeu, Java, jars de développement, shaders) sur `base`. */
function sanitizeProfile(input, base, profile) {
  const s = { ...base };
  // chaîne vide = revenir au dossier par défaut
  if ('gameDir' in input) s.gameDir = input.gameDir === '' ? defaultGameDir(process.env, profile) : cleanPath(input.gameDir, base.gameDir);
  if ('javaPath' in input) {
    const java = cleanPath(input.javaPath, base.javaPath, { allowEmpty: true });
    s.javaPath = java === '' || /javaw?\.exe$|\/java$/i.test(java) ? java : base.javaPath;
  }
  if ('devJarDir' in input) s.devJarDir = cleanPath(input.devJarDir, base.devJarDir);
  if (catalog.isFabric(profile) && typeof input.shaders === 'boolean') s.shaders = input.shaders;
  return s;
}

const PROFILE_KEYS = ['gameDir', 'javaPath', 'devJarDir', 'shaders'];

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
  // réglages rangés par profil (fichier enregistré)
  if (input.profiles && typeof input.profiles === 'object') {
    for (const profile of catalog.list()) {
      const entry = input.profiles[profile.id];
      if (entry && typeof entry === 'object') s.profiles[profile.id] = sanitizeProfile(entry, s.profiles[profile.id], profile);
    }
  }
  // clés à plat : elles concernent le profil courant (ancien fichier de réglages, modification faite dans l'interface)
  if (PROFILE_KEYS.some((key) => key in input)) {
    s.profiles[s.profileId] = sanitizeProfile(input, s.profiles[s.profileId], catalog.get(s.profileId));
  }
  return s;
}

/**
 * Réglages effectifs d'un profil (le courant par défaut), à plat : globaux + gameDir, javaPath, devJarDir, shaders.
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
    devJarDir: own.devJarDir,
    shaders: Boolean(own.shaders),
  };
}

async function load(file, env = process.env) {
  if (!fs.existsSync(file)) return defaults(env);
  try {
    return sanitize(JSON.parse(await fsp.readFile(file, 'utf8')), defaults(env));
  } catch {
    return defaults(env);
  }
}

async function save(file, settings) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

module.exports = {
  LANGS, RAM_MIN, RAM_MAX, DEFAULT_MS_CLIENT_ID, defaults, profileDefaults, sanitize, forProfile, clientId, clientIdSource, load, save,
};
