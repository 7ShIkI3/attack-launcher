'use strict';
// Génère les icônes PNG à partir des polygones du logo (aucune dépendance) :
//   build/icon.png (512, exécutable Windows), assets/icon.png (256, fenêtre), assets/profile-icon.png (128, launcher).
// Rendu par sur-échantillonnage 4 × 4 de chaque pixel, puis encodage PNG avec zlib.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { LEFT_BLADE, RIGHT_BLADE, SLASH, COLORS } = require('../src/renderer/logo');

const ROOT = path.join(__dirname, '..');
const SS = 4;

function hex(color) {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t)));
}

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i];
    const yi = poly[i + 1];
    const xj = poly[j];
    const yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function roundedSquare(x, y, size, radius) {
  const cx = Math.max(radius, Math.min(size - radius, x));
  const cy = Math.max(radius, Math.min(size - radius, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 && x >= 0 && y >= 0 && x <= size && y <= size;
}

function render(size, { background = true } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const margin = background ? size * 0.16 : size * 0.04;
  const unit = (size - 2 * margin) / 100;
  // calques dans l'ordre : fond, lame droite, lame gauche, ombre de l'entaille, entaille
  const layers = [
    ...(background
      ? [{
        test: (x, y) => roundedSquare(x, y, size, size * 0.22),
        color: (x, y) => {
          const base = lerp(hex('#18181D'), hex('#09090C'), y / size);
          const d = Math.hypot(x - size / 2, y - size * 0.45) / (size * 0.55);
          return lerp(hex('#3A1414'), base, Math.min(1, d)); // halo rouge discret au centre
        },
        alpha: 1,
      }]
      : []),
    { poly: RIGHT_BLADE, top: COLORS.rightTop, bottom: COLORS.rightBottom, y0: 0, y1: 100 },
    { poly: LEFT_BLADE, top: COLORS.leftTop, bottom: COLORS.leftBottom, y0: 0, y1: 100 },
    { poly: SLASH, dy: 2.5, flat: [0, 0, 0], alpha: 0.35 },
    { poly: SLASH, top: COLORS.slashTop, bottom: COLORS.slashBottom, y0: 50, y1: 85 },
  ];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const layer of layers) {
        let coverage = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = px + (sx + 0.5) / SS;
            const y = py + (sy + 0.5) / SS;
            let color;
            if (layer.test) {
              if (!layer.test(x, y)) continue;
              color = layer.color(x, y);
            } else {
              const ux = (x - margin) / unit;
              const uy = (y - margin) / unit - (layer.dy || 0);
              if (!inside(layer.poly, ux, uy)) continue;
              color = layer.flat || lerp(hex(layer.top), hex(layer.bottom), (uy - layer.y0) / (layer.y1 - layer.y0));
            }
            coverage++;
            sr += color[0];
            sg += color[1];
            sb += color[2];
          }
        }
        if (coverage === 0) continue;
        const sa = (coverage / (SS * SS)) * (layer.alpha ?? 1);
        const outA = sa + a * (1 - sa);
        r = ((sr / coverage) * sa + r * a * (1 - sa)) / outA;
        g = ((sg / coverage) * sa + g * a * (1 - sa)) / outA;
        b = ((sb / coverage) * sa + b * a * (1 - sa)) / outA;
        a = outA;
      }
      const i = (py * size + px) * 4;
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // 8 bits par canal
  header.writeUInt8(6, 9); // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (require.main === module) {
  const outputs = [
    ['build/icon.png', 512, true],
    ['assets/icon.png', 256, true],
    ['assets/profile-icon.png', 128, true],
  ];
  for (const [file, size, background] of outputs) {
    const target = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, render(size, { background }));
    console.log(`${file} (${size} px)`);
  }
}

module.exports = { render, encodePng, crc32 };
