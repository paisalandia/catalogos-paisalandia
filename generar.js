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
const { leerAjustes, leerCatalogos, leerProductos } = require('./src/fuente-admin');
const { crearPDF } = require('./src/pdf');
const { subirPDF, enlaceFijo, borrarArchivos, guardarResultado } = require('./src/publicar');
const { publicarNuevos } = require('./src/publicar-nuevos');
const { instantanea, registrarCambios, limpiarHistorial } = require('./src/historial');
const { leerAjustesInventario, aplicarReglas } = require('./src/inventario');
const { ordenarColecciones } = require('./src/orden-sin-foto');
const { gql } = require('./src/shopify');
const TIENDA = require('./tienda.json');

// Bump when the PDF design changes so every catalog is rebuilt once
const VERSION_DISENO = 7;
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

  // What this run did, saved for the admin panel ("Gestión" → última revisión)
  const revision = { fecha: new Date().toISOString(), catalogos: [] };
  let ajInv = null;
  // Each step is independent: a failure is reported and the next one still runs
  const paso = async (nombre, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error(`✗ ${nombre}: ${e.message}`);
      revision[`error_${nombre}`] = e.message;
      return null;
    }
  };

  if (!local) {
    // 1. Inventory rules first: products at or below their limit go to draft, restocked ones come back
    ajInv = await paso('inventario', leerAjustesInventario);
    if (ajInv) {
      revision.inventario = await paso('inventario', () => aplicarReglas(ajInv));
      const r = revision.inventario;
      if (r) console.log(r.activo ? `Inventario: ${r.ocultados} ocultados, ${r.reactivados} reactivados` : `Inventario (simulación): ocultaría ${r.ocultar}, reactivaría ${r.reactivar} (+${r.antiguos} borradores antiguos)`);
    }
    // 2. New products must be on the Online Store, or no catalog can include them
    const publicados = await paso('publicar', publicarNuevos);
    revision.publicados = publicados || 0;
    if (publicados) console.log(`${publicados} productos nuevos publicados en la Tienda online`);
    // 3. Products without a photo go to the end of every collection
    if (ajInv) {
      const orden = await paso('orden', () => ordenarColecciones({ simular: !ajInv.ordenSinFoto }));
      if (orden) {
        revision.orden = { ...orden, activo: ajInv.ordenSinFoto };
        console.log(`Orden sin foto${ajInv.ordenSinFoto ? '' : ' (simulación)'}: ${orden.movidos} productos movidos en ${orden.colecciones} colecciones${orden.pasadasAManual.length ? `; a orden manual: ${orden.pasadasAManual.join(', ')}` : ''}`);
      }
    }
  }

  const ajustes = await leerAjustes();
  const catalogos = (await leerCatalogos()).filter((c) => c.activo && (!solo.length || solo.includes(c.slug)));
  console.log(`${catalogos.length} catálogos activos · ajustes: nombre ${ajustes.tamanoNombre}, referencia ${ajustes.tamanoReferencia}, precio ${ajustes.tamanoPrecio}`);
  let fallos = 0;

  for (const catalogo of catalogos) {
    const t0 = Date.now();
    try {
      const { productos, excluidos, motivos } = await leerProductos(catalogo);
      const huella = crypto
        .createHash('sha1')
        .update(JSON.stringify([VERSION_DISENO, TIENDA, ajustes, catalogo.titulo, catalogo.portadaUrl, catalogo.mostrarPrecios, catalogo.sinPrecios, catalogo.disposicion, productos.map((p) => [p.id, p.title, p.precio, p.precioVariable, p.image, p.sku])]))
        .digest('hex');

      const faltaPdf = !catalogo.pdfId || (catalogo.sinPrecios && !catalogo.pdfSinPreciosId);
      if (!forzar && !faltaPdf && catalogo.huella === huella) {
        // Catalogs without history yet get their starting point recorded
        if (!local && !Array.isArray(catalogo.previos) && productos.length) {
          await registrarCambios(catalogo, productos, motivos);
          await guardarResultado(catalogo.id, { productos_ids: JSON.stringify(instantanea(productos)) });
        }
        console.log(`· ${catalogo.slug}: sin cambios (${productos.length} productos)`);
        continue;
      }
      if (!productos.length) {
        console.log(`· ${catalogo.slug}: sin productos para mostrar, se omite`);
        continue;
      }

      const versiones = [{ sufijo: '', mostrarPrecios: catalogo.mostrarPrecios, campo: 'pdf', anterior: catalogo.pdfId }];
      if (catalogo.sinPrecios && catalogo.mostrarPrecios) versiones.push({ sufijo: '-sin-precios', mostrarPrecios: false, campo: 'pdf_sin_precios', anterior: catalogo.pdfSinPreciosId });

      // A readable list of what the PDF contains, in its order, so it can be checked from the admin
      const listado = productos
        .map((p, i) => `${i + 1}. ${p.sku || 's/SKU'} · ${p.name}${p.reference ? ` (Ref. ${p.reference})` : ''} · $ ${p.precio.toLocaleString('es-CO')}`)
        .join('\n')
        .slice(0, 60000); // Shopify text fields hold up to 65,535 characters
      const resultado = { productos: productos.length, actualizado: new Date().toISOString(), huella, productos_listado: listado, productos_ids: JSON.stringify(instantanea(productos)) };
      const viejos = [];
      for (const v of versiones) {
        const slug = `${catalogo.slug}${v.sufijo}`;
        // Shopify accepts uploads up to 20 MB: very large catalogs get lighter photos
        let bytes;
        for (const calidad of CALIDADES) {
          bytes = await crearPDF({ catalogo: { ...catalogo, mostrarPrecios: v.mostrarPrecios }, tienda: TIENDA, ajustes, productos, slug, calidad });
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
        // History first: it compares against the previous list, which guardarResultado replaces
        const cambio = await registrarCambios(catalogo, productos, motivos);
        if (cambio) revision.catalogos.push({ catalogo: catalogo.slug, resumen: cambio });
        await guardarResultado(catalogo.id, resultado);
        await borrarArchivos(viejos.filter((id) => id && !Object.values(resultado).includes(id)));
      }
      console.log(`✓ ${catalogo.slug}: ${productos.length} productos (fuera: ${excluidos.sinFoto} sin foto, ${excluidos.sinInventario} sin inventario, ${excluidos.inactivos} inactivos/no publicados, ${excluidos.aMano} quitados a mano) en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (e) {
      fallos++;
      console.error(`✗ ${catalogo.slug}: ${e.message}`);
    }
  }
  if (!local) {
    await paso('limpieza', async () => {
      await limpiarHistorial('catalogo_historial');
      await limpiarHistorial('inventario_historial');
    });
    if (ajInv && ajInv.id) {
      await paso('revision', () =>
        gql(`mutation($id: ID!, $m: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $m) { userErrors { message } } }`, {
          id: ajInv.id,
          m: { fields: [{ key: 'ultima_revision', value: JSON.stringify(revision) }] },
        })
      );
    }
  }
  if (fallos) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
