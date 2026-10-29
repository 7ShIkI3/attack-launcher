'use strict';
// OptiFine pour le profil 1.8.9 (Forge). Sa licence interdit de le redistribuer : le launcher ne le télécharge JAMAIS.
// Il utilise seulement la copie que le joueur possède déjà (téléchargée par lui sur optifine.net) :
//  - la copie de .minecraft/libraries/optifine/OptiFine/1.8.9_*/ (laissée par l'installateur d'OptiFine),
//  - ou un jar de .minecraft/mods,
//  - ou le fichier que le joueur choisit lui-même (réglage `optifineJar`).
// Avant de s'en servir, le jar est validé : archive ZIP lisible, META-INF/MANIFEST.MF avec
// « TweakClass: optifine.OptiFineForgeTweaker » et un nom qui contient 1.8.9. Il est ensuite copié dans <dossier de jeu>/mods
// et suivi dans le fichier d'état (jamais supprimé s'il n'est plus celui que le launcher a copié : un jar du joueur est intouchable).
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readEntries, readEntry } = require('./zip');
const { renameRetry } = require('./http');
const { safeJoin } = require('./maven');

/** Page de téléchargement officielle, ouverte dans le navigateur (jamais lue ni téléchargée par le launcher). */
const DOWNLOAD_URL = 'https://optifine.net/downloads';
const MC = '1.8.9';
const TWEAK = 'optifine.OptiFineForgeTweaker';
const MAX_JAR = 64 * 1024 * 1024;
/** Taille décompressée maximale de MANIFEST.MF : le vrai fait quelques lignes ; un jar choisi ou déposé peut être piégé (bombe de décompression). */
const MAX_MANIFEST = 1024 * 1024;
const FILENAME = /^[\w.+-]+\.jar$/;
/** Nom qui désigne un OptiFine 1.8.9 (OptiFine-1.8.9_HD_U_M5.jar, OptiFine_1.8.9_HD_U_M5.jar…). */
const NAME = /optifine.*1\.8\.9/i;

/** Variante dans le nom (« HD_U_M5 »), ou null. */
function versionOf(name) {
  return /1\.8\.9[_-]([\w.+-]+?)\.jar$/i.exec(String(name))?.[1] || null;
}

/** Attributs principaux d'un MANIFEST.MF (lignes repliées à 72 caractères recollées). */
function parseManifest(text) {
  const attributes = {};
  const unfolded = String(text).replace(/\r?\n /g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) attributes[match[1]] = match[2].trim();
    if (line === '') break; // fin de la section principale
  }
  return attributes;
}

/** Texte clair pour chaque raison de refus (la page traduit les codes). */
const REASONS = {
  NOT_JAR: "Ce n'est pas un fichier .jar.",
  WRONG_NAME: "Le nom du fichier ne contient pas 1.8.9 : ce n'est pas OptiFine pour Minecraft 1.8.9.",
  BAD_ZIP: "Ce fichier n'est pas une archive .jar lisible.",
  NO_TWEAK: "Ce jar n'est pas OptiFine pour Forge 1.8.9 (TweakClass optifine.OptiFineForgeTweaker absent).",
  TOO_BIG: 'Ce fichier est trop gros pour être OptiFine.',
  UNREADABLE: 'Ce fichier est illisible.',
};

/** Valide le contenu d'un jar déjà lu en mémoire : { ok: true, sha256, version } ou { ok: false, reason }. */
function checkBuffer(buffer, name) {
  if (!/\.jar$/i.test(name)) return { ok: false, reason: 'NOT_JAR' };
  if (!/1\.8\.9/.test(name)) return { ok: false, reason: 'WRONG_NAME' };
  let manifest;
  try {
    manifest = readEntry(buffer, 'META-INF/MANIFEST.MF', undefined, { maxSize: MAX_MANIFEST });
  } catch (error) {
    return { ok: false, reason: error?.code === 'ZIP_TOO_BIG' ? 'TOO_BIG' : 'BAD_ZIP' };
  }
  if (!manifest) return { ok: false, reason: 'NO_TWEAK' };
  if (parseManifest(manifest.toString('utf8')).TweakClass !== TWEAK) return { ok: false, reason: 'NO_TWEAK' };
  return { ok: true, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), version: versionOf(name) };
}

const cache = new Map(); // « chemin|taille|date » -> résultat : status() est appelé souvent, le jar fait ~2 Mo

/**
 * Valide un fichier : { ok, file, name, size, sha256, version } ou { ok: false, file, reason, message }.
 * Ne lève jamais d'erreur.
 */
