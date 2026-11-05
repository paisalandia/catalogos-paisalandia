// Change history of each catalog: every time a catalog is rebuilt, records which products entered,
// which left (and why) and which changed price, as a "catalogo_historial" metaobject entry that the
// admin panel shows. Entries older than DIAS are deleted so the history stays light.
const { gql, revisarErrores } = require('./shopify');

const DIAS = 120;
const MAX_DETALLE = 300; // products listed per group in one entry

// Compact snapshot of the PDF's products, stored on the catalog for the next comparison
const instantanea = (productos) => productos.map((p) => [p.id, p.precio, p.sku || '', p.name]);

function compararCatalogo(previos, productos, motivos) {
  const antes = new Map((previos || []).map(([id, precio, sku, nombre]) => [id, { precio, sku, nombre }]));
  const ahora = new Map(productos.map((p) => [p.id, p]));
  const agregados = productos.filter((p) => !antes.has(p.id)).map((p) => ({ sku: p.sku, nombre: p.name, precio: p.precio }));
  const quitados = [...antes]
    .filter(([id]) => !ahora.has(id))
    .map(([id, v]) => ({ sku: v.sku, nombre: v.nombre, motivo: motivos.get(id) || 'Salió de la colección' }));
  const precios = productos
    .filter((p) => antes.has(p.id) && antes.get(p.id).precio !== p.precio)
    .map((p) => ({ sku: p.sku, nombre: p.name, antes: antes.get(p.id).precio, ahora: p.precio }));
  return { agregados, quitados, precios };
}

async function registrarCambios(catalogo, productos, motivos) {
  const primero = !Array.isArray(catalogo.previos);
  const { agregados, quitados, precios } = compararCatalogo(catalogo.previos, productos, motivos);
  if (!primero && !agregados.length && !quitados.length && !precios.length) return null;

  const partes = [];
  if (agregados.length) partes.push(`+${agregados.length} agregados`);
  if (quitados.length) partes.push(`−${quitados.length} quitados`);
  if (precios.length) partes.push(`${precios.length} cambios de precio`);
  const resumen = primero ? `Inicio del historial · ${productos.length} productos` : `${catalogo.titulo}: ${partes.join(', ')} · ${productos.length} productos`;

  const detalle = primero ? {} : { agregados: agregados.slice(0, MAX_DETALLE), quitados: quitados.slice(0, MAX_DETALLE), precios: precios.slice(0, MAX_DETALLE) };
  revisarErrores(
    (
      await gql(`mutation($m: MetaobjectCreateInput!) { metaobjectCreate(metaobject: $m) { userErrors { field message } } }`, {
        m: {
          type: 'catalogo_historial',
          fields: [
            { key: 'catalogo', value: catalogo.id },
            { key: 'fecha', value: new Date().toISOString() },
            { key: 'total', value: String(productos.length) },
            { key: 'agregados', value: String(primero ? 0 : agregados.length) },
            { key: 'quitados', value: String(quitados.length) },
            { key: 'precios', value: String(precios.length) },
            { key: 'resumen', value: resumen.slice(0, 250) },
            { key: 'detalle', value: JSON.stringify(detalle) },
          ],
        },
      })
    ).metaobjectCreate,
    'Guardar historial'
  );
  return resumen;
}

// Deletes history entries (of any history type) older than DIAS days
async function limpiarHistorial(tipo) {
  const limite = Date.now() - DIAS * 864e5;
  let borrados = 0;
  for (;;) {
    const { metaobjects } = await gql(`query($t: String!) { metaobjects(type: $t, first: 100, sortKey: "updated_at") { nodes { id updatedAt } } }`, { t: tipo });
    const viejos = metaobjects.nodes.filter((m) => Date.parse(m.updatedAt) < limite);
    if (!viejos.length) return borrados;
    for (const m of viejos) {
      await gql(`mutation($id: ID!) { metaobjectDelete(id: $id) { userErrors { message } } }`, { id: m.id });
      borrados++;
    }
    if (viejos.length < metaobjects.nodes.length) return borrados;
  }
}

module.exports = { instantanea, registrarCambios, limpiarHistorial };
