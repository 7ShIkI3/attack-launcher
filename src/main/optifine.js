'use strict';
// OptiFine pour les profils Forge 1.8.9 et 1.7.10. Sa licence interdit de le redistribuer : le launcher ne le télécharge JAMAIS.
// Il utilise seulement la copie que le joueur possède déjà (téléchargée par lui sur optifine.net) :
//  - la copie de .minecraft/libraries/optifine/OptiFine/<mc>_*/ (laissée par l'installateur d'OptiFine),
//  - ou un jar de .minecraft/mods,
//  - ou le fichier que le joueur choisit lui-même (réglage `optifineJar`).
// Avant de s'en servir, le jar est validé : archive ZIP lisible, META-INF/MANIFEST.MF avec
// « TweakClass: optifine.OptiFineForgeTweaker » et un nom qui contient la version de Minecraft du profil. Il est ensuite copié dans
// <dossier de jeu>/mods et suivi dans le fichier d'état (jamais supprimé s'il n'est plus celui que le launcher a copié : un jar du joueur
// est intouchable).
// Une SPEC par version de Minecraft (table SPECS ci-dessous) dit quel OptiFine est attendu. Chaque fonction exportée prend la version de
// Minecraft en dernier paramètre (ou dans ses options) et vaut 1.8.9 sans lui : les appels historiques n'ont pas changé.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readEntry } = require('./zip');
const { renameRetry } = require('./fsretry'); // jamais ./http : ce module n'accède pas au réseau (test statique)
const { safeJoin } = require('./maven');

/** Page de téléchargement officielle, ouverte dans le navigateur (jamais lue ni téléchargée par le launcher). */
const DOWNLOAD_URL = 'https://optifine.net/downloads';
/** Version de Minecraft prise quand l'appelant n'en donne pas : le profil historique. */
const DEFAULT_MC = '1.8.9';
/**
 * TweakClass d'OptiFine pour Forge, le même en 1.8.9 (jar HD U M5) et en 1.7.10 (jar HD U E7, manifeste lu : « TweakClass:
 * optifine.OptiFineForgeTweaker », « TweakOrder: -1000 »). Le catalogue, la validation, l'assistant et les scripts d'essai le lisent
 * tous dans SPECS.
 */
const TWEAK = 'optifine.OptiFineForgeTweaker';
/**
 * Spec d'OptiFine par version de Minecraft : table fermée, une entrée par version prise en charge.
 *   mc       version de Minecraft du profil
 *   edition  édition d'OptiFine vérifiée avec le mod ATTACK (HD_U_M5, HD_U_E7) ; une autre édition est acceptée, mais « non testée »
 *   tweak    valeur attendue de l'attribut TweakClass du manifeste
 *   minMod   (facultatif) version minimale du mod ATTACK compatible avec OptiFine : plus ancien, le launcher demande la mise à jour
 * Le catalogue (catalog.js) reprend ces objets tels quels : une seule source.
 */
const SPECS = Object.freeze({
  '1.8.9': Object.freeze({ mc: '1.8.9', edition: 'HD_U_M5', tweak: TWEAK }),
  '1.7.10': Object.freeze({ mc: '1.7.10', edition: 'HD_U_E7', tweak: TWEAK, minMod: '1.1.0' }),
});

/** Spec d'une version de Minecraft (1.8.9 sans argument), ou null si OptiFine n'y est pas pris en charge. */
function forVersion(mc = DEFAULT_MC) {
  return typeof mc === 'string' && Object.prototype.hasOwnProperty.call(SPECS, mc) ? SPECS[mc] : null;
}

/** Spec d'une version, ou une erreur : demander OptiFine pour une version inconnue est un bogue de l'appelant (jamais une erreur du joueur). */
function needSpec(mc = DEFAULT_MC) {
  const spec = forVersion(mc);
  if (!spec) throw new RangeError(`OptiFine n'est pas pris en charge pour Minecraft ${mc}`);
  return spec;
}

