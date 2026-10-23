// ChatDango のアイコン(吹き出しの中に三色団子)を依存なしで描いて icon.ico にする。node make-icon.js
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const SS = 4;
// 団子の3色(ピンク・黄・緑)。吹き出しの中に横並び
const balls = [[9.4, 13.4, 3.5, [244, 114, 182]], [16, 13.4, 3.5, [251, 191, 36]], [22.6, 13.4, 3.5, [6, 199, 85]]];
const inRR = (x, y, x0, y0, x1, y1, r) => { const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => { const d = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry); const d1 = d(x, y, ax, ay, bx, by), d2 = d(x, y, bx, by, cx, cy), d3 = d(x, y, cx, cy, ax, ay); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
const inBubble = (x, y) => inRR(x, y, 2, 3.5, 30, 23.5, 8) || inTri(x, y, [6, 21], [5.5, 30], [14.5, 22.5]);
const mix = (c, d, t) => c.map((v, i) => v + (d[i] - v) * t);
const shade = (col, x, y, cx, cy, r) => { // 左上からの光で球に見せる
  const dx = (x - cx) / r, dy = (y - cy) / r, l = Math.max(0, 1 - Math.hypot(dx + .35, dy + .4) / 1.5);
  let c = mix(col.map(v => v * .66), col, Math.min(1, l * 1.25));
  const sp = Math.max(0, 1 - Math.hypot(dx + .38, dy + .42) / .38);
  return mix(c, [255, 255, 255], sp * .7);
};
const px = (x, y) => { // 1サンプルの色(透明は null)
  if (!inRR(x, y, 0, 0, 32, 32, 7.5)) return null;
  let c = mix([30, 27, 75], [8, 12, 28], Math.min(1, (x + y) / 52)); // 斜めのグラデーション
  c = mix(c, [99, 102, 241], Math.max(0, 1 - Math.hypot(x - 6, y - 3) / 18) * .5); // 左上の光
  const ring = Math.min(x, y, 32 - x, 32 - y); if (ring < .9) c = mix(c, [255, 255, 255], .2 * (1 - ring / .9)); // 縁の光
  if (inBubble(x + .5, y + 1.2) && !inBubble(x, y)) c = mix(c, [0, 0, 0], .3); // 吹き出しの影
  if (inBubble(x, y)) {
    c = mix([255, 255, 255], [201, 211, 240], Math.max(0, Math.min(1, (y - 3.5) / 22))); // 上が白・下がほんのり青のガラス
    if (!inRR(x + .7, y + .7, 2, 3.5, 30, 23.5, 8) && y < 23) c = mix(c, [150, 160, 220], .35); // 縁のかげ
    if (inRR(x, y, 2, 3.5, 30, 23.5, 8) && y < 7.5 && x > 8 && x < 24) c = mix(c, [255, 255, 255], .6 * (1 - (y - 3.5) / 4)); // 上端のつや
  }
  for (const [cx, cy, r, col] of balls) {
    const sh = Math.hypot(x - cx - .3, y - cy - .7); if (sh <= r + .8 && sh > r) c = mix(c, [60, 60, 120], .25 * (1 - (sh - r) / .8));
    if (Math.hypot(x - cx, y - cy) <= r) c = shade(col, x, y, cx, cy, r);
  }
  return c;
};
const render = N => { const K = N / 32;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let j = 0; j < N; j++) {
  raw[j * (N * 4 + 1)] = 0;
  for (let i = 0; i < N; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) { const c = px((i + (sx + .5) / SS) / K, (j + (sy + .5) / SS) / K); if (c) { r += c[0]; g += c[1]; b += c[2]; a++; } }
    const o = j * (N * 4 + 1) + 1 + i * 4, t = SS * SS;
    raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = Math.round(255 * a / t);
  }
}
  return raw; };
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const pngOf = N => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(render(N))), chunk('IEND', Buffer.alloc(0))]); };
const sizes = [16, 24, 32, 48, 64, 128, 256], pngs = sizes.map(pngOf); // 小さい表示でもくっきり見えるよう、サイズごとに描き直す
const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length; sizes.forEach((n, i) => { const o = 6 + i * 16; head[o] = n === 256 ? 0 : n; head[o + 1] = n === 256 ? 0 : n; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(pngs[i].length, o + 8); head.writeUInt32LE(off, o + 12); off += pngs[i].length; });
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([head, ...pngs]));
console.log('icon.ico', off, 'bytes,', sizes.join('/'));
