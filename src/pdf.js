// Renders a product catalog PDF: a light cover with the first products, then a grid of product
// cards. The brand stays in thin accents (logo, green price, yellow highlight) so the photos lead.
// Every card links to its product page with UTM tags, so Shopify analytics shows catalog traffic.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fontkit = require('@pdf-lib/fontkit');
const { PDFDocument, PDFName, PDFString, rgb } = require('pdf-lib');

const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

const C = {
  heading: hex('#1d3b12'),
  accent: hex('#47ac35'),
  accentStrong: hex('#2f7d16'),
  accentDeep: hex('#1f6b12'),
  accentSoft: hex('#eef8e9'),
  highlight: hex('#ffd400'),
  text: hex('#1d1d1d'),
  muted: hex('#6b7280'),
  line: hex('#e4e9e1'),
  photoBg: hex('#f6f8f4'),
  tagBg: hex('#eef0ec'),
  tagText: hex('#4b5563'),
  white: rgb(1, 1, 1),
};

const PAGE = { w: 612, h: 792 }; // US Letter, the default print size in Colombia
const M = 28;
const LAYOUTS = { '2x2': [2, 2], '2x3': [2, 3], '3x3': [3, 3] };
const FONT_DIR = path.join(__dirname, '..', 'node_modules', '@fontsource', 'inter', 'files');

const formatoPrecio = (n) => `$ ${Math.round(n).toLocaleString('es-CO')}`;

function roundedRect(page, x, y, w, h, r, opts) {
  const p = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
  // drawSvgPath uses a y-down coordinate system anchored at (x, y) = top-left
  page.drawSvgPath(p, { x, y: y + h, ...opts });
}

function wrap(text, font, size, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      line = test;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length || lines.length > maxLines) {
    lines.length = Math.min(lines.length, maxLines);
    let last = lines[lines.length - 1];
    while (last && font.widthOfTextAtSize(`${last}…`, size) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

function addLink(doc, page, x, y, w, h, url) {
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, y, x + w, y + h],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
  });
  const ref = doc.context.register(annot);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

