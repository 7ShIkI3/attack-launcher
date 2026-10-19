'use strict';
// Source du jar ATTACK : dernière release GitHub (avec SHA-256), ou, en mode développeur, le dernier jar compilé
// localement. Chaque profil a sa propre règle de nom (catalog.js) : attack-client*.jar pour Forge 1.8.9,
// attack-fabric-<version>+mc<mc>.jar pour Fabric. Le jar est choisi par cette règle exacte, jamais « le premier
// qui ressemble » : un jar d'une autre version de Minecraft n'est jamais installé par erreur.
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./catalog');
const { GITHUB_LATEST_RELEASE, GITHUB_RELEASES } = require('./constants');
const { parseVersion } = require('./updates');

const EXCLUDED = /-(sources|javadoc|dev|deobf)\.jar$/i;
const SHA256 = /\b([0-9a-f]{64})\b/i;

/** Version du launcher en préversion (semver avec « - » : 0.5.0-beta.1) ? Une version illisible n'en est pas une. */
function isPrereleaseVersion(version) {
  return (parseVersion(version)?.pre.length || 0) > 0;
}

/**
 * Release GitHub d'où vient le jar. Launcher en version normale : `releases/latest`, qui ignore les préversions.
 * Launcher en préversion (canal bêta) : la première release qui n'est pas un brouillon parmi les dernières, préversion
 * acceptée. `getJson(url)` lit et décode une adresse de l'API GitHub (injectée : testable sans réseau).
 */
async function fetchRelease(appVersion, getJson) {
  if (!isPrereleaseVersion(appVersion)) return getJson(GITHUB_LATEST_RELEASE);
  const list = await getJson(GITHUB_RELEASES);
  const release = Array.isArray(list) ? list.find((r) => r && typeof r === 'object' && r.draft !== true) : null;
  if (!release) throw Object.assign(new Error("Aucune release d'ATTACK n'est publiée"), { code: 'NO_RELEASE' });
  return release;
}

/** Profil du catalogue (ou son identifiant) ; profil historique Forge 1.8.9 par défaut. */
function resolveProfile(profile) {
  if (!profile) return catalog.get();
  return typeof profile === 'string' ? catalog.get(profile) : profile;
}

/** Premier hash SHA-256 d'un fichier « .sha256 » (format sha256sum ou hash seul). */
function parseSha256File(text) {
  const match = SHA256.exec(String(text));
  if (!match) throw new Error('Fichier .sha256 sans hash valide');
  return match[1].toLowerCase();
}

/** Assets d'une release qui correspondent à la règle exacte du profil. */
function matchingAssets(assets, profile) {
  const rule = catalog.jarRule(profile);
  return assets.filter((a) => typeof a?.name === 'string' && rule.matches(a.name) && !EXCLUDED.test(a.name));
}

/**
 * Extrait le jar d'une release GitHub : { version, name, url, size, sha256, sha256Url }.
 * Le SHA-256 vient du champ `digest` de l'asset (GitHub), sinon d'un asset « <jar>.sha256 » à télécharger.
 * Pour un profil Fabric, plusieurs jars correspondant à la règle exacte sont une erreur (jamais un choix au hasard).
 */
function parseRelease(release, profileOrId) {
  const profile = resolveProfile(profileOrId);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const found = matchingAssets(assets, profile);
  if (found.length === 0) {
    // un jar attack-fabric* qui ne suit pas la règle (préversion, autre version de Minecraft) est cité pour aider à comprendre
    const ignored = assets.map((a) => a?.name).filter((n) => typeof n === 'string' && /^attack-fabric/i.test(n) && !/\.sha256$/i.test(n));
    throw Object.assign(new Error(catalog.isFabric(profile)
      ? `La dernière release ne contient pas de jar attack-fabric pour Minecraft ${profile.mc}${ignored.length > 0 ? ` (jars attack-fabric ignorés : ${ignored.join(', ')})` : ''}`
      : 'La dernière release ne contient pas de jar attack-client'), { code: 'NO_JAR' });
  }
  if (found.length > 1 && profile.attackJar.unique) {
    throw Object.assign(new Error(`La dernière release contient plusieurs jars ATTACK pour Minecraft ${profile.mc} : ${found.map((a) => a.name).join(', ')}`), { code: 'AMBIGUOUS_JAR' });
  }
  const jar = found[0];
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(jar.digest || '');
  const sidecar = assets.find((a) => a.name === `${jar.name}.sha256` || a.name === 'SHA256SUMS' || a.name === 'sha256.txt');
  if (!digest && !sidecar) throw new Error('La release ne publie pas de SHA-256 pour le jar : installation refusée');
  return {
    version: release.tag_name || release.name || 'inconnue',
    name: jar.name,
    url: jar.browser_download_url,
    size: jar.size,
    sha256: digest ? digest[1].toLowerCase() : null,
    sha256Url: digest ? null : sidecar.browser_download_url,
    sha256File: digest ? null : sidecar.name,
  };
}

/**
 * Hash d'un jar dans un fichier SHA256SUMS (« hash  nom ») ou .sha256.
 * Un fichier qui liste plusieurs jars exige une ligne portant le nom du jar : on ne prend jamais le hash d'un autre fichier.
 */
function sha256For(text, jarName) {
  const lines = String(text).split(/\r?\n/);
  const named = lines.find((line) => line.trim().endsWith(jarName) || line.includes(` *${jarName}`));
  if (named) return parseSha256File(named);
  const hashed = lines.filter((l) => SHA256.test(l));
  if (hashed.length > 1) throw new Error(`Aucun SHA-256 pour ${jarName} dans le fichier de sommes`);
  return parseSha256File(hashed[0] || '');
}

/** Dernier jar du profil dans un dossier (le plus récent), ou null. */
function findDevJar(dir, profileOrId) {
  if (!dir || !fs.existsSync(dir)) return null;
  const rule = catalog.jarRule(resolveProfile(profileOrId));
  const jars = fs
    .readdirSync(dir)
    .filter((name) => rule.matches(name) && !EXCLUDED.test(name))
    .map((name) => ({ name, file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return jars[0] || null;
}

/** Version lisible depuis un nom de jar : attack-client-2.0.0.jar -> 2.0.0, attack-fabric-0.1.0+mc1.21.1.jar -> 0.1.0. */
function versionFromJarName(name, profileOrId) {
  return catalog.jarRule(resolveProfile(profileOrId)).version(name) || 'dev';
}

/** Dernier segment d'un chemin ou d'une URL, décodé : GitHub écrit le « + » du nom d'un jar Fabric en %2B. */
function lastSegment(file) {
  const segment = String(file || '').split(/[\\/]/).pop();
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Version du mod installé, sans « v » initial : lue dans le nom du jar d'origine (`name` enregistré à l'installation, sinon
 * la fin de l'URL de release ou du chemin local, attack-client-2.1.0.jar -> 2.1.0), sinon la version enregistrée
 * (le tag du launcher pour une release).
 */
function installedVersion(info) {
  const name = info?.name ? String(info.name) : lastSegment(info?.file);
  let fromJar = null;
  for (const profile of catalog.list()) {
    fromJar = catalog.jarRule(profile).version(name);
    if (fromJar) break;
  }
  const version = fromJar || info?.version;
  return version ? String(version).replace(/^v(?=\d)/i, '') : null;
}

module.exports = { parseSha256File, isPrereleaseVersion, fetchRelease, parseRelease, sha256For, findDevJar, versionFromJarName, installedVersion };
