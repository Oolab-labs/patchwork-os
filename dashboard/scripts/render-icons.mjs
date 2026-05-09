import sharp from "sharp";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const svg = readFileSync("/tmp/icon-master.svg");
const outDir = resolve(process.cwd(), "public/icons");

const targets = [
  { size: 192, file: "icon-192.png" },
  { size: 512, file: "icon-512.png" },
  { size: 180, file: "apple-touch-icon.png" },
  { size: 192, file: "icon-192-maskable.png", maskable: true },
  { size: 512, file: "icon-512-maskable.png", maskable: true },
];

for (const t of targets) {
  if (t.maskable) {
    // Maskable variant: render the SVG centered into a larger canvas
    // so the safe-area padding is included. Android masks may crop
    // 10–20% from each edge.
    const padded = await sharp(svg)
      .resize(Math.round(t.size * 0.7), Math.round(t.size * 0.7))
      .toBuffer();
    await sharp({
      create: {
        width: t.size,
        height: t.size,
        channels: 4,
        background: { r: 26, g: 25, b: 23, alpha: 1 },
      },
    })
      .composite([{ input: padded, gravity: "center" }])
      .png()
      .toFile(resolve(outDir, t.file));
  } else {
    await sharp(svg).resize(t.size, t.size).png().toFile(resolve(outDir, t.file));
  }
  console.log(`wrote ${t.file} (${t.size}×${t.size}${t.maskable ? " maskable" : ""})`);
}