async function validate(file) {
  const name = path.basename(String(file || ''));
  const fail = (reason) => ({ ok: false, file, name, reason, message: REASONS[reason] });
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return fail('UNREADABLE');
    if (stat.size > MAX_JAR) return fail('TOO_BIG');
    const key = `${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`;
    if (cache.has(key)) return cache.get(key);
    // le nom est contrôlé avant de lire le fichier : un mauvais choix est refusé sans lecture
    const early = !/\.jar$/i.test(name) ? fail('NOT_JAR') : !/1\.8\.9/.test(name) ? fail('WRONG_NAME') : null;
    let result = early;
    if (!result) {
      const checked = checkBuffer(await fsp.readFile(file), name);
      result = checked.ok ? { ok: true, file, name, size: stat.size, sha256: checked.sha256, version: checked.version } : fail(checked.reason);
    }
    cache.set(key, result);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    return result;
  } catch {
    return fail('UNREADABLE');
  }
}

/** Comparaison « naturelle » (M10 après M9) pour choisir la copie la plus récente. */
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Jars candidats dans un dossier .minecraft : [{ file, source: 'libraries' | 'mods' }], les plus récents d'abord.
 * libraries/optifine/OptiFine/1.8.9_*\/OptiFine-1.8.9_*.jar, puis mods/*OptiFine*1.8.9*.jar.
 */
async function candidates(minecraftDir) {
  const found = [];
  const root = path.join(minecraftDir, 'libraries', 'optifine', 'OptiFine');
  const dirs = (await listDir(root)).filter((d) => d.isDirectory() && d.name.startsWith(`${MC}_`)).map((d) => d.name);
  dirs.sort((a, b) => natural.compare(b, a));
  for (const dir of dirs) found.push({ file: path.join(root, dir, `OptiFine-${dir}.jar`), source: 'libraries' });
  const mods = (await listDir(path.join(minecraftDir, 'mods')))
    .filter((e) => e.isFile() && /\.jar$/i.test(e.name) && NAME.test(e.name)).map((e) => e.name);
  mods.sort((a, b) => natural.compare(b, a));
  for (const name of mods) found.push({ file: path.join(minecraftDir, 'mods', name), source: 'mods' });
  return found;
}

/**
 * Cherche LA copie du joueur : le fichier choisi (`chosen`) d'abord, puis les copies de .minecraft.
 * Renvoie { found, file, name, version, source, size, sha256, chosenError? } ; `chosenError` = raison du refus du fichier choisi
 * (la recherche automatique continue alors). Ne lève jamais d'erreur.
 */
async function detect({ minecraftDir, chosen = '' } = {}) {
  let chosenError = null;
  if (chosen) {
    const checked = await validate(chosen);
    if (checked.ok) return { found: true, source: 'chosen', ...checked };
    chosenError = checked.reason;
  }
  if (minecraftDir) {
    for (const candidate of await candidates(minecraftDir)) {
      const checked = await validate(candidate.file);
      if (checked.ok) return { found: true, source: candidate.source, ...checked, ...(chosenError ? { chosenError } : {}) };
    }
  }
  return { found: false, ...(chosenError ? { chosenError } : {}) };
}

/** Nom d'un OptiFine 1.8.9 que le joueur a lui-même mis dans <dossier de jeu>/mods (jamais celui que le launcher y a copié), ou null. */
async function ownCopy(gameDir, trackedName) {
  const entries = await listDir(path.join(gameDir, 'mods'));
  const own = entries.filter((e) => e.isFile() && /\.jar$/i.test(e.name) && NAME.test(e.name) && e.name !== trackedName).map((e) => e.name);
  return own.sort((a, b) => natural.compare(b, a))[0] || null;
}

/** Nom sous lequel la copie est rangée dans mods : celui du fichier s'il est propre, sinon OptiFine-1.8.9_<variante>.jar. */
function destName(found) {
  if (FILENAME.test(found.name) && NAME.test(found.name)) return found.name;
  const version = (found.version || 'custom').replace(/[^\w.+-]/g, '_');
  return `OptiFine-${MC}_${version}.jar`;
}

async function sha256Of(file) {
  return crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}

/** Le jar suivi est-il toujours là, tel que le launcher l'a copié (même taille) ? */
function trackedPresent(gameDir, tracked) {
  if (!tracked || typeof tracked.file !== 'string' || !FILENAME.test(tracked.file)) return false;
  try {
    return fs.statSync(path.join(gameDir, 'mods', tracked.file)).size === tracked.size;
  } catch {
    return false;
  }
}

