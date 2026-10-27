// Builds the catalogs defined in Shopify (Contenido → Metaobjetos → Catálogo PDF).
// For each active catalog it reads the products, and only when something changed (products,
// prices, photos or settings) it renders the PDF(s), uploads them and updates the fixed links:
//   mayoristapaisalandia.com/catalogos/<slug>             with prices
//   mayoristapaisalandia.com/catalogos/<slug>-sin-precios without prices
//
//   node generar.js                  every catalog that changed
//   node generar.js navidad cocina   only these
//   node generar.js --forzar         rebuild even without changes
//   node generar.js --local          only write salida/*.pdf, don't publish
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { leerCatalogos, leerProductos } = require('./src/fuente-admin');
const { crearPDF } = require('./src/pdf');
const { subirPDF, enlaceFijo, borrarArchivos, guardarResultado } = require('./src/publicar');
const TIENDA = require('./tienda.json');

// Bump when the PDF design changes so every catalog is rebuilt once
const VERSION_DISENO = 3;
const LIMITE_BYTES = 19 * 1024 * 1024;
const CALIDADES = [
  { escala: 2.2, jpeg: 75 },
  { escala: 1.7, jpeg: 70 },
  { escala: 1.3, jpeg: 65 },
];

(async () => {
  const args = process.argv.slice(2);
  const forzar = args.includes('--forzar');
  const local = args.includes('--local');
  const solo = args.filter((a) => !a.startsWith('--'));

  const catalogos = (await leerCatalogos()).filter((c) => c.activo && (!solo.length || solo.includes(c.slug)));
  console.log(`${catalogos.length} catálogos activos`);
  let fallos = 0;

  for (const catalogo of catalogos) {
    const t0 = Date.now();
    try {
      const { productos, excluidos } = await leerProductos(catalogo);
      const huella = crypto
        .createHash('sha1')
        .update(JSON.stringify([VERSION_DISENO, TIENDA, catalogo.titulo, catalogo.portadaUrl, catalogo.mostrarPrecios, catalogo.sinPrecios, catalogo.disposicion, productos.map((p) => [p.id, p.title, p.precio, p.precioVariable, p.image, p.sku])]))
        .digest('hex');

      const faltaPdf = !catalogo.pdfId || (catalogo.sinPrecios && !catalogo.pdfSinPreciosId);
      if (!forzar && !faltaPdf && catalogo.huella === huella) {
        console.log(`· ${catalogo.slug}: sin cambios (${productos.length} productos)`);
        continue;
      }
      if (!productos.length) {
        console.log(`· ${catalogo.slug}: sin productos para mostrar, se omite`);
        continue;
      }

      const versiones = [{ sufijo: '', mostrarPrecios: catalogo.mostrarPrecios, campo: 'pdf', anterior: catalogo.pdfId }];
      if (catalogo.sinPrecios && catalogo.mostrarPrecios) versiones.push({ sufijo: '-sin-precios', mostrarPrecios: false, campo: 'pdf_sin_precios', anterior: catalogo.pdfSinPreciosId });

      const resultado = { productos: productos.length, actualizado: new Date().toISOString(), huella };
      const viejos = [];
      for (const v of versiones) {
        const slug = `${catalogo.slug}${v.sufijo}`;
        // Shopify accepts uploads up to 20 MB: very large catalogs get lighter photos
        let bytes;
        for (const calidad of CALIDADES) {
          bytes = await crearPDF({ catalogo: { ...catalogo, mostrarPrecios: v.mostrarPrecios }, tienda: TIENDA, productos, slug, calidad });
          if (bytes.length <= LIMITE_BYTES) break;
        }
        if (bytes.length > LIMITE_BYTES) throw new Error(`${slug}: el PDF pesa más de 19 MB incluso con fotos livianas; divide el catálogo`);
        const mb = (bytes.length / 1024 / 1024).toFixed(1);
        if (local) {
          fs.mkdirSync(path.join(__dirname, 'salida'), { recursive: true });
          fs.writeFileSync(path.join(__dirname, 'salida', `${slug}.pdf`), bytes);
          console.log(`  ${slug}.pdf ${mb} MB (local)`);
          continue;
        }
        const archivo = await subirPDF(Buffer.from(bytes), `catalogo-${slug}.pdf`);
        // Shopify redirects are permanent (301) and get cached, so the fixed link never points at a
        // file: it opens the Catálogos page, which forwards to the newest PDF
        await enlaceFijo(`/catalogos/${slug}`, `/pages/catalogos?ver=${slug}`);
        resultado[v.campo] = archivo.id;
        viejos.push(v.anterior);
        console.log(`  ${slug}: ${mb} MB → ${TIENDA.web}/catalogos/${slug}`);
      }
      if (!local) {
        await guardarResultado(catalogo.id, resultado);
        await borrarArchivos(viejos.filter((id) => id && !Object.values(resultado).includes(id)));
      }
      console.log(`✓ ${catalogo.slug}: ${productos.length} productos (fuera: ${excluidos.sinFoto} sin foto, ${excluidos.sinInventario} sin inventario, ${excluidos.inactivos} inactivos/no publicados) en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (e) {
      fallos++;
      console.error(`✗ ${catalogo.slug}: ${e.message}`);
    }
  }
  if (fallos) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
