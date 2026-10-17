'use strict';
// Lecteur ZIP minimal (lecture seule) : suffit pour l'installateur Forge, qu'on ouvre comme une archive
// sans jamais l'exécuter. Gère les entrées stockées (méthode 0) et compressées en deflate (méthode 8).
const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Liste les entrées d'une archive ZIP chargée en mémoire : Map nom -> { method, offset, compressedSize, size }. */
function readEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw new Error('ZIP invalide : répertoire central corrompu');
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    entries.set(name, { name, method, offset, compressedSize, size });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  // l'EOCD fait 22 octets, suivis d'un commentaire de 65 535 octets au plus
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('ZIP invalide : fin de répertoire central introuvable');
}

/** Contenu décompressé d'une entrée (Buffer), ou null si elle n'existe pas. */
function readEntry(buffer, name, entries = readEntries(buffer)) {
  const entry = entries.get(name);
  if (!entry) return null;
  const pos = entry.offset;
  if (buffer.readUInt32LE(pos) !== LOCAL_SIGNATURE) throw new Error(`ZIP invalide : en-tête local de ${name}`);
  const start = pos + 30 + buffer.readUInt16LE(pos + 26) + buffer.readUInt16LE(pos + 28);
  const raw = buffer.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`ZIP : méthode de compression ${entry.method} non gérée (${name})`);
  if (data.length !== entry.size) throw new Error(`ZIP : taille inattendue pour ${name}`);
  return data;
}

module.exports = { readEntries, readEntry };
