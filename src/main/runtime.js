'use strict';
// Runtime Java officiel de Mojang (composant « jre-legacy » = Java 8 pour la 1.8.9), installé fichier par fichier
// depuis le manifeste du launcher officiel, chaque fichier vérifié par SHA-1.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('./http');
const { JAVA_RUNTIME_MANIFEST } = require('./constants');
const { safeJoin } = require('./maven');

const SHA1 = /^[0-9a-f]{40}$/;
const MARKER = '.attack-runtime.json';

/** Clé de plateforme du manifeste Mojang. */
function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'windows-x86' : arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return arch === 'ia32' ? 'linux-i386' : 'linux';
}

/** Repli quand Mojang ne publie pas le composant pour cette plateforme (ex. jre-legacy absent sur ARM). */
const FALLBACK = { 'windows-arm64': 'windows-x64', 'mac-os-arm64': 'mac-os' };

/** Choisit l'entrée du runtime : { key, version, manifest: { url, sha1, size } }. */
function selectRuntime(all, component, key = platformKey()) {
  for (const candidate of [key, FALLBACK[key]].filter(Boolean)) {
    const entry = all?.[candidate]?.[component]?.[0];
    if (entry?.manifest && SHA1.test(entry.manifest.sha1 || '')) {
      return { key: candidate, version: entry.version?.name || 'inconnue', manifest: entry.manifest };
    }
  }
  throw new Error(`Runtime Java ${component} indisponible pour ${key}`);
}

/** Fichiers d'un manifeste de runtime : { files: [{ path, url, sha1, size, executable }], dirs: [] }. */
function runtimeFiles(manifest) {
  const files = [];
  const dirs = [];
  for (const [rel, entry] of Object.entries(manifest?.files || {})) {
    if (rel.startsWith('/') || rel.split('/').includes('..') || /^[A-Za-z]:/.test(rel)) throw new Error(`Chemin de runtime suspect : ${rel}`);
    if (entry.type === 'directory') dirs.push(rel);
    else if (entry.type === 'file') {
      const raw = entry.downloads?.raw;
      if (!raw || !SHA1.test(raw.sha1 || '')) throw new Error(`Hash manquant pour ${rel}`);
      files.push({ path: rel, url: raw.url, sha1: raw.sha1, size: raw.size, executable: Boolean(entry.executable) });
    }
    // les liens symboliques (Linux / macOS) ne concernent pas Windows
  }
  return { files, dirs };
}

function javaExecutable(root, platform = process.platform) {
  return path.join(root, 'bin', platform === 'win32' ? 'javaw.exe' : 'java');
}

/**
 * Installe (ou vérifie) le runtime dans <runtimeDir>/<component>/<clé> et renvoie le chemin de javaw.exe.
 * onProgress({ done, total }) pendant les téléchargements.
 */
/** Runtime déjà installé (marqueur écrit après vérification de chaque fichier), sans réseau ; null s'il n'y en a pas. */
async function installedRuntime(runtimeDir, component, key, platform) {
  for (const candidate of [key, FALLBACK[key]].filter(Boolean)) {
    const root = path.join(runtimeDir, component, candidate);
    const java = javaExecutable(root, platform);
    try {
      const marker = JSON.parse(await fsp.readFile(path.join(root, MARKER), 'utf8'));
      if (marker.component === component && fs.existsSync(java)) return { java, root, version: marker.version, cached: true, offline: true };
    } catch {
      // pas installé pour cette clé
    }
  }
  return null;
}

async function installRuntime({ runtimeDir, component = 'jre-legacy', onProgress, net = {}, platform = process.platform, arch = process.arch }) {
  let all;
  try {
    all = await http.fetchJson(JAVA_RUNTIME_MANIFEST, net);
  } catch (error) {
    // hors ligne ou Mojang injoignable : un runtime déjà installé suffit pour jouer
    const installed = await installedRuntime(runtimeDir, component, platformKey(platform, arch), platform);
    if (installed) return installed;
    throw error;
  }
  const selected = selectRuntime(all, component, platformKey(platform, arch));
  const root = path.join(runtimeDir, component, selected.key);
  const java = javaExecutable(root, platform);
  const markerFile = path.join(root, MARKER);
  try {
    const marker = JSON.parse(await fsp.readFile(markerFile, 'utf8'));
    if (marker.manifestSha1 === selected.manifest.sha1 && fs.existsSync(java)) return { java, root, version: selected.version, cached: true };
  } catch {
    // pas encore installé
  }
  const manifest = await http.fetchJson(selected.manifest.url, { ...net, sha1: selected.manifest.sha1 });
  const { files, dirs } = runtimeFiles(manifest);
  for (const dir of dirs) await fsp.mkdir(safeJoin(root, dir), { recursive: true });
  let done = 0;
  onProgress?.({ done, total: files.length });
  await http.pool(files, net.concurrency || 8, async (file) => {
    const dest = safeJoin(root, file.path);
    await http.downloadFile(file.url, dest, file, net);
    if (file.executable && platform !== 'win32') await fsp.chmod(dest, 0o755);
    onProgress?.({ done: ++done, total: files.length });
  });
  if (!fs.existsSync(java)) throw new Error('Runtime Java incomplet : exécutable introuvable');
  await fsp.writeFile(markerFile, JSON.stringify({ component, key: selected.key, version: selected.version, manifestSha1: selected.manifest.sha1 }));
  return { java, root, version: selected.version, cached: false };
}

module.exports = { platformKey, selectRuntime, runtimeFiles, javaExecutable, installedRuntime, installRuntime };