const MAX_JAR = 64 * 1024 * 1024;
/** Taille décompressée maximale de MANIFEST.MF : le vrai fait quelques lignes ; un jar choisi ou déposé peut être piégé (bombe de décompression). */
const MAX_MANIFEST = 1024 * 1024;
const FILENAME = /^[\w.+-]+\.jar$/;

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new Map(); // « type|mc » -> expression régulière : compilées une fois

function pattern(kind, mc, build) {
  const key = `${kind}|${mc}`;
  if (!compiled.has(key)) compiled.set(key, build(escapeRegex(mc)));
  return compiled.get(key);
}

/** La version de Minecraft est dans le nom, entre deux autres caractères que des chiffres : 1.7.10 n'est ni dans 21.7.10 ni dans 1.7.101. */
function mcInName(name, mc = DEFAULT_MC) {
  return pattern('mc', mc, (m) => new RegExp(`(?<!\\d)${m}(?!\\d)`)).test(String(name));
}

/** Nom qui désigne un OptiFine de cette version (OptiFine-1.8.9_HD_U_M5.jar, OptiFine_1.7.10_HD_U_E7.jar…). */
function nameMatches(name, mc = DEFAULT_MC) {
  return pattern('name', mc, (m) => new RegExp(`optifine.*(?<!\\d)${m}(?!\\d)`, 'i')).test(String(name));
}

/** Une version de Minecraft « 1.x » ou « 1.x.y » dans un nom de fichier. */
const ANY_MC = /(?<![\d.])1\.\d{1,2}(?:\.\d{1,2})?(?!\d)/;

/**
 * Retire le suffixe « (1) » que le navigateur ajoute à un fichier déjà téléchargé : Chrome/Edge « OptiFine_1.8.9_HD_U_M5 (1).jar »,
 * Firefox « OptiFine_1.8.9_HD_U_M5(1).jar » (collé) -> « OptiFine_1.8.9_HD_U_M5.jar ».
 */
function stripCopySuffix(name) {
  return String(name).replace(/\s?\(\d+\)(?=\.jar$)/i, '');
}

/**
 * Jar d'un OptiFine d'une AUTRE version de Minecraft que `mc` (OptiFine_1.8.9_… quand on attend la 1.7.10) : il ferait échouer Forge s'il
 * restait dans mods. Le nom doit citer OptiFine et une version de Minecraft qui n'est pas `mc`. Le suffixe « (1) » du navigateur est ignoré.
 */
function isForeignName(name, mc = DEFAULT_MC) {
  const clean = stripCopySuffix(name);
  return /\.jar$/i.test(clean) && /optifine/i.test(clean) && ANY_MC.test(clean) && !nameMatches(clean, mc);
}

/** Variante dans le nom (« HD_U_M5 »), ou null. Tolère le suffixe « (n) » d'un téléchargement répété. */
function versionOf(name, mc = DEFAULT_MC) {
  const re = pattern('version', mc, (m) => new RegExp(`(?<!\\d)${m}[_-]([\\w.+-]+?)\\.jar$`, 'i'));
  return re.exec(stripCopySuffix(name))?.[1] || null;
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

/**
 * Texte clair pour chaque raison de refus (la page traduit les codes). {mc} et {tweak} sont ceux de la spec : voir describeReason.
 */
const REASONS = {
  NOT_JAR: "Ce n'est pas un fichier .jar.",
  WRONG_NAME: "Le nom du fichier ne contient pas {mc} : ce n'est pas OptiFine pour Minecraft {mc}.",
  BAD_ZIP: "Ce fichier n'est pas une archive .jar lisible.",
  NO_TWEAK: "Ce jar n'est pas OptiFine pour Forge {mc} (TweakClass {tweak} absent).",
  TOO_BIG: 'Ce fichier est trop gros pour être OptiFine.',
  UNREADABLE: 'Ce fichier est illisible.',
};

/** Texte d'une raison de refus pour une version de Minecraft (1.8.9 sans argument) ; undefined pour une raison inconnue. */
function describeReason(reason, mc = DEFAULT_MC) {
  const text = REASONS[reason];
  if (text === undefined) return undefined;
  const spec = forVersion(mc) || SPECS[DEFAULT_MC];
  return text.replaceAll('{mc}', spec.mc).replaceAll('{tweak}', spec.tweak);
}

/** Valide le contenu d'un jar déjà lu en mémoire : { ok: true, sha256, version } ou { ok: false, reason }. */
function checkBuffer(buffer, name, mc = DEFAULT_MC) {
  const spec = needSpec(mc);
  if (!/\.jar$/i.test(name)) return { ok: false, reason: 'NOT_JAR' };
  if (!mcInName(name, spec.mc)) return { ok: false, reason: 'WRONG_NAME' };
  let manifest;
  try {
    manifest = readEntry(buffer, 'META-INF/MANIFEST.MF', undefined, { maxSize: MAX_MANIFEST });
  } catch (error) {
    return { ok: false, reason: error?.code === 'ZIP_TOO_BIG' ? 'TOO_BIG' : 'BAD_ZIP' };
  }
  if (!manifest) return { ok: false, reason: 'NO_TWEAK' };
  if (parseManifest(manifest.toString('utf8')).TweakClass !== spec.tweak) return { ok: false, reason: 'NO_TWEAK' };
  return { ok: true, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), version: versionOf(name, spec.mc) };
}

