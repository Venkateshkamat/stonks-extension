// Generates media/icon.png (256x256): a green up-trend line on a dark rounded square.
// Pure Node, no dependencies:  node scripts/make-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // supersampling per axis (anti-aliasing)
const RADIUS = 56;

const BG_TOP = [17, 24, 39];
const BG_BOTTOM = [8, 12, 22];
const GREEN = [34, 197, 94];
const GREEN_LIGHT = [74, 222, 128];
const GRID = [255, 255, 255];

// The trend line, in pixel coordinates.
const PTS = [
  [38, 176],
  [86, 130],
  [120, 154],
  [170, 92],
  [214, 62],
];
const LINE_W = 18;
const DOT_R = 15;

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** y of the polyline at x (for the soft fill under the line), or null outside its x range. */
function lineY(x) {
  for (let i = 0; i < PTS.length - 1; i++) {
    const [x0, y0] = PTS[i];
    const [x1, y1] = PTS[i + 1];
    if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return null;
}

function insideRounded(x, y) {
  const cx = Math.max(RADIUS, Math.min(SIZE - RADIUS, x));
  const cy = Math.max(RADIUS, Math.min(SIZE - RADIUS, y));
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

/** RGBA of one sample point (x, y in pixel units). */
function sample(x, y) {
  if (!insideRounded(x, y)) return [0, 0, 0, 0];
  let c = mix(BG_TOP, BG_BOTTOM, y / SIZE);
  // faint horizontal grid lines
  for (const gy of [64, 112, 160, 208]) {
    if (Math.abs(y - gy) < 0.9 && x > 30 && x < 226) c = mix(c, GRID, 0.07);
  }
  // soft fill under the line
  const ly = lineY(x);
  if (ly !== null && y > ly && y < 214) {
    const k = 0.22 * (1 - (y - ly) / (214 - ly));
    c = mix(c, GREEN, k);
  }
  // the line itself and the end dot
  let d = Infinity;
  for (let i = 0; i < PTS.length - 1; i++) d = Math.min(d, distToSegment(x, y, PTS[i], PTS[i + 1]));
  const end = PTS[PTS.length - 1];
  if (d <= LINE_W / 2) c = mix(GREEN, GREEN_LIGHT, Math.max(0, Math.min(1, (SIZE - y) / SIZE)));
  if (Math.hypot(x - end[0], y - end[1]) <= DOT_R) c = GREEN_LIGHT;
  return [c[0], c[1], c[2], 255];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const s = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += s[0] * s[3];
        g += s[1] * s[3];
        b += s[2] * s[3];
        a += s[3];
      }
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (a > 0) {
      raw[o] = Math.round(r / a);
      raw[o + 1] = Math.round(g / a);
      raw[o + 2] = Math.round(b / a);
      raw[o + 3] = Math.round(a / (SS * SS));
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
