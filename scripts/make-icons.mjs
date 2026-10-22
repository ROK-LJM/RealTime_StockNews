// pages/scripts/make-icons.mjs — 홈 화면 아이콘(PNG) 만들기. 외부 라이브러리 없이 로고 도형을 직접 그려 PNG로 저장한다.
// 로고(docs/favicon.svg와 같은 모양): 32×32 칸, 어두운 둥근 사각형 + ▲ 빨강(상승) · ▼ 파랑(하락), 모서리는 선 굵기 1.4만큼 둥글게.
// 실행: node scripts/make-icons.mjs  (pages 폴더에서) → docs/icon-180.png · icon-192.png · icon-512.png · icon-maskable-512.png
//  · icon-180: 아이폰 '홈 화면에 추가'용 — 바탕을 꽉 채운 정사각형(아이폰이 모서리를 알아서 둥글린다)
//  · icon-192 · icon-512: 안드로이드·브라우저용 — 둥근 사각형, 바깥은 투명
//  · icon-maskable-512: 안드로이드 모양 맞춤용 — 바탕을 꽉 채우고 도형을 안전 영역(가운데 원) 안으로 줄임
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const BG = [0x16, 0x18, 0x1d], UP = [0xf2, 0x38, 0x4f], DOWN = [0x3d, 0x86, 0xff];
const TRI_UP = [[4.5, 20.5], [11, 8.5], [17.5, 20.5]];
const TRI_DOWN = [[14.5, 11.5], [27.5, 11.5], [21, 23.5]];
const ROUND = 0.7; // 선 굵기 1.4의 절반 — 삼각형 꼭짓점을 둥글게(민코프스키 합)

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inTriangle(px, py, [a, b, c]) {
  const s = (p, q) => (px - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (py - q[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
const inShape = (px, py, tri) => inTriangle(px, py, tri) || segDist(px, py, tri[0], tri[1]) <= ROUND
  || segDist(px, py, tri[1], tri[2]) <= ROUND || segDist(px, py, tri[2], tri[0]) <= ROUND;
function inRoundRect(px, py, r) { // 0~32 칸, 모서리 반지름 r
  const cx = Math.min(Math.max(px, r), 32 - r), cy = Math.min(Math.max(py, r), 32 - r);
  return px >= 0 && px <= 32 && py >= 0 && py <= 32 && Math.hypot(px - cx, py - cy) <= r;
}

// size: 픽셀 크기, full: 바탕을 꽉 채움(투명 모서리 없음), glyph: 도형 배율(가운데 기준)
function render(size, { full = false, glyph = 1 } = {}) {
  const N = 4; // 한 픽셀에 4×4 표본 — 가장자리 부드럽게
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
      const ux = ((x + (sx + 0.5) / N) / size) * 32, uy = ((y + (sy + 0.5) / N) / size) * 32;
      const gx = 16 + (ux - 16) / glyph, gy = 16 + (uy - 16) / glyph; // 도형 좌표(줄이면 가운데로 모임)
      let c = null;
      if (full || inRoundRect(ux, uy, 8)) c = BG;
      if (c) { if (inShape(gx, gy, TRI_DOWN)) c = DOWN; if (inShape(gx, gy, TRI_UP)) c = UP; }
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
    }
    const i = (y * size + x) * 4;
    if (a) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a); }
    px[i + 3] = Math.round((a / (N * N)) * 255);
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8비트 RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, opts] of [
  ['icon-180.png', 180, { full: true }],
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { full: true, glyph: 0.82 }],
]) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, png(size, render(size, opts)));
  console.log(`  ✓ docs/${name} (${size}×${size}, ${fs.statSync(file).size.toLocaleString()} bytes)`);
}