const cache = new Map(); // « mc|chemin|taille|date » -> résultat : status() est appelé souvent, le jar fait ~2 Mo

/**
 * Valide un fichier pour une version de Minecraft : { ok, file, name, size, sha256, version, mc } ou { ok: false, file, reason, message, mc }.
 * Ne lève jamais d'erreur à cause du fichier (une version de Minecraft inconnue est un bogue de l'appelant : RangeError).
 * La version de Minecraft fait partie de la clé du cache : un refus pour la 1.7.10 n'est jamais resservi pour la 1.8.9.
 */
async function validate(file, mc = DEFAULT_MC) {
  const spec = needSpec(mc);
  const name = path.basename(String(file || ''));
  const fail = (reason) => ({ ok: false, file, name, reason, message: describeReason(reason, spec.mc), mc: spec.mc });
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return fail('UNREADABLE');
    if (stat.size > MAX_JAR) return fail('TOO_BIG');
    const key = `${spec.mc}|${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`;
    if (cache.has(key)) return cache.get(key);
    // le nom est contrôlé avant de lire le fichier : un mauvais choix est refusé sans lecture
    const early = !/\.jar$/i.test(name) ? fail('NOT_JAR') : !mcInName(name, spec.mc) ? fail('WRONG_NAME') : null;
    let result = early;
    if (!result) {
      const checked = checkBuffer(await fsp.readFile(file), name, spec.mc);
      result = checked.ok
        ? { ok: true, file, name, size: stat.size, sha256: checked.sha256, version: checked.version, mc: spec.mc }
        : fail(checked.reason);
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
 * libraries/optifine/OptiFine/<mc>_*\/OptiFine-<mc>_*.jar, puis mods/*OptiFine*<mc>*.jar. Les OptiFine des autres versions sont ignorés.
 */
async function candidates(minecraftDir, mc = DEFAULT_MC) {
  const spec = needSpec(mc);
  const found = [];
  const root = path.join(minecraftDir, 'libraries', 'optifine', 'OptiFine');
  const dirs = (await listDir(root)).filter((d) => d.isDirectory() && d.name.startsWith(`${spec.mc}_`)).map((d) => d.name);
  dirs.sort((a, b) => natural.compare(b, a));
  for (const dir of dirs) found.push({ file: path.join(root, dir, `OptiFine-${dir}.jar`), source: 'libraries' });
  const mods = (await listDir(path.join(minecraftDir, 'mods')))
    .filter((e) => e.isFile() && /\.jar$/i.test(e.name) && nameMatches(e.name, spec.mc)).map((e) => e.name);
  mods.sort((a, b) => natural.compare(b, a));
  for (const name of mods) found.push({ file: path.join(minecraftDir, 'mods', name), source: 'mods' });
  return found;
}

/**
 * Cherche LA copie du joueur : le fichier choisi (`chosen`) d'abord, puis les copies de .minecraft.
 * Renvoie { found, file, name, version, source, size, sha256, chosenError? } ; `chosenError` = raison du refus du fichier choisi
 * (la recherche automatique continue alors). Ne lève jamais d'erreur à cause d'un fichier.
 */
async function detect({ minecraftDir, chosen = '', mc = DEFAULT_MC } = {}) {
  needSpec(mc);
  let chosenError = null;
  if (chosen) {
    const checked = await validate(chosen, mc);
    if (checked.ok) return { found: true, source: 'chosen', ...checked };
    chosenError = checked.reason;
  }
  if (minecraftDir) {
    for (const candidate of await candidates(minecraftDir, mc)) {
      const checked = await validate(candidate.file, mc);
      if (checked.ok) return { found: true, source: candidate.source, ...checked, ...(chosenError ? { chosenError } : {}) };
    }
  }
  return { found: false, ...(chosenError ? { chosenError } : {}) };
}

/** Nom d'un OptiFine de cette version que le joueur a lui-même mis dans <dossier de jeu>/mods (jamais celui que le launcher y a copié), ou null. */
async function ownCopy(gameDir, trackedName, mc = DEFAULT_MC) {
  const entries = await listDir(path.join(gameDir, 'mods'));
  const own = entries.filter((e) => e.isFile() && /\.jar$/i.test(e.name) && nameMatches(e.name, mc) && e.name !== trackedName).map((e) => e.name);
  return own.sort((a, b) => natural.compare(b, a))[0] || null;
}

/** Jars OptiFine d'une AUTRE version de Minecraft dans <dossier de jeu>/mods : signalés à la page, jamais supprimés. */
async function foreignCopies(gameDir, mc = DEFAULT_MC) {
  const entries = await listDir(path.join(gameDir, 'mods'));
  return entries.filter((e) => e.isFile() && isForeignName(e.name, mc)).map((e) => e.name).sort((a, b) => natural.compare(a, b));
}

/** Nom sous lequel la copie est rangée dans mods : celui du fichier s'il est propre, sinon OptiFine-<mc>_<variante>.jar. */
function destName(found, mc = DEFAULT_MC) {
  const clean = stripCopySuffix(found.name); // « … (1).jar » -> « ….jar » : le suffixe du navigateur ne va pas dans mods
  if (FILENAME.test(clean) && nameMatches(clean, mc)) return clean;
  const version = (found.version || 'custom').replace(/[^\w.+-]/g, '_');
  return `OptiFine-${needSpec(mc).mc}_${version}.jar`;
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
 *   mc, edition, minMod  la spec du profil (édition vérifiée avec le mod, version minimale du mod ATTACK ou null)
 *   enabled   réglage « OptiFine » du profil
 *   found     une copie valide existe (sinon : `reason` du refus du fichier choisi dans `chosenError`)
 *   own       le joueur a déjà mis un OptiFine de cette version dans mods : le launcher n'en ajoute pas un second
 *   foreign   noms des jars OptiFine d'une AUTRE version de Minecraft dans mods (signalés, jamais supprimés)
 *   installed la copie suivie est dans mods
 *   kept      nom du jar copié par le launcher et gardé alors que sa copie d'origine a disparu (il marche : la page le compte), sinon null
 *   untested  l'OptiFine utilisé n'est pas l'édition vérifiée de la spec (accepté, mais « non testé »)
 *   wantCopy  il faut qu'une copie soit dans mods ; pending : l'installation a quelque chose à faire (copier, remplacer ou retirer)
 * options : { minecraftDir, gameDir, enabled, chosen, tracked (état `optifine`), mc }.
 */
async function inspect({ minecraftDir, gameDir, enabled = true, chosen = '', tracked = null, mc = DEFAULT_MC }) {
  const spec = needSpec(mc);
  const detected = await detect({ minecraftDir, chosen, mc: spec.mc });
  const own = await ownCopy(gameDir, tracked?.file, spec.mc);
  const foreign = await foreignCopies(gameDir, spec.mc);
  const present = trackedPresent(gameDir, tracked);
  const wantCopy = Boolean(enabled) && detected.found && !own;
  const upToDate = present && tracked.sha256 === detected.sha256;
  const kept = Boolean(enabled) && present && !detected.found && !own ? tracked.file : null;
  const version = detected.version || (kept && tracked.version) || null;
  // l'édition réellement utilisée : celle du fichier de mods du joueur, sinon la copie détectée ou gardée
  const used = own ? versionOf(own, spec.mc) : version;
  return {
    mc: spec.mc,
    edition: spec.edition,
    minMod: spec.minMod || null,
    enabled: Boolean(enabled),
    found: detected.found,
    source: detected.source || null,
    file: detected.file || null,
    name: detected.name || null,
    version,
    sha256: detected.sha256 || null,
    size: detected.size || null,
    chosenError: detected.chosenError || null,
    own,
    foreign,
    installed: present,
    kept,
    untested: Boolean(used) && used.toLowerCase() !== spec.edition.toLowerCase(),
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
async function apply({ minecraftDir, gameDir, enabled = true, chosen = '', tracked = null, mc = DEFAULT_MC }) {
  const spec = needSpec(mc);
  const view = await inspect({ minecraftDir, gameDir, enabled, chosen, tracked, mc: spec.mc });
  const modsDir = path.join(gameDir, 'mods');
  if (!view.wantCopy) {
    // option active, pas d'OptiFine du joueur dans mods et plus aucune copie d'origine (supprimée, déplacée, fichier choisi effacé) :
    // le jar déjà copié marche, il reste en place et l'état est gardé tel quel
    if (view.kept) return { action: 'kept', info: tracked, view: { ...view, pending: false } };
    const removed = await removeTracked(gameDir, tracked);
    const action = removed ? 'removed' : view.own ? 'own' : !enabled ? 'disabled' : 'missing';
    return { action, info: null, view: { ...view, installed: false, pending: false } };
  }
  const name = destName(view, spec.mc);
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

/**
 * Assistant : copie PRIVÉE de l'OptiFine que le joueur vient de télécharger, dans <dossier de données>/optifine/ (son dossier
 * Téléchargements est souvent vidé). Le jar est validé (ZIP lisible, TweakClass, version de Minecraft), copié dans un `.part`, comparé par
 * SHA-256 puis renommé. La copie reste sur ce PC : ce n'est pas une redistribution. Lève une erreur (`code` OPTIFINE_<raison> ou COPY_MISMATCH)
 * si le jar est refusé ou si la copie est altérée. Renvoie { file, name, size, sha256, version, reused }.
 */
async function importCopy(file, userDataDir, mc = DEFAULT_MC) {
  const spec = needSpec(mc);
  const checked = await validate(file, spec.mc);
  if (!checked.ok) throw Object.assign(new Error(checked.message), { code: `OPTIFINE_${checked.reason}`, reason: checked.reason });
  const dir = path.join(userDataDir, 'optifine');
  await fsp.mkdir(dir, { recursive: true });
  const name = destName(checked, spec.mc);
  const dest = safeJoin(dir, name);
  const info = { file: dest, name, size: checked.size, sha256: checked.sha256, version: checked.version };
  // même fichier déjà rangé (ou fichier choisi dans notre propre dossier) : rien à recopier
  if (path.resolve(file).toLowerCase() === path.resolve(dest).toLowerCase()) return { ...info, reused: true };
  const existing = await fsp.stat(dest).catch(() => null);
  if (existing?.isFile() && existing.size === checked.size && (await sha256Of(dest)) === checked.sha256) return { ...info, reused: true };
  const part = `${dest}.part`;
  try {
    await fsp.copyFile(file, part);
    if ((await sha256Of(part)) !== checked.sha256) {
      throw Object.assign(new Error("La copie d'OptiFine ne correspond pas au fichier d'origine (fichier modifié pendant la copie ?)."), { code: 'COPY_MISMATCH' });
    }
    await renameRetry(part, dest);
  } catch (error) {
    await fsp.rm(part, { force: true });
    throw error;
  }
  return { ...info, reused: false };
}

module.exports = {
  DOWNLOAD_URL, DEFAULT_MC, TWEAK, SPECS, REASONS, MAX_JAR, forVersion, describeReason, stripCopySuffix, mcInName, nameMatches, isForeignName, versionOf,
  destName, parseManifest, checkBuffer, validate, candidates, detect, ownCopy, foreignCopies, inspect, apply, importCopy, removeTracked,
};
