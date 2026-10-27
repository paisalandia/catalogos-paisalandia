// Downloads the currently published PDF of a catalog (the one its fixed link opens) to
// salida/publicado-<slug>.pdf, to check what customers receive.
//   node herramientas/bajar-publicado.js crisalida
const fs = require('fs');
const path = require('path');
const TIENDA = require('../tienda.json');

(async () => {
  const slug = process.argv[2];
  const html = await (await fetch(`${TIENDA.web}/pages/catalogos?x=${Date.now()}`)).text();
  const link = [...html.matchAll(/<a\s+href="([^"]+)"\s+data-catalogo="([^"]+)"/g)].find((m) => m[2] === slug);
  if (!link) throw new Error(`No se encontró el catálogo ${slug}`);
  const url = (link[1].startsWith('//') ? 'https:' : '') + link[1].replace(/&amp;/g, '&');
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  const out = path.join(__dirname, '..', 'salida', `publicado-${slug}.pdf`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(url.split('/').pop(), bytes.length, 'bytes →', out);
})();
