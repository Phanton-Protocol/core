import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdf } from 'pdf-to-img';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const [pdfRel, outDirRel] = process.argv.slice(2);
if (!pdfRel || !outDirRel) {
  console.error('Usage: node scripts/pdf-to-img-dir.mjs <pdf> <outDirUnderPublic>');
  process.exit(1);
}

const pdfPath = path.isAbsolute(pdfRel) ? pdfRel : path.join(root, pdfRel);
const outDir = path.join(root, 'public', outDirRel);
fs.mkdirSync(outDir, { recursive: true });

let n = 1;
const document = await pdf(pdfPath, { scale: 2 });
for await (const image of document) {
  const file = path.join(outDir, `page-${n}.png`);
  fs.writeFileSync(file, image);
  console.log('wrote', path.relative(root, file));
  n += 1;
}
