const { writeFileSync } = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'src-tauri', 'icons', 'markdown-file.png');
const destination = path.join(projectRoot, 'src-tauri', 'icons', 'markdown-file.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const images = await Promise.all(sizes.map(size => sharp(source)
    .resize(size, size)
    .png()
    .toBuffer()));
  const headerSize = 6 + (16 * images.length);
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = headerSize;
  images.forEach((image, index) => {
    const entry = 6 + (index * 16);
    const size = sizes[index];
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });

  writeFileSync(destination, Buffer.concat([header, ...images]));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
