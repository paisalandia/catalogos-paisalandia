// Orders every collection with the newest products first and the photo-less ones at the end.
// Shopify only lets an app reorder a collection set to "manual", so collections with an automatic
// order switch to manual (the order they had is saved in the collection metafield
// gestion.orden_original), and every hour the products are laid out again: newest first, products
// without a photo last. Only the products whose place changed are moved.
const { gql, revisarErrores, sleep } = require('./shopify');

const OMITIR = new Set(['globofilter-best-selling-products-index']); // app index, not shown to customers
const ORDEN_TODAS = 'CREATED_DESC'; // newest first
const ORDENES = {
  CREATED_DESC: ['CREATED', true],
  CREATED: ['CREATED', false],
  ALPHA_ASC: ['TITLE', false],
  ALPHA_DESC: ['TITLE', true],
  BEST_SELLING: ['BEST_SELLING', false],
  PRICE_ASC: ['PRICE', false],
  PRICE_DESC: ['PRICE', true],
};
const LOTE = 250; // moves per reorder call (Shopify's limit)
const MAX_MOVIMIENTOS = 15000; // per run; the rest waits for the next hour

async function productosDe(id, sortKey, reverse) {
  const out = [];
  let after = null;
  for (;;) {
    const { collection } = await gql(
      `query($id: ID!, $after: String, $k: ProductCollectionSortKeys!, $r: Boolean!) { collection(id: $id) { products(first: 250, after: $after, sortKey: $k, reverse: $r) { nodes { id featuredMedia { id } } pageInfo { hasNextPage endCursor } } } }`,
      { id, after, k: sortKey, r: reverse }
    );
    out.push(...collection.products.nodes.map((p) => ({ id: p.id, foto: !!p.featuredMedia })));
    if (!collection.products.pageInfo.hasNextPage) return out;
    after = collection.products.pageInfo.endCursor;
  }
}

async function esperarTrabajo(job) {
  for (let i = 0; job && !job.done && i < 60; i++) {
    await sleep(2000);
    ({ job } = await gql(`query($id: ID!) { job(id: $id) { id done } }`, { id: job.id }));
  }
}

async function reordenar(id, moves) {
  for (let i = 0; i < moves.length; i += LOTE) {
    const r = revisarErrores(
      (
        await gql(`mutation($id: ID!, $moves: [MoveInput!]!) { collectionReorderProducts(id: $id, moves: $moves) { job { id done } userErrors { field message } } }`, {
          id,
          moves: moves.slice(i, i + LOTE),
        })
      ).collectionReorderProducts,
      'Reordenar colección'
    );
    await esperarTrabajo(r.job);
  }
}

// Moves that turn `actual` into `deseado`, placing each product at its final index in ascending order
function movimientosCompletos(actual, deseado) {
  const lista = actual.map((p) => p.id);
  const moves = [];
  deseado.forEach((p, i) => {
    if (lista[i] === p.id) return;
    const desde = lista.indexOf(p.id);
    lista.splice(desde, 1);
    lista.splice(i, 0, p.id);
    moves.push({ id: p.id, newPosition: String(i) });
  });
  return moves;
}

async function ordenarColecciones({ simular }) {
  const { collections } = await gql(
    `{ collections(first: 250) { nodes { id handle sortOrder metafield(namespace: "gestion", key: "orden_original") { value } } } }`
  );
  const resumen = { colecciones: 0, movidos: 0, pasadasAManual: [], detalle: [] };
  let presupuesto = MAX_MOVIMIENTOS;

  for (const c of collections.nodes) {
    if (OMITIR.has(c.handle) || presupuesto <= 0) continue;

    // Owner's rule (2026-11-06): every collection shows the newest products first, photo-less ones last
    const base = await productosDe(c.id, ...ORDENES[ORDEN_TODAS]);
    const deseado = [...base.filter((p) => p.foto), ...base.filter((p) => !p.foto)];
    const sinFoto = base.length - base.filter((p) => p.foto).length;

    if (c.sortOrder !== 'MANUAL') {
      // Shopify only lets an app reorder a manual collection; the order it had is kept for reference
      if (simular) {
        resumen.pasadasAManual.push(c.handle);
        resumen.colecciones++;
        resumen.movidos += base.length;
        resumen.detalle.push({ coleccion: c.handle, sinFoto, movimientos: base.length });
        continue;
      }
      revisarErrores(
        (
          await gql(`mutation($c: CollectionInput!) { collectionUpdate(input: $c) { userErrors { field message } } }`, {
            c: { id: c.id, sortOrder: 'MANUAL', metafields: [{ namespace: 'gestion', key: 'orden_original', type: 'single_line_text_field', value: (c.metafield && c.metafield.value) || c.sortOrder }] },
          })
        ).collectionUpdate,
        'Pasar colección a orden manual'
      );
      resumen.pasadasAManual.push(c.handle);
    }
    const actual = await productosDe(c.id, 'MANUAL', false);
    let moves = movimientosCompletos(actual, deseado);

    if (!moves.length) continue;
    moves = moves.slice(0, presupuesto);
    resumen.colecciones++;
    resumen.movidos += moves.length;
    resumen.detalle.push({ coleccion: c.handle, sinFoto, movimientos: moves.length });
    presupuesto -= moves.length;
    if (!simular) await reordenar(c.id, moves);
  }
  return resumen;
}

module.exports = { ordenarColecciones };
