// Renders PDF pages to PNG for a quick visual check.
//   node herramientas/vista-previa.mjs salida/navidad.pdf 1 2 3
//   ANCHO=390 node herramientas/vista-previa.mjs …   (render at a phone's width in px)
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const [file, ...pages] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true }).promise;
const outDir = path.join(path.dirname(file), 'vista');
fs.mkdirSync(outDir, { recursive: true });
for (const n of pages.length ? pages.map(Number) : [1, 2]) {
  const page = await doc.getPage(n);
  const ancho = Number(process.env.ANCHO) || 0;
  const viewport = page.getViewport({ scale: ancho ? ancho / page.getViewport({ scale: 1 }).width : 1.4 });
  const canvas = createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const out = path.join(outDir, `${path.basename(file, '.pdf')}-p${n}.png`);
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(out);
}
console.log('páginas', doc.numPages);
