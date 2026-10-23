'use strict';
// Lecture des manifestes Mojang : manifeste des versions, JSON de version (jar, bibliothèques, natives), index d'assets.
const os = require('node:os');
const { mavenPath } = require('./maven');
const { RESOURCES_URL } = require('./constants');

const SHA1 = /^[0-9a-f]{40}$/;

/**
 * Plateforme au sens Mojang : { name: windows|osx|linux, arch: '64'|'32', osVersion }.
 * osVersion (ex. 10.0.26200) sert aux règles `os.version` et `os.versionRange` ; absente, ces règles ne s'appliquent pas.
 */
function currentEnv(platform = process.platform, arch = process.arch, osVersion = os.release()) {
  const name = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
  return { name, arch: arch === 'ia32' ? '32' : '64', archName: arch === 'ia32' ? 'x86' : 'x86_64', osVersion };
}

/** Compare deux versions « 10.0.17134 » numériquement : -1, 0 ou 1. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** La règle d'OS (nom, architecture, version) s'applique-t-elle à cette plateforme ? */
function osMatches(rule, env) {
  if (rule.name && rule.name !== env.name) return false;
  // « x86 » désigne le 32 bits chez Mojang
  if (rule.arch === 'x86' ? env.arch !== '32' : rule.arch && rule.arch !== env.archName) return false;
  if (rule.version) {
    try {
      if (!env.osVersion || !new RegExp(rule.version).test(env.osVersion)) return false;
    } catch {
      return false;
    }
  }
  if (rule.versionRange) {
    const { min, max } = rule.versionRange;
    if (!env.osVersion) return false;
    if (min !== undefined && compareVersions(env.osVersion, min) < 0) return false;
    if (max !== undefined && compareVersions(env.osVersion, max) > 0) return false;
  }
  return true;
}

/** Entrée d'une version dans version_manifest_v2.json (url + sha1 du JSON de version). */
function findVersion(manifest, id) {
  const entry = manifest?.versions?.find((v) => v.id === id);
  if (!entry) throw new Error(`Version ${id} absente du manifeste Mojang`);
  if (!SHA1.test(entry.sha1 || '')) throw new Error(`Hash manquant pour la version ${id}`);
  return entry;
}

/** Règles Mojang : sans règle tout est permis ; sinon la dernière règle qui correspond décide. */
function rulesAllow(rules, env = currentEnv()) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.features) continue; // options du launcher (démo, résolution...) : jamais actives ici
    if (rule.os && !osMatches(rule.os, env)) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

/** Fichiers de bibliothèques (artefacts + natives de la plateforme) : [{ name, path, url, sha1, size }]. */
function libraryDownloads(versionJson, env = currentEnv()) {
  const files = [];
  for (const lib of versionJson.libraries || []) {
    if (!rulesAllow(lib.rules, env)) continue;
    const downloads = lib.downloads || {};
    if (downloads.artifact) files.push(artifactFile(lib.name, downloads.artifact));
    const nativeKey = lib.natives?.[env.name];
    if (nativeKey) {
      const classifier = nativeKey.replace('${arch}', env.arch);
      const native = downloads.classifiers?.[classifier];
      if (!native) throw new Error(`Natives ${classifier} introuvables pour ${lib.name}`);
      files.push(artifactFile(lib.name, native, classifier));
    }
  }
  // un même fichier cité deux fois serait téléchargé par deux tâches en parallèle dans le même .part
  const seen = new Set();
  return files.filter((file) => !seen.has(file.path) && seen.add(file.path));
}

function artifactFile(name, artifact, classifier) {
  if (!SHA1.test(artifact.sha1 || '')) throw new Error(`Hash manquant pour ${name}`);
  const expected = mavenPath(name, classifier);
  const relPath = artifact.path || expected;
  if (relPath !== expected) throw new Error(`Chemin inattendu pour ${name} : ${relPath}`);
  return { name, path: relPath, url: artifact.url, sha1: artifact.sha1, size: artifact.size };
}

/** Jar client : versions/<id>/<id>.jar. */
function clientDownload(versionJson) {
  const client = versionJson.downloads?.client;
  if (!client || !SHA1.test(client.sha1 || '')) throw new Error('Jar client absent du JSON de version');
  const id = versionJson.id;
  return { path: `versions/${id}/${id}.jar`, url: client.url, sha1: client.sha1, size: client.size };
}

/** Configuration log4j fournie par Mojang (assets/log_configs/<id>), si présente. */
function loggingDownload(versionJson) {
  const file = versionJson.logging?.client?.file;
  if (!file) return null;
  if (!SHA1.test(file.sha1 || '') || !/^[\w.-]+$/.test(file.id)) throw new Error('Configuration log4j invalide');
  return { path: `assets/log_configs/${file.id}`, url: file.url, sha1: file.sha1, size: file.size };
}

/** Objets d'un index d'assets : [{ path: 'objects/ab/abcd…', url, sha1, size }], sans doublon. */
function assetDownloads(assetIndex) {
  const seen = new Map();
  for (const object of Object.values(assetIndex?.objects || {})) {
    const hash = String(object.hash || '').toLowerCase();
    if (!SHA1.test(hash)) throw new Error(`Hash d'asset invalide : ${object.hash}`);
    if (seen.has(hash)) continue;
    const rel = `${hash.slice(0, 2)}/${hash}`;
    seen.set(hash, { path: `objects/${rel}`, url: RESOURCES_URL + rel, sha1: hash, size: object.size });
  }
  return [...seen.values()];
}

module.exports = {
  currentEnv,
  compareVersions,
  findVersion,
  rulesAllow,
  libraryDownloads,
  clientDownload,
  loggingDownload,
  assetDownloads,
};
