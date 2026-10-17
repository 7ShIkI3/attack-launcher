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

let server;
let base;
let hits = 0;
const options = { allowedHosts: new Set(['127.0.0.1']), retries: 0 };

test.before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/file') return res.end(BODY);
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
