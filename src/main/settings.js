'use strict';
// Réglages du launcher (settings.json dans le dossier de données de l'app). Toute valeur venant de l'interface
// passe par sanitize() : type, bornes et chemins absolus.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { defaultGameDir, defaultDevJarDir } = require('./paths');

const LANGS = ['fr', 'en'];
const RAM_MIN = 1024;
const RAM_MAX = 16384;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ID client Azure effectif : celui des réglages, sinon la variable ATTACK_MS_CLIENT_ID. */
function clientId(settings, env = process.env) {
  const fromEnv = (env.ATTACK_MS_CLIENT_ID || '').trim();
  return settings.msClientId || (CLIENT_ID.test(fromEnv) ? fromEnv.toLowerCase() : '');
}

function defaults(env = process.env) {
  return {
    ramMb: 2048,
    gameDir: defaultGameDir(env),
    javaPath: '',
    lang: 'fr',
    devMode: false,
    devJarDir: defaultDevJarDir(env),
    msClientId: '',
  };
}

function cleanPath(value, fallback, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return allowEmpty ? '' : fallback;
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : fallback;
}

/** Fusionne `input` sur `base` en ne gardant que des valeurs valides. */
function sanitize(input, base = defaults()) {
  const s = { ...base };
  if (!input || typeof input !== 'object') return s;
  if (Number.isFinite(Number(input.ramMb))) {
    s.ramMb = Math.min(RAM_MAX, Math.max(RAM_MIN, Math.round(Number(input.ramMb) / 256) * 256));
  }
  // chaîne vide = revenir au dossier par défaut
  if ('gameDir' in input) s.gameDir = input.gameDir === '' ? defaults().gameDir : cleanPath(input.gameDir, base.gameDir);
  if ('javaPath' in input) {
    const java = cleanPath(input.javaPath, base.javaPath, { allowEmpty: true });
    s.javaPath = java === '' || /javaw?\.exe$|\/java$/i.test(java) ? java : base.javaPath;
  }
  if (LANGS.includes(input.lang)) s.lang = input.lang;
  if (typeof input.devMode === 'boolean') s.devMode = input.devMode;
  if ('devJarDir' in input) s.devJarDir = cleanPath(input.devJarDir, base.devJarDir);
  // ID client Azure (pas un secret) : GUID, ou vide
  if (typeof input.msClientId === 'string') {
    const id = input.msClientId.trim();
    if (id === '' || CLIENT_ID.test(id)) s.msClientId = id.toLowerCase();
  }
  return s;
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

module.exports = { LANGS, RAM_MIN, RAM_MAX, defaults, sanitize, clientId, load, save };
