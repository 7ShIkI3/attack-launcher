'use strict';
// Pack de mods d'un profil Fabric : liste figée (src/main/packs/<profil>.json, générée par scripts/resolve-pack.js).
// Le launcher ne contacte jamais l'API Modrinth : il télécharge seulement ces URL cdn.modrinth.com, chacune vérifiée
// par SHA-512 et taille. Les jars du pack sont suivis dans le fichier d'état : ceux qui sortent du pack sont supprimés,
// ceux que le joueur a ajoutés lui-même ne sont jamais touchés.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('./http');
const { safeJoin } = require('./maven');
const { MODRINTH_CDN_HOST } = require('./constants');

const PACKS_DIR = path.join(__dirname, 'packs');
const PACK_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILENAME = /^[\w.+-]+\.jar$/;
const MAX_JAR = 200 * 1024 * 1024;

/**
 * Valide un pack et renvoie sa version nettoyée (seuls les champs connus). `profile` : entrée du catalogue.
 * Refuse toute URL hors cdn.modrinth.com, tout hash mal formé et tout nom de fichier qui sortirait du dossier mods.
 */
function validatePack(pack, profile) {
  if (!pack || typeof pack !== 'object') throw new Error('Pack de mods illisible');
  if (pack.profileId !== profile.id) throw new Error(`Pack de mods : profil inattendu (${pack.profileId})`);
  if (pack.mc !== profile.mc) throw new Error(`Pack de mods : version de Minecraft inattendue (${pack.mc})`);
  if (pack.loader !== profile.loader.type) throw new Error(`Pack de mods : chargeur inattendu (${pack.loader})`);
  if (!Array.isArray(pack.mods) || pack.mods.length === 0) throw new Error('Pack de mods vide');
  const slugs = new Set();
  const names = new Set();
  const mods = pack.mods.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Pack de mods : entrée invalide');
    const { slug, name, version, filename, url, sha512, sha1, size } = raw;
    if (!SLUG.test(slug || '')) throw new Error(`Pack de mods : identifiant invalide (${slug})`);
    if (typeof name !== 'string' || name === '' || name.length > 64) throw new Error(`Pack de mods : nom invalide pour ${slug}`);
    if (typeof version !== 'string' || version === '' || version.length > 64) throw new Error(`Pack de mods : version invalide pour ${slug}`);
    if (typeof filename !== 'string' || !FILENAME.test(filename) || filename.includes('..')) {
      throw new Error(`Pack de mods : nom de fichier refusé pour ${slug} (${filename})`);
    }
    if (!/^[0-9a-f]{128}$/.test(sha512 || '')) throw new Error(`Pack de mods : SHA-512 invalide pour ${slug}`);
    if (sha1 !== undefined && !/^[0-9a-f]{40}$/.test(sha1)) throw new Error(`Pack de mods : SHA-1 invalide pour ${slug}`);
    if (!Number.isInteger(size) || size <= 0 || size > MAX_JAR) throw new Error(`Pack de mods : taille invalide pour ${slug}`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Pack de mods : adresse invalide pour ${slug}`);
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== MODRINTH_CDN_HOST || !parsed.pathname.startsWith('/data/')) {
      throw new Error(`Pack de mods : adresse refusée pour ${slug} (hors ${MODRINTH_CDN_HOST})`);
    }
    if (decodeURIComponent(parsed.pathname.split('/').pop()) !== filename) {
      throw new Error(`Pack de mods : l'adresse de ${slug} ne désigne pas ${filename}`);
    }
    if (slugs.has(slug) || names.has(filename.toLowerCase())) throw new Error(`Pack de mods : doublon (${slug})`);
    slugs.add(slug);
    names.add(filename.toLowerCase());
    const mod = { slug, name, version, filename, url, sha512, size };
    if (sha1) mod.sha1 = sha1;
    if (raw.optional === true) mod.optional = true;
    return mod;
  });
  return { profileId: pack.profileId, mc: pack.mc, loader: pack.loader, mods };
}

