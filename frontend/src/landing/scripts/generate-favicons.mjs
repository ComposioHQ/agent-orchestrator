// Keep the browser ICO and search PNG consistent with the SVG master.
// Run from the landing directory: node scripts/generate-favicons.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = fileURLToPath(new URL("../public/favicon.svg", import.meta.url));
await sharp(source).resize(192, 192).png().toFile(
  fileURLToPath(new URL("../public/favicon-192.png", import.meta.url)),
);

const sizes = [16, 32, 48, 256];
const images = await Promise.all(
  sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()),
);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2); // ICO type
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (let index = 0; index < sizes.length; index++) {
  const entry = 6 + index * 16;
  directory[entry] = sizes[index] % 256; // Zero represents 256 pixels.
  directory[entry + 1] = sizes[index] % 256;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile(
  new URL("../src/app/favicon.ico", import.meta.url),
  Buffer.concat([directory, ...images]),
);