async function fetchImage(url, size, quality = 75, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}width=${Math.max(size, 700)}`);
      if (!res.ok) throw new Error(res.status);
      const input = Buffer.from(await res.arrayBuffer());
      return await sharp(input)
        .flatten({ background: '#ffffff' })
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

// Fits a designed cover to the page without cropping it: the image is centered whole, and the
// margins are filled with a blurred, slightly darker copy of itself (covers come in many ratios)
async function prepararPortada(url, tries = 3) {
  const W = 1275; // US Letter at 150 dpi
  const H = 1650;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const input = await sharp(Buffer.from(await res.arrayBuffer())).flatten({ background: '#ffffff' }).toBuffer();
      const fondo = await sharp(input).resize(W, H, { fit: 'cover' }).blur(30).modulate({ brightness: 0.85 }).toBuffer();
      const frente = await sharp(input).resize(W, H, { fit: 'inside' }).toBuffer();
      return await sharp(fondo).composite([{ input: frente, gravity: 'center' }]).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// catalogo: { titulo, subtitulo?, mostrarPrecios, disposicion, portadaUrl? }
// tienda: { nombre, web, logoUrl, notaPrecios, avisoHojas }
// calidad: { escala, jpeg } — photo resolution relative to its printed size, and JPEG quality
async function crearPDF({ catalogo, tienda, productos, slug, calidad = { escala: 2.2, jpeg: 75 } }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = (w) => doc.embedFont(fs.readFileSync(path.join(FONT_DIR, `inter-latin-${w}-normal.woff`)), { subset: true });
  const F = { regular: await font(400), medium: await font(500), bold: await font(700), black: await font(800) };

  doc.setTitle(`${catalogo.titulo} – ${tienda.nombre}`);
  doc.setAuthor(tienda.nombre);
  doc.setSubject(`Catálogo ${catalogo.titulo}`);
  doc.setCreator('Catálogos Paisalandia');

  const [cols, rows] = LAYOUTS[catalogo.disposicion] || LAYOUTS['2x3'];
  const gap = 12;
  const gridTop = PAGE.h - 66;
  const gridBottom = 58;
  const cardW = (PAGE.w - 2 * M - gap * (cols - 1)) / cols;
  const cardH = (gridTop - gridBottom - gap * (rows - 1)) / rows;
  const textH = catalogo.mostrarPrecios ? 70 : 48;
  const photoH = cardH - textH - 10;
  // ~2x the printed size for phone zoom; big 2-column cards need less (≈400 px is sharp on a phone)
  const imgPx = Math.round(Math.min(cardW, photoH) * calidad.escala * (cols === 2 ? 0.68 : 1));

  const logoBytes = await fetchImage(tienda.logoUrl, 360);
  const logo = logoBytes ? await doc.embedJpg(logoBytes) : null;

  const images = await mapLimit(productos, 8, async (p) => (p.image ? fetchImage(p.image, imgPx, calidad.jpeg) : null));
  const embedded = await mapLimit(images, 4, async (b) => (b ? doc.embedJpg(b) : null));

  const fecha = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  const utm = (url) => `${url}?utm_source=catalogo&utm_medium=pdf&utm_campaign=${slug}`;

  // ----- Cover -----
  const cover = doc.addPage([PAGE.w, PAGE.h]);
  const web = tienda.web.replace(/^https?:\/\//, '');
  // A designed cover image (from the catalog's "Portada" field) fills the whole first page
  const portadaBytes = catalogo.portadaUrl ? await prepararPortada(catalogo.portadaUrl) : null;
  if (portadaBytes) {
    const img = await doc.embedJpg(portadaBytes);
    cover.drawImage(img, { x: 0, y: 0, width: PAGE.w, height: PAGE.h });
    addLink(doc, cover, 0, 0, PAGE.w, PAGE.h, utm(tienda.web));
  } else {
    dibujarPortada();
  }

  function dibujarPortada() {
    if (logo) {
      const lh = 54;
      const lw = (logo.width / logo.height) * lh;
      cover.drawImage(logo, { x: (PAGE.w - lw) / 2, y: PAGE.h - 60 - lh, width: lw, height: lh });
    }
    const kicker = 'CATÁLOGO';
    cover.drawText(kicker, { x: (PAGE.w - F.bold.widthOfTextAtSize(kicker, 10) - 3 * kicker.length) / 2, y: PAGE.h - 160, size: 10, font: F.bold, color: C.accentStrong, characterSpacing: 3 });
    const titleLines = wrap(catalogo.titulo, F.black, 36, PAGE.w - 2 * M - 40, 2);
    let ty = PAGE.h - 205;
    for (const line of titleLines) {
      const w = F.black.widthOfTextAtSize(line, 36);
      const x = (PAGE.w - w) / 2;
      cover.drawRectangle({ x: x - 4, y: ty - 6, width: w + 8, height: 14, color: C.highlight, opacity: 0.85 });
      cover.drawText(line, { x, y: ty, size: 36, font: F.black, color: C.heading });
      ty -= 44;
    }
    const sub = catalogo.subtitulo || `${productos.length} productos disponibles · Actualizado el ${fecha}`;
    cover.drawText(sub, { x: (PAGE.w - F.medium.widthOfTextAtSize(sub, 11)) / 2, y: ty - 4, size: 11, font: F.medium, color: C.muted });

    // Product mosaic: the cover sells with the products themselves
    const mosaic = embedded.slice(0, 6).filter(Boolean);
    if (mosaic.length) {
      const mCols = 3;
      const mRows = Math.ceil(mosaic.length / mCols);
      const mGap = 10;
      const mW = (PAGE.w - 2 * (M + 30) - mGap * (mCols - 1)) / mCols;
      const mTop = ty - 40;
      mosaic.forEach((img, i) => {
        const cx = M + 30 + (i % mCols) * (mW + mGap);
        const cy = mTop - Math.floor(i / mCols) * (mW + mGap) - mW;
        roundedRect(cover, cx, cy, mW, mW, 10, { color: C.photoBg });
        const s = Math.min((mW - 12) / img.width, (mW - 12) / img.height);
        cover.drawImage(img, { x: cx + (mW - img.width * s) / 2, y: cy + (mW - img.height * s) / 2, width: img.width * s, height: img.height * s });
      });
      void mRows;
    }

    // Cover footer band
    cover.drawRectangle({ x: 0, y: 0, width: PAGE.w, height: 64, color: C.accentSoft });
    cover.drawRectangle({ x: 0, y: 64, width: PAGE.w, height: 2, color: C.accent });
    const note = catalogo.mostrarPrecios ? tienda.notaPrecios : 'Consulta precios con tu asesor.';
    cover.drawText(note, { x: M, y: 38, size: 9, font: F.medium, color: C.heading });
    wrap(tienda.avisoHojas, F.regular, 7.5, PAGE.w - 2 * M - 190, 2).forEach((line, i) => cover.drawText(line, { x: M, y: 25 - i * 10, size: 7.5, font: F.regular, color: C.muted }));
    cover.drawText(web, { x: PAGE.w - M - F.bold.widthOfTextAtSize(web, 11), y: 30, size: 11, font: F.bold, color: C.accentStrong });
    addLink(doc, cover, PAGE.w - M - 150, 20, 150, 28, utm(tienda.web));
  }

  // ----- Product pages -----
  const perPage = cols * rows;
  const pages = [];
  for (let i = 0; i < productos.length; i += perPage) pages.push(productos.slice(i, i + perPage).map((p, j) => [p, embedded[i + j]]));

  const totalPages = pages.length + 1;
  pages.forEach((items, pi) => {
    const page = doc.addPage([PAGE.w, PAGE.h]);

    // Header: logo + catalog name, one hairline
    if (logo) {
      const lh = 22;
      page.drawImage(logo, { x: M, y: PAGE.h - 22 - lh, width: (logo.width / logo.height) * lh, height: lh });
    }
    const head = catalogo.titulo.toUpperCase();
    page.drawText(head, { x: PAGE.w - M - F.bold.widthOfTextAtSize(head, 9) - 1.2 * head.length, y: PAGE.h - 38, size: 9, font: F.bold, color: C.heading, characterSpacing: 1.2 });
    page.drawRectangle({ x: M, y: PAGE.h - 52, width: PAGE.w - 2 * M, height: 0.6, color: C.line });
    page.drawRectangle({ x: M, y: PAGE.h - 52.5, width: 28, height: 1.6, color: C.accent });

    items.forEach(([p, img], k) => {
      const col = k % cols;
      const row = Math.floor(k / cols);
      const x = M + col * (cardW + gap);
      const yTop = gridTop - row * (cardH + gap);
      const y = yTop - cardH;

      roundedRect(page, x, y, cardW, cardH, 9, { color: C.white, borderColor: C.line, borderWidth: 0.7 });
      const px = x + 5;
      const pw = cardW - 10;
      const py = yTop - 5 - photoH;
      roundedRect(page, px, py, pw, photoH, 7, { color: C.photoBg });
      if (img) {
        const s = Math.min((pw - 8) / img.width, (photoH - 8) / img.height);
        page.drawImage(img, { x: px + (pw - img.width * s) / 2, y: py + (photoH - img.height * s) / 2, width: img.width * s, height: img.height * s });
      }

      const tx = x + 9;
      const tw = cardW - 18;
      let ly = py - 13;
      const nameSize = cols === 3 ? 8 : 9;
      for (const line of wrap(p.name, F.medium, nameSize, tw, 2)) {
        page.drawText(line, { x: tx, y: ly, size: nameSize, font: F.medium, color: C.text });
        ly -= nameSize + 2.5;
      }
      // Reference as a gray tag (same as the store's product cards), SKU beside it
      const my = y + (catalogo.mostrarPrecios ? 31 : 9);
      let mx = tx;
      if (p.reference) {
        const refText = wrap(`Ref. ${p.reference}`, F.medium, 7, tw * 0.62, 1)[0];
        const rw = F.medium.widthOfTextAtSize(refText, 7) + 10;
        roundedRect(page, mx, my - 3.2, rw, 11.5, 5.75, { color: C.tagBg });
        page.drawText(refText, { x: mx + 5, y: my, size: 7, font: F.medium, color: C.tagText });
        mx += rw + 6;
      }
      if (p.sku) {
        const skuText = wrap(`SKU ${p.sku}`, F.regular, 7, tx + tw - mx, 1)[0];
        if (skuText && skuText !== '…') page.drawText(skuText, { x: mx, y: my, size: 7, font: F.regular, color: C.muted });
      }

      if (catalogo.mostrarPrecios) {
        const priceText = `${p.precioVariable ? 'Desde ' : ''}${formatoPrecio(p.precio)}`;
        // Large, heavy and dark green: the price must read at a glance on a phone
        const ps = cols === 3 ? 14 : 17;
        page.drawText(priceText, { x: tx, y: y + 9, size: ps, font: F.black, color: C.accentDeep });
        if (p.unitLabel) {
          const ux = tx + F.black.widthOfTextAtSize(priceText, ps) + 6;
          page.drawText(p.unitLabel, { x: ux, y: y + 10, size: 8.5, font: F.medium, color: C.muted });
        }
      }
      addLink(doc, page, x, y, cardW, cardH, utm(p.url));
    });

    // Footer: dispatch note on every page, then site · prices note · page number
    const aviso = wrap(tienda.avisoHojas, F.medium, 7, PAGE.w - 2 * M, 1)[0];
    page.drawText(aviso, { x: (PAGE.w - F.medium.widthOfTextAtSize(aviso, 7)) / 2, y: 44, size: 7, font: F.medium, color: C.heading });
    page.drawRectangle({ x: M, y: 34, width: PAGE.w - 2 * M, height: 0.6, color: C.line });
    page.drawText(web, { x: M, y: 20, size: 7.5, font: F.bold, color: C.accentStrong });
    addLink(doc, page, M, 16, F.bold.widthOfTextAtSize(web, 7.5), 14, utm(tienda.web));
    const mid = catalogo.mostrarPrecios ? `${tienda.notaPrecios} · Actualizado el ${fecha}` : `Actualizado el ${fecha}`;
    page.drawText(mid, { x: (PAGE.w - F.regular.widthOfTextAtSize(mid, 7)) / 2, y: 20, size: 7, font: F.regular, color: C.muted });
    const num = `${pi + 2} / ${totalPages}`;
    page.drawText(num, { x: PAGE.w - M - F.medium.widthOfTextAtSize(num, 7.5), y: 20, size: 7.5, font: F.medium, color: C.muted });
  });

  return doc.save({ useObjectStreams: true });
}

module.exports = { crearPDF };
