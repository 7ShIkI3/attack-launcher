'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const skins = require('../src/main/skins');

/** PNG minimal valide (RGBA, pixels transparents) de la taille demandee. */
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fakeTransport(responses) {
  const calls = [];
  const transport = async (method, url, options = {}) => {
    calls.push({ method, url, options });
    const next = responses.shift();
    if (!next) throw new Error(`appel inattendu ${method} ${url}`);
    return next;
  };
  return { transport, calls };
}

const PROFILE = (variant = 'SLIM', url = 'http://textures.minecraft.net/texture/abc') => ({
  status: 200,
  data: { id: 'a'.repeat(32), name: 'Alice', skins: [{ id: '1', state: 'ACTIVE', url, variant }] },
});

test('checkSkinPng : 64x64 et 64x32 acceptes, le reste refuse avec un message clair', () => {
  assert.deepEqual(skins.checkSkinPng(png(64, 64)), { width: 64, height: 64 });
  assert.deepEqual(skins.checkSkinPng(png(64, 32)), { width: 64, height: 32 });
  assert.throws(() => skins.checkSkinPng(png(128, 128)), (e) => e.code === 'BAD_SIZE' && /128 x 128/.test(e.message));
  assert.throws(() => skins.checkSkinPng(Buffer.from('GIF89a pas un png du tout....................')), { code: 'NOT_PNG' });
  assert.throws(() => skins.checkSkinPng(Buffer.concat([png(64, 64), Buffer.alloc(skins.MAX_BYTES)])), { code: 'TOO_BIG' });
  assert.throws(() => skins.checkSkinPng('pas un buffer'), { code: 'NOT_PNG' });
});

test('activeSkin : skin actif en https, modele classique ou fin', () => {
  assert.deepEqual(skins.activeSkin(PROFILE().data), { url: 'https://textures.minecraft.net/texture/abc', variant: 'slim' });
  assert.equal(skins.activeSkin(PROFILE('CLASSIC').data).variant, 'classic');
  assert.equal(skins.activeSkin({ skins: [] }), null);
  assert.equal(skins.activeSkin(null), null);
});

test('multipartBody : champ variant puis fichier PNG, bien delimites', () => {
  const data = png(64, 64);
  const { body, contentType } = skins.multipartBody({
    fields: { variant: 'slim' },
    file: { name: 'file', filename: 'skin.png', contentType: 'image/png', data },
  }, 'XYZ');
  assert.equal(contentType, 'multipart/form-data; boundary=XYZ');
  const text = body.toString('latin1');
  assert.match(text, /^--XYZ\r\nContent-Disposition: form-data; name="variant"\r\n\r\nslim\r\n--XYZ\r\n/);
  assert.match(text, /name="file"; filename="skin.png"\r\nContent-Type: image\/png\r\n\r\n/);
  assert.ok(text.endsWith('\r\n--XYZ--\r\n'));
  assert.ok(body.includes(data), 'le PNG est copie tel quel');
});

test('uploadSkin : POST multipart avec le jeton, renvoie le nouveau skin', async () => {
  const { transport, calls } = fakeTransport([PROFILE('SLIM', 'http://textures.minecraft.net/texture/new')]);
  const skin = await skins.uploadSkin(transport, 'jeton-mc', png(64, 64), 'slim');
  assert.deepEqual(skin, { url: 'https://textures.minecraft.net/texture/new', variant: 'slim' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.minecraftservices.com/minecraft/profile/skins');
  assert.equal(calls[0].options.bearer, 'jeton-mc');
  assert.deepEqual(calls[0].options.multipart.fields, { variant: 'slim' });
});

test('uploadSkin : refuse avant tout envoi une image ou un modele invalides', async () => {
  const { transport, calls } = fakeTransport([]);
  await assert.rejects(skins.uploadSkin(transport, 'j', png(32, 32), 'classic'), { code: 'BAD_SIZE' });
  await assert.rejects(skins.uploadSkin(transport, 'j', png(64, 64), 'geant'), { code: 'BAD_VARIANT' });
  assert.equal(calls.length, 0);
});

test('erreurs Mojang traduites : 401 expire, 429 trop de changements, 400 refuse', async () => {
  for (const [status, code] of [[401, 'SESSION_EXPIRED'], [429, 'RATE_LIMITED'], [400, 'REFUSED'], [500, 'MOJANG']]) {
    const { transport } = fakeTransport([{ status, data: { errorMessage: 'Invalid skin' } }]);
    await assert.rejects(skins.uploadSkin(transport, 'j', png(64, 64), 'classic'), { code });
  }
});

test('resetSkin : DELETE du skin actif ; readSkin : GET du profil', async () => {
  const { transport, calls } = fakeTransport([PROFILE('CLASSIC'), PROFILE('SLIM')]);
  assert.equal((await skins.resetSkin(transport, 'j')).variant, 'classic');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.minecraftservices.com/minecraft/profile/skins/active');
  assert.equal((await skins.readSkin(transport, 'j')).variant, 'slim');
  assert.equal(calls[1].method, 'GET');
});
