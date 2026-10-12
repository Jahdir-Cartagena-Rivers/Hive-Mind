// Draws the app icon (an amber hexagon on a dark tile) as a 512x512 PNG; no image dependencies.
import { deflateSync } from "node:zlib";
import fs from "node:fs";

const size = 512;
const pixels = Buffer.alloc(size * size * 4);
const hexagon = (x, y, radius) => {
  const ax = Math.abs(x - size / 2);
  const ay = Math.abs(y - size / 2);
  return ay <= (radius * Math.sqrt(3)) / 2 && ax * (Math.sqrt(3) / 2) + ay * 0.5 <= (radius * Math.sqrt(3)) / 2;
};
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const outer = hexagon(x, y, 230);
    const inner = hexagon(x, y, 150);
    const core = hexagon(x, y, 70);
    const [r, g, b, a] = core ? [245, 184, 61, 255] : inner ? [14, 17, 23, 255] : outer ? [245, 184, 61, 255] : [0, 0, 0, 0];
    pixels.set([r, g, b, a], i);
  }
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
};
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header.set([8, 6, 0, 0, 0], 8);
fs.mkdirSync("assets", { recursive: true });
fs.writeFileSync(
  "assets/icon.png",
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
);
