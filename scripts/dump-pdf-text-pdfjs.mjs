import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/dump-pdf-text-pdfjs.mjs <pdf> [...]');
  process.exit(1);
}

for (const f of files) {
  const abs = path.isAbsolute(f) ? f : path.join(root, f);
  const data = new Uint8Array(fs.readFileSync(abs));
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const line = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
    out += `\n--- page ${p} ---\n${line}\n`;
  }
  console.log(`\n========== ${path.basename(abs)} ==========`);
  console.log(out.trim());
}
