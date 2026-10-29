'use strict';
// Lecteur ZIP : plafond de décompression. La taille annoncée par le répertoire central décide avant de décompresser, et la
// décompression s'arrête à cette taille : un petit zip forgé dont la taille déclarée ment ne gonfle pas en mémoire.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { makeZip, declareSize } = require('./helpers');
const { readEntries, readEntry, DEFAULT_MAX_ENTRY } = require('../src/main/zip');

const MIB = 1024 * 1024;

/** Appelle fn en notant les options passées à zlib.inflateRawSync. */
function spyInflate(fn) {
  const real = zlib.inflateRawSync;
  const calls = [];
  zlib.inflateRawSync = (buffer, options) => {
    calls.push(options);
    return real(buffer, options);
  };
  try {
    fn();
  } finally {
    zlib.inflateRawSync = real;
  }
  return calls;
}

test('plafond : une entrée honnête sous la limite est lue comme avant, compressée ou stockée, vide comprise', () => {
  for (const deflate of [true, false]) {
    const zip = makeZip({ 'petit.txt': 'bonjour', 'vide.txt': '', 'gros.bin': Buffer.alloc(300 * 1024, 7) }, { deflate });
    const entries = readEntries(zip);
    assert.equal(readEntry(zip, 'petit.txt', entries, { maxSize: 1024 }).toString(), 'bonjour');
    assert.equal(readEntry(zip, 'vide.txt', entries, { maxSize: 1024 }).length, 0);
    assert.equal(readEntry(zip, 'gros.bin', entries).length, 300 * 1024, 'sans option : plafond par défaut');
  }
  assert.equal(DEFAULT_MAX_ENTRY, 256 * MIB);
});

test('plafond : une taille annoncée au-dessus de la limite de l’appelant est refusée AVANT toute décompression', () => {
  for (const deflate of [true, false]) {
    const zip = makeZip({ 'META-INF/MANIFEST.MF': Buffer.alloc(2 * MIB, 0x41) }, { deflate });
    const calls = spyInflate(() => {
      assert.throws(() => readEntry(zip, 'META-INF/MANIFEST.MF', undefined, { maxSize: MIB }), (error) => error.code === 'ZIP_TOO_BIG' && /plus que la limite/.test(error.message));
    });
    assert.deepEqual(calls, [], 'zlib n’est pas appelé');
    // juste à la limite : accepté
    assert.equal(readEntry(zip, 'META-INF/MANIFEST.MF', undefined, { maxSize: 2 * MIB }).length, 2 * MIB);
  }
});

test('bombe de décompression : une taille annoncée fausse (100 octets) arrête zlib à 100 octets, sans gonfler les 64 Mo réels', () => {
  const zip = makeZip({ 'META-INF/MANIFEST.MF': Buffer.alloc(64 * MIB) }); // 64 Mo de zéros : quelques dizaines de Ko compressés
  assert.ok(zip.length < 256 * 1024, `zip forgé petit (${zip.length} octets)`);
  const lying = declareSize(zip, 100);
  const calls = spyInflate(() => {
    assert.throws(() => readEntry(lying, 'META-INF/MANIFEST.MF', undefined, { maxSize: MIB }), /taille inattendue pour META-INF\/MANIFEST\.MF/);
  });
  assert.deepEqual(calls, [{ maxOutputLength: 100 }], 'la sortie de zlib est plafonnée à la taille annoncée');
  // même chose sans limite choisie par l'appelant : le plafond de zlib suit la taille annoncée
  assert.throws(() => readEntry(lying, 'META-INF/MANIFEST.MF'), /taille inattendue/);
});

test('bombe de décompression : une taille annoncée énorme (4 Go) est refusée par le plafond par défaut', () => {
  const lying = declareSize(makeZip({ 'a.bin': Buffer.alloc(1024) }), 0xffffffff);
  const calls = spyInflate(() => {
    assert.throws(() => readEntry(lying, 'a.bin'), (error) => error.code === 'ZIP_TOO_BIG');
  });
  assert.deepEqual(calls, []);
});

test('taille annoncée trop petite pour une entrée stockée ou trop grande pour une entrée compressée : erreur, jamais de contenu tronqué', () => {
  const stored = declareSize(makeZip({ 'a.txt': 'bonjour' }, { deflate: false }), 3);
  assert.throws(() => readEntry(stored, 'a.txt'), /taille inattendue/);
  const bigger = declareSize(makeZip({ 'a.txt': 'bonjour' }), 50); // annonce plus que la réalité : zlib rend 7 octets, ≠ 50
  assert.throws(() => readEntry(bigger, 'a.txt'), /taille inattendue/);
});

test('installateur Forge : un install_profile.json qui annonce plus de 8 Mo ou un jar universal de plus de 64 Mo est refusé sans décompression', () => {
  const forge = require('../src/main/forge');
  const { FORGE_PROFILE } = require('./helpers');
  const installer = () => makeZip({
    'install_profile.json': JSON.stringify(FORGE_PROFILE),
    [FORGE_PROFILE.install.filePath]: Buffer.from('faux jar universal '.repeat(50)),
  });
  assert.ok(forge.readInstallProfile(installer()).universal.length > 0, 'installateur normal accepté');
  // une seule entrée à la fois : declareSize agit sur un zip à une entrée
  const profileOnly = declareSize(makeZip({ 'install_profile.json': JSON.stringify(FORGE_PROFILE) }), 9 * MIB);
  assert.throws(() => forge.readInstallProfile(profileOnly), (error) => error.code === 'ZIP_TOO_BIG');
  const calls = spyInflate(() => {
    assert.throws(() => forge.readInstallProfile(profileOnly), /plus que la limite/);
  });
  assert.deepEqual(calls, []);
});