/**
 * Situation d'OptiFine pour un dossier de jeu, sans rien écrire :
 *   enabled   réglage « OptiFine » du profil
 *   found     une copie valide existe (sinon : `reason` du refus du fichier choisi dans `chosenError`)
 *   own       le joueur a déjà mis un OptiFine dans mods : le launcher n'en ajoute pas un second
 *   installed la copie suivie est dans mods
 *   wantCopy  il faut qu'une copie soit dans mods ; pending : l'installation a quelque chose à faire (copier, remplacer ou retirer)
 * options : { minecraftDir, gameDir, enabled, chosen, tracked (état `optifine`) }.
 */
async function inspect({ minecraftDir, gameDir, enabled = true, chosen = '', tracked = null }) {
  const detected = await detect({ minecraftDir, chosen });
  const own = await ownCopy(gameDir, tracked?.file);
  const present = trackedPresent(gameDir, tracked);
  const wantCopy = Boolean(enabled) && detected.found && !own;
  const upToDate = present && tracked.sha256 === detected.sha256;
  return {
    enabled: Boolean(enabled),
    found: detected.found,
    source: detected.source || null,
    file: detected.file || null,
    name: detected.name || null,
    version: detected.version || null,
    sha256: detected.sha256 || null,
    size: detected.size || null,
    chosenError: detected.chosenError || null,
    own,
    installed: present,
    wantCopy,
    // sans copie à poser, la copie suivie ne part que si l'option est coupée ou si le joueur a mis la sienne : quand sa source
    // a disparu (found:false), le jar de mods marche toujours et reste en place
    pending: wantCopy ? !upToDate : present && (!enabled || Boolean(own)),
  };
}

/** Retire la copie suivie, seulement si elle est encore telle que le launcher l'a posée (même empreinte). Renvoie true si retirée. */
async function removeTracked(gameDir, tracked) {
  if (!tracked || typeof tracked.file !== 'string' || !FILENAME.test(tracked.file)) return false;
  const target = safeJoin(path.join(gameDir, 'mods'), tracked.file);
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  if (!tracked.sha256 || (await sha256Of(target)) !== tracked.sha256) return false; // le joueur l'a remplacé : on n'y touche pas
  await fsp.rm(target, { force: true });
  return true;
}

/**
 * Met <dossier de jeu>/mods en accord avec le réglage : copie la copie du joueur (ou la remplace), ou retire celle que le
 * launcher avait copiée. Ne télécharge rien. Renvoie
 *   { action: 'copied' | 'kept' | 'removed' | 'own' | 'missing' | 'disabled', info, view }
 * `info` = valeur à ranger dans l'état (`optifine`), null quand rien n'est suivi. Lève une erreur si la copie échoue.
 */
async function apply({ minecraftDir, gameDir, enabled = true, chosen = '', tracked = null }) {
  const view = await inspect({ minecraftDir, gameDir, enabled, chosen, tracked });
  const modsDir = path.join(gameDir, 'mods');
  if (!view.wantCopy) {
    // option active, pas d'OptiFine du joueur dans mods et plus aucune copie d'origine (supprimée, déplacée, fichier choisi effacé) :
    // le jar déjà copié marche, il reste en place et l'état est gardé tel quel
    if (view.enabled && !view.own && view.installed) return { action: 'kept', info: tracked, view: { ...view, pending: false } };
    const removed = await removeTracked(gameDir, tracked);
    const action = removed ? 'removed' : view.own ? 'own' : !enabled ? 'disabled' : 'missing';
    return { action, info: null, view: { ...view, installed: false, pending: false } };
  }
  const name = destName(view);
  const dest = safeJoin(modsDir, name);
  let action = 'kept';
  if (!(view.installed && tracked.file === name && tracked.sha256 === view.sha256)) {
    await fsp.mkdir(modsDir, { recursive: true });
    const part = `${dest}.part`;
    await fsp.copyFile(view.file, part);
    try {
      if ((await sha256Of(part)) !== view.sha256) throw new Error("La copie d'OptiFine ne correspond pas au fichier d'origine.");
      await renameRetry(part, dest);
    } catch (error) {
      await fsp.rm(part, { force: true });
      throw error;
    }
    action = 'copied';
    // l'ancienne copie suivie (autre variante) part : deux OptiFine dans mods feraient échouer Forge
    if (tracked && tracked.file !== name) await removeTracked(gameDir, tracked);
  }
  const info = { file: name, source: view.source, from: view.file, sha256: view.sha256, size: view.size, version: view.version };
  return { action, info, view: { ...view, installed: true, pending: false } };
}

module.exports = {
  DOWNLOAD_URL, TWEAK, REASONS, versionOf, parseManifest, checkBuffer, validate, candidates, detect, ownCopy, inspect, apply, removeTracked,
};
