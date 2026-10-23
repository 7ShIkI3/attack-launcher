'use strict';
// Téléchargements vérifiés, contre un petit serveur local (127.0.0.1 autorisé seulement dans ce test).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('./helpers');
const net = require('../src/main/http');

const BODY = Buffer.from('contenu du fichier de test '.repeat(100));
const SHA1 = crypto.createHash('sha1').update(BODY).digest('hex');
const SHA256 = crypto.createHash('sha256').update(BODY).digest('hex');
const SHA512 = crypto.createHash('sha512').update(BODY).digest('hex');

let server;
let base;
let hits = 0;
let flaky = 0;
const options = { allowedHosts: new Set(['127.0.0.1']), retries: 0 };

test.before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/file') return res.end(BODY);
    if (req.url === '/flaky') {
      // une fois sur deux, la connexion casse au milieu du corps
      flaky++;
      if (flaky % 2 === 1) {
        res.writeHead(200, { 'Content-Length': BODY.length });
        res.write(BODY.subarray(0, 100));
        return setTimeout(() => res.socket.destroy(), 10);
      }
      return res.end(BODY);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'https://evil.example/file' });
      return res.end();
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('seuls les hôtes officiels en HTTPS sont acceptés', () => {
  assert.doesNotThrow(() => net.assertAllowed('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
  assert.doesNotThrow(() => net.assertAllowed('https://maven.minecraftforge.net/net/x.jar'));
  assert.throws(() => net.assertAllowed('http://maven.minecraftforge.net/net/x.jar'), /refusée/);
  assert.throws(() => net.assertAllowed('https://evil.example/x.jar'), /refusée/);
  assert.throws(() => net.assertAllowed('https://maven.minecraftforge.net.evil.example/x.jar'), /refusée/);
});

test('téléchargement vérifié (SHA-1, taille), puis fichier existant non retéléchargé', async () => {
  const dir = tempDir();
  const dest = path.join(dir, 'a', 'b.jar');
  const first = await net.downloadFile(`${base}/file`, dest, { sha1: SHA1, size: BODY.length }, options);
  assert.equal(first.skipped, false);
  assert.deepEqual(fs.readFileSync(dest), BODY);
  const before = hits;
  const second = await net.downloadFile(`${base}/file`, dest, { sha1s: ['0'.repeat(40), SHA1] }, options);
  assert.equal(second.skipped, true);
  assert.equal(hits, before);
  const sha256 = await net.downloadFile(`${base}/file`, path.join(dir, 'c.jar'), { sha256: SHA256 }, options);
  assert.equal(sha256.sha256, SHA256);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('téléchargement vérifié par SHA-512 (Modrinth) : le plus fort hash fourni décide', async () => {
  const dir = tempDir();
  const dest = path.join(dir, 'mod.jar');
  assert.equal(SHA512.length, 128);
  const first = await net.downloadFile(`${base}/file`, dest, { sha512: SHA512, size: BODY.length }, options);
  assert.equal(first.skipped, false);
  assert.equal(first.sha512, SHA512);
  assert.deepEqual(fs.readFileSync(dest), BODY);
  // déjà présent avec le bon SHA-512 : pas de nouveau téléchargement
  const before = hits;
  const second = await net.downloadFile(`${base}/file`, dest, { sha512: SHA512.toUpperCase() }, options);
  assert.equal(second.skipped, true);
  assert.equal(hits, before);
  // SHA-512 faux : rejeté même si le SHA-1 fourni est juste (le plus fort décide), et aucun fichier ne reste
  const bad = path.join(dir, 'bad.jar');
  await assert.rejects(net.downloadFile(`${base}/file`, bad, { sha512: 'f'.repeat(128), sha1: SHA1 }, options), /SHA512 incorrect/);
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.existsSync(`${bad}.part`), false);
  // taille fausse : rejetée aussi
  await assert.rejects(net.downloadFile(`${base}/file`, bad, { sha512: SHA512, size: BODY.length + 1 }, options), /Taille incorrecte/);
  assert.equal(fs.existsSync(bad), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hash faux : fichier rejeté et .part supprimé', async () => {
  const dir = tempDir();
  const dest = path.join(dir, 'x.jar');
  await assert.rejects(net.downloadFile(`${base}/file`, dest, { sha1: 'f'.repeat(40) }, options), /SHA1 incorrect/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  await assert.rejects(net.downloadFile(`${base}/file`, dest, {}, options), /Aucun hash/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('erreur 404 remontée avec son statut ; redirection hors liste refusée', async () => {
  await assert.rejects(net.fetchJson(`${base}/absent`, options), (error) => error.status === 404);
  await assert.rejects(net.fetchBuffer(`${base}/redirect`, options), /refusée/);
});

test('pool : limite de parallélisme respectée et première erreur remontée', async () => {
  let running = 0;
  let peak = 0;
  const results = await net.pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
  await assert.rejects(net.pool([1, 2], 2, async (n) => {
    if (n === 2) throw new Error('boum');
  }), /boum/);
});

test('pool : limite absente ou invalide = une tâche à la fois, sans rien sauter', async () => {
  for (const limit of [undefined, 0, NaN, 'x']) {
    const results = await net.pool([1, 2, 3], limit, async (n) => n + 1);
    assert.deepEqual(results, [2, 3, 4]);
  }
});

test('connexion coupée pendant le transfert : nouvelle tentative ; hash faux : jamais retenté', async () => {
  const dir = tempDir();
  const dest = path.join(dir, 'flaky.jar');
  flaky = 0;
  await assert.rejects(net.downloadFile(`${base}/flaky`, dest, { sha1: SHA1 }, options));
  assert.equal(fs.existsSync(`${dest}.part`), false);
  flaky = 0;
  const result = await net.downloadFile(`${base}/flaky`, dest, { sha1: SHA1, size: BODY.length }, { ...options, retries: 1 });
  assert.equal(result.skipped, false);
  assert.deepEqual(fs.readFileSync(dest), BODY);
  flaky = 0;
  assert.deepEqual(await net.fetchBuffer(`${base}/flaky`, { ...options, retries: 1 }), BODY);
  const before = hits;
  await assert.rejects(net.downloadFile(`${base}/file`, path.join(dir, 'bad.jar'), { sha1: 'f'.repeat(40) }, { ...options, retries: 2 }), /SHA1 incorrect/);
  assert.equal(hits - before, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('écriture atomique : contenu remplacé, aucun fichier temporaire laissé', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'v.json');
  fs.writeFileSync(file, 'ancien');
  await net.writeFileAtomic(file, Buffer.from('{"id":"neuf"}'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"id":"neuf"}');
  assert.deepEqual(fs.readdirSync(dir), ['v.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