/** Pack figé d'un profil (null si le profil n'en a pas, comme Forge 1.8.9). */
function loadPack(profile, dir = PACKS_DIR) {
  if (!profile.pack) return null;
  if (!PACK_ID.test(profile.pack)) throw new Error(`Identifiant de pack invalide : ${profile.pack}`);
  const file = path.join(dir, `${profile.pack}.json`);
  return validatePack(JSON.parse(fs.readFileSync(file, 'utf8')), profile);
}

/** Mods à installer : tous ceux du pack, sauf les optionnels (Iris) quand les shaders sont désactivés. */
function selectedMods(pack, { shaders = false } = {}) {
  return pack.mods.filter((mod) => !mod.optional || shaders);
}

/**
 * Installe le pack dans <gameDir>/mods. options :
 *   shaders        installe aussi les mods optionnels
 *   previousManaged  noms de fichiers installés par un pack précédent (fichier d'état) : supprimés s'ils sortent du pack
 *   protectedNames noms jamais supprimés (le jar ATTACK)
 *   net, report    options réseau et rapport de progression ('pack', fait, total, message)
 * Renvoie { managed: [noms], removed: [noms], downloaded, skipped, mods: [{ slug, version, filename, sha512 }] }.
 * Les suppressions ont lieu après tous les téléchargements ; si un téléchargement échoue, les jars téléchargés pendant ce
 * passage sont retirés et les anciens jars ne sont pas touchés. Un jar qui ne peut pas être retiré (verrouillé) reste dans
 * `managed` et est listé dans `removeFailed`.
 */
async function installPack(gameDir, pack, options = {}) {
  const { shaders = false, previousManaged = [], protectedNames = [], net = {}, report } = options;
  const mods = selectedMods(pack, { shaders });
  const modsDir = path.join(gameDir, 'mods');
  await fsp.mkdir(modsDir, { recursive: true });
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  report?.('pack', 0, mods.length, 'Pack de mods');
  const fresh = []; // jars absents avant ce passage et téléchargés par lui
  try {
    await http.pool(mods, net.concurrency || 4, async (mod) => {
      const dest = safeJoin(modsDir, mod.filename);
      const existed = fs.existsSync(dest);
      const result = await http.downloadFile(mod.url, dest, { sha512: mod.sha512, size: mod.size }, net);
      if (result.skipped) skipped++;
      else downloaded++;
      if (!existed && !result.skipped) fresh.push(dest);
      report?.('pack', ++done, mods.length, mod.name);
    });
  } catch (error) {
    // échec au milieu d'une mise à jour : on ne laisse pas les nouveaux jars à côté des anciens (deux versions du même mod)
    await Promise.all(fresh.map((file) => fsp.rm(file, { force: true }).catch(() => {})));
    throw error;
  }

  const managed = mods.map((mod) => mod.filename);
  const keep = new Set([...managed, ...protectedNames].map((name) => name.toLowerCase()));
  const removed = [];
  const removeFailed = [];
  for (const name of previousManaged) {
    if (typeof name !== 'string' || !FILENAME.test(name) || name.includes('..') || keep.has(name.toLowerCase())) continue;
    const target = safeJoin(modsDir, name);
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    try {
      await fsp.rm(target, { force: true });
      removed.push(name);
    } catch {
      removeFailed.push(name); // jar verrouillé (jeu ouvert ?) : il reste suivi pour être retiré à la prochaine installation
    }
  }
  return {
    // un jar qu'on n'a pas pu retirer reste dans la liste gérée : il sera retenté, et l'état du pack le signale
    managed: [...managed, ...removeFailed],
    removed,
    removeFailed,
    downloaded,
    skipped,
    mods: mods.map((mod) => ({ slug: mod.slug, name: mod.name, version: mod.version, filename: mod.filename, sha512: mod.sha512 })),
  };
}

/** Vue pour l'interface : nom, version, optionnel (pas d'URL ni de hash). */
function view(pack) {
  return pack ? pack.mods.map((mod) => ({ slug: mod.slug, name: mod.name, version: mod.version, optional: Boolean(mod.optional) })) : [];
}

module.exports = { PACKS_DIR, validatePack, loadPack, selectedMods, installPack, view };
