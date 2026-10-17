'use strict';
// Source du jar ATTACK Client : dernière release GitHub (avec SHA-256), ou, en mode développeur,
// le dernier jar compilé localement (build/libs/attack-client-*.jar).
const fs = require('node:fs');
const path = require('node:path');

const JAR_NAME = /^attack-client.*\.jar$/i;
const EXCLUDED = /-(sources|javadoc|dev|deobf)\.jar$/i;
const SHA256 = /\b([0-9a-f]{64})\b/i;

/** Premier hash SHA-256 d'un fichier « .sha256 » (format sha256sum ou hash seul). */
function parseSha256File(text) {
  const match = SHA256.exec(String(text));
  if (!match) throw new Error('Fichier .sha256 sans hash valide');
  return match[1].toLowerCase();
}

/**
 * Extrait le jar d'une release GitHub : { version, name, url, size, sha256, sha256Url }.
 * Le SHA-256 vient du champ `digest` de l'asset (GitHub), sinon d'un asset « <jar>.sha256 » à télécharger.
 */
function parseRelease(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const jar = assets.find((a) => JAR_NAME.test(a.name) && !EXCLUDED.test(a.name));
  if (!jar) throw new Error('La dernière release ne contient pas de jar attack-client');
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

/** Hash d'un jar dans un fichier SHA256SUMS (« hash  nom ») ou .sha256. */
function sha256For(text, jarName) {
  const lines = String(text).split(/\r?\n/);
  const named = lines.find((line) => line.trim().endsWith(jarName) || line.includes(` *${jarName}`));
  return parseSha256File(named || lines.find((l) => SHA256.test(l)) || '');
}

/** Dernier jar attack-client-*.jar d'un dossier (le plus récent), ou null. */
function findDevJar(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const jars = fs
    .readdirSync(dir)
    .filter((name) => JAR_NAME.test(name) && !EXCLUDED.test(name))
    .map((name) => ({ name, file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return jars[0] || null;
}

/** Version lisible depuis un nom de jar : attack-client-2.0.0.jar -> 2.0.0. */
function versionFromJarName(name) {
  const match = /^attack-client-(.+)\.jar$/i.exec(name);
  return match ? match[1] : 'dev';
}

module.exports = { parseSha256File, parseRelease, sha256For, findDevJar, versionFromJarName };
