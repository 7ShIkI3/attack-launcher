'use strict';
// Lecture des manifestes Mojang : manifeste des versions, JSON de version (jar, bibliothèques, natives), index d'assets.
const { mavenPath } = require('./maven');
const { RESOURCES_URL } = require('./constants');

const SHA1 = /^[0-9a-f]{40}$/;

/** Plateforme au sens Mojang : { name: windows|osx|linux, arch: '64'|'32' }. */
function currentEnv(platform = process.platform, arch = process.arch) {
  const name = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
  return { name, arch: arch === 'ia32' ? '32' : '64', archName: arch === 'ia32' ? 'x86' : 'x86_64' };
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
    if (rule.os) {
      if (rule.os.name && rule.os.name !== env.name) continue;
      // « x86 » désigne le 32 bits chez Mojang
      if (rule.os.arch === 'x86' ? env.arch !== '32' : rule.os.arch && rule.os.arch !== env.archName) continue;
    }
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
  return files;
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
  findVersion,
  rulesAllow,
  libraryDownloads,
  clientDownload,
  loggingDownload,
  assetDownloads,
};
