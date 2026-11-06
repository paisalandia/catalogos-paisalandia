// Inventory rules (replace the two "status based on inventory" Flows):
//  - Products sold by the dozen "(DC)" go to draft with limite_dc dozens or less (default 3);
//    every other product with limite_und or less (default 10).
//  - Products this module hid come back to active once their inventory is above the limit again.
//    They carry the tag ETIQUETA so drafts made by hand are never reactivated (unless
//    "reactivar_antiguos" is on, which also brings back old drafts that have a photo).
//  - Every change is written to the "inventario_historial" metaobject the admin panel shows.
// Settings live in the metaobject "inventario_ajustes" (entry "general"). With "activo" off the
// module only simulates and reports what it would do.
const { gql, revisarErrores } = require('./shopify');
const { partirNombre } = require('./nombre');

const ETIQUETA = 'oculto-por-inventario';
const MAX_CAMBIOS = 1500; // per run; the rest waits for the next hour
const MAX_EJEMPLOS = 60; // products listed in the simulation summary

async function leerAjustesInventario() {
  const { metaobjectByHandle: m } = await gql(`{ metaobjectByHandle(handle: { type: "inventario_ajustes", handle: "general" }) { id fields { key value } } }`);
  const f = m ? Object.fromEntries(m.fields.map((x) => [x.key, x.value])) : {};
  const num = (k, base) => (f[k] != null && f[k] !== '' && !Number.isNaN(Number(f[k])) ? Number(f[k]) : base);
  return {
    id: m && m.id,
    activo: f.activo === 'true',
    limiteUnd: num('limite_und', 10),
    limiteDc: num('limite_dc', 3),
    reactivarAntiguos: f.reactivar_antiguos === 'true',
    ordenSinFoto: f.orden_sin_foto === 'true',
    ordenColecciones: f.orden_colecciones || 'Precio: menor a mayor',
  };
}

async function buscar(q) {
  const out = [];
  let after = null;
  for (;;) {
    const { products } = await gql(
      `query($q: String!, $after: String) { products(first: 100, query: $q, after: $after) { nodes { id title totalInventory tracksInventory tags featuredMedia { id } variants(first: 1) { nodes { sku } } } pageInfo { hasNextPage endCursor } } }`,
      { q, after }
    );
    out.push(...products.nodes);
    if (!products.pageInfo.hasNextPage) return out;
    after = products.pageInfo.endCursor;
  }
}

async function registrar(p, accion, limite) {
  const { unit } = partirNombre(p.title);
  revisarErrores(
    (
      await gql(`mutation($m: MetaobjectCreateInput!) { metaobjectCreate(metaobject: $m) { userErrors { field message } } }`, {
        m: {
          type: 'inventario_historial',
          fields: [
            { key: 'producto', value: p.id },
            { key: 'titulo', value: p.title.slice(0, 250) },
            { key: 'sku', value: (p.variants.nodes[0] || {}).sku || '' },
            { key: 'accion', value: accion },
            { key: 'fecha', value: new Date().toISOString() },
            { key: 'inventario', value: String(p.totalInventory) },
            { key: 'limite', value: String(limite) },
            { key: 'unidad', value: unit || '' },
          ],
        },
      })
    ).metaobjectCreate,
    'Guardar historial de inventario'
  );
}

async function cambiarEstado(p, status, tags) {
  revisarErrores(
    (await gql(`mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { userErrors { field message } } }`, { p: { id: p.id, status } })).productUpdate,
    'Cambiar estado'
  );
  const op = tags === 'agregar' ? 'tagsAdd' : 'tagsRemove';
  revisarErrores((await gql(`mutation($id: ID!, $t: [String!]!) { ${op}(id: $id, tags: $t) { userErrors { field message } } }`, { id: p.id, t: [ETIQUETA] }))[op], 'Etiqueta');
}

const resumenProducto = (p, limite) => ({ sku: (p.variants.nodes[0] || {}).sku || '', titulo: p.title, inventario: p.totalInventory, limite });

async function aplicarReglas(aj) {
  // "(DC)" anywhere in the title counts, also when text follows it ("... (DC)NETO")
  const limiteDe = (title) => (/\(\s*DC\s*\)/i.test(title) || partirNombre(title).unit === 'DC' ? aj.limiteDc : aj.limiteUnd);
  const maximo = Math.max(aj.limiteUnd, aj.limiteDc);
  const minimo = Math.min(aj.limiteUnd, aj.limiteDc);

  // Products without inventory tracking always show 0: they are never hidden
  const ocultar = (await buscar(`status:active inventory_total:<=${maximo}`)).filter((p) => p.tracksInventory && p.totalInventory <= limiteDe(p.title));
  const reactivar = (await buscar(`status:draft tag:${ETIQUETA} inventory_total:>${minimo}`)).filter((p) => p.totalInventory > limiteDe(p.title));
  const antiguos = (await buscar(`status:draft -tag:${ETIQUETA} inventory_total:>${minimo}`)).filter(
    (p) => p.tracksInventory && p.featuredMedia && p.totalInventory > limiteDe(p.title)
  );

  const resultado = {
    activo: aj.activo,
    limites: { und: aj.limiteUnd, dc: aj.limiteDc },
    ocultar: ocultar.length,
    reactivar: reactivar.length,
    antiguos: antiguos.length,
    reactivarAntiguos: aj.reactivarAntiguos,
    ejemplos: {
      ocultar: ocultar.slice(0, MAX_EJEMPLOS).map((p) => resumenProducto(p, limiteDe(p.title))),
      reactivar: reactivar.slice(0, MAX_EJEMPLOS).map((p) => resumenProducto(p, limiteDe(p.title))),
      antiguos: antiguos.slice(0, MAX_EJEMPLOS).map((p) => resumenProducto(p, limiteDe(p.title))),
    },
    ocultados: 0,
    reactivados: 0,
  };
  if (!aj.activo) return resultado;

  let cambios = 0;
  for (const p of ocultar) {
    if (cambios++ >= MAX_CAMBIOS) break;
    await cambiarEstado(p, 'DRAFT', 'agregar');
    await registrar(p, 'Ocultado', limiteDe(p.title));
    resultado.ocultados++;
  }
  for (const p of [...reactivar, ...(aj.reactivarAntiguos ? antiguos : [])]) {
    if (cambios++ >= MAX_CAMBIOS) break;
    await cambiarEstado(p, 'ACTIVE', 'quitar');
    await registrar(p, 'Reactivado', limiteDe(p.title));
    resultado.reactivados++;
  }
  return resultado;
}

module.exports = { leerAjustesInventario, aplicarReglas };
