'use strict';
// Téléchargements vérifiés : hôtes autorisés uniquement, écriture dans un .part puis renommage,
// contrôle du hash (SHA-1, SHA-256 ou SHA-512) avant de garder le fichier.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ALLOWED_HOSTS } = require('./constants');

const USER_AGENT = 'ATTACK-Launcher (+https://github.com/7ShIkI3/attack-launcher)';

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} pour ${url}`);
    this.status = status;
    this.url = url;
  }
}

function assertAllowed(url, allowedHosts = ALLOWED_HOSTS) {
  const parsed = new URL(url);
  const local = parsed.hostname === '127.0.0.1' && allowedHosts.has('127.0.0.1');
  if ((parsed.protocol !== 'https:' && !local) || !allowedHosts.has(parsed.hostname)) {
    throw new Error(`Adresse refusée (hors des sources officielles) : ${url}`);
  }
}

/** fetch qui suit les redirections à la main : chaque adresse est vérifiée AVANT d'être contactée. */
async function fetchChecked(url, headers, allowedHosts, { method = 'GET', body } = {}) {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    assertAllowed(current, allowedHosts);
    const init = { method, headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'manual' };
    if (body !== undefined && method !== 'GET') init.body = body;
    const response = await fetch(current, init);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel();
    current = new URL(location, current).href;
  }
  throw new Error(`Trop de redirections pour ${url}`);
}

/** fetch avec hôtes vérifiés (y compris les redirections) et nouvelles tentatives sur erreur réseau ou 5xx. */
async function request(url, { allowedHosts = ALLOWED_HOSTS, retries = 3, headers = {} } = {}) {
  assertAllowed(url, allowedHosts);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchChecked(url, headers, allowedHosts);
      if (response.ok) return response;
      lastError = new HttpError(response.status, url);
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
      if (error.message?.startsWith('Adresse refusée')) throw error;
      lastError = error;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw lastError;
}

function hashBuffer(buffer, algorithm = 'sha1') {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

async function hashFile(file, algorithm = 'sha1') {
  const hash = crypto.createHash(algorithm);
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Télécharge un petit document en mémoire ; vérifie son SHA-1 si fourni. */
async function fetchBuffer(url, { sha1, ...options } = {}) {
  const response = await request(url, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (sha1 && hashBuffer(buffer) !== sha1.toLowerCase()) throw new Error(`SHA-1 incorrect pour ${url}`);
  return buffer;
}

async function fetchJson(url, options) {
  return JSON.parse((await fetchBuffer(url, options)).toString('utf8'));
}

async function fetchText(url, options) {
  return (await fetchBuffer(url, options)).toString('utf8');
}

/**
 * Télécharge `url` vers `dest`.
 * expect = { sha1 | sha1s: [..] | sha256 | sha512, size } : au moins un hash est exigé, sauf `allowUnverified`.
 * Un fichier déjà présent avec le bon hash n'est pas retéléchargé. Renvoie { skipped, bytes, <algorithme>: hash }.
 */
async function downloadFile(url, dest, expect = {}, options = {}) {
  const { allowUnverified = false, onBytes } = options;
  // le hash le plus fort fourni décide : SHA-512 (Modrinth), SHA-256 (releases GitHub), sinon SHA-1 (Mojang, Maven)
  const algorithm = expect.sha512 ? 'sha512' : expect.sha256 ? 'sha256' : 'sha1';
  const accepted = (expect.sha512 ? [expect.sha512] : expect.sha256 ? [expect.sha256] : expect.sha1s || (expect.sha1 ? [expect.sha1] : []))
    .map((h) => h.toLowerCase());
  if (accepted.length === 0 && !allowUnverified) throw new Error(`Aucun hash connu pour ${url}`);

  if (accepted.length > 0 && fs.existsSync(dest)) {
    const current = await hashFile(dest, algorithm);
    if (accepted.includes(current)) return { skipped: true, bytes: 0, [algorithm]: current };
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const response = await request(url, options);
  const hash = crypto.createHash(algorithm);
  let bytes = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
    onBytes?.(chunk.length);
  });
  try {
    await pipeline(body, fs.createWriteStream(part));
    const digest = hash.digest('hex');
    if (accepted.length > 0 && !accepted.includes(digest)) {
      throw new Error(`${algorithm.toUpperCase()} incorrect pour ${path.basename(dest)} (reçu ${digest})`);
    }
    if (expect.size != null && bytes !== expect.size) {
      throw new Error(`Taille incorrecte pour ${path.basename(dest)} : ${bytes} au lieu de ${expect.size}`);
    }
    await fsp.rename(part, dest);
    return { skipped: false, bytes, [algorithm]: digest };
  } catch (error) {
    await fsp.rm(part, { force: true });
    throw error;
  }
}

/** Exécute fn sur chaque élément avec au plus `limit` tâches en parallèle ; s'arrête à la première erreur. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = null;
  async function worker() {
    while (failed === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = failed || error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed;
  return results;
}

module.exports = {
  HttpError,
  assertAllowed,
  fetchChecked,
  request,
  hashBuffer,
  hashFile,
  fetchBuffer,
  fetchJson,
  fetchText,
  downloadFile,
  pool,
};
