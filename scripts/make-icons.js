// Tạo icon PNG cho PWA (không cần thư viện ngoài, dùng zlib có sẵn của Node)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const r = size * 0.36; // bán kính bong bóng chat
  const set = (x, y, r_, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r_; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // nền bo góc màu xanh Messenger
      const rad = size * 0.22;
      const inRound =
        (x >= rad && x < size - rad) || (y >= rad && y < size - rad) ||
        ((x - rad) ** 2 + (y - rad) ** 2 < rad * rad) ||
        ((x - (size - rad)) ** 2 + (y - rad) ** 2 < rad * rad) ||
        ((x - rad) ** 2 + (y - (size - rad)) ** 2 < rad * rad) ||
        ((x - (size - rad)) ** 2 + (y - (size - rad)) ** 2 < rad * rad);
      if (!inRound) { set(x, y, 0, 0, 0, 0); continue; }
      set(x, y, 0, 132, 255, 255);
      // bong bóng chat trắng
      const dx = x - cx, dy = y - cy;
      const inBubble = dx * dx + dy * dy < r * r;
      // đuôi bong bóng
      const inTail = x > cx - r * 0.25 && x < cx + r * 0.35 &&
                     y > cy + r * 0.45 && y < cy + r * 1.05 &&
                     (x - cx) < (y - cy) * 0.9;
      if (inBubble || inTail) set(x, y, 255, 255, 255, 255);
      // 3 chấm xanh trong bong bóng
      for (const ox of [-r * 0.42, 0, r * 0.42]) {
        const ddx = x - (cx + ox), ddy = y - cy;
        if (ddx * ddx + ddy * ddy < (r * 0.13) ** 2) set(x, y, 0, 132, 255, 255);
      }
    }
  }
  // encode PNG
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    buf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? 0 : 0); // placeholder
    // CRC32 tự triển khai cho chắc chắn
    crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

// CRC32 (IEEE)
const _table = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${s}.png`), makeIcon(s));
  console.log(`icon-${s}.png OK`);
}
