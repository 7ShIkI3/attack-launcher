'use strict';
// Outils de test : archive ZIP construite en mémoire et dossiers temporaires.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { crc32 } = require('../scripts/make-icons');

/** ZIP minimal valide : entries = { nom: Buffer|string } ; deflate = true pour compresser. */
function makeZip(entries, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function tempDir(prefix = 'attack-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Extrait réduit de l'install_profile.json réel de Forge 1.8.9-11.15.1.2318. */
const FORGE_PROFILE = {
  install: {
    profileName: 'forge',
    target: '1.8.9-forge1.8.9-11.15.1.2318-1.8.9',
    path: 'net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9',
    version: 'forge 1.8.9-11.15.1.2318-1.8.9',
    filePath: 'forge-1.8.9-11.15.1.2318-1.8.9-universal.jar',
    minecraft: '1.8.9',
  },
  versionInfo: {
    id: '1.8.9-forge1.8.9-11.15.1.2318-1.8.9',
    type: 'release',
    minecraftArguments: '--username ${auth_player_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker',
    mainClass: 'net.minecraft.launchwrapper.Launch',
    inheritsFrom: '1.8.9',
    jar: '1.8.9',
    assets: '1.8',
    libraries: [
      { name: 'net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9', url: 'https://maven.minecraftforge.net/' },
      { name: 'net.minecraft:launchwrapper:1.12', serverreq: true },
      { name: 'jline:jline:2.13', url: 'https://maven.minecraftforge.net/', checksums: ['2d9530d0a25daffaffda7c35037b046b627bb171'], serverreq: true, clientreq: false },
      { name: 'org.scala-lang:scala-library:2.11.1', url: 'https://maven.minecraftforge.net/', checksums: ['0e11da23da3eabab9f4777b9220e60d44c1aab6a', '1e4df76e835201c6eabd43adca89ab11f225f134'], serverreq: true, clientreq: true },
      { name: 'org.scala-lang.plugins:scala-continuations-plugin_2.11.1:1.0.2', url: 'http://files.minecraftforge.net/maven/', serverreq: true, clientreq: true },
    ],
  },
};

module.exports = { makeZip, tempDir, FORGE_PROFILE };
