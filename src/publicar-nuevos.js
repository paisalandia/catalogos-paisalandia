// Since 2026-10-28 the system that creates products leaves new ones active but unpublished on the
// Online Store, so they never reach the store or the catalogs. Before building the catalogs, this
// publishes every active product created since then that has a photo and stock.
// Older unpublished products are left alone: those were hidden on purpose.
const { gql, revisarErrores } = require('./shopify');

const DESDE = '2026-10-28';

async function tiendaOnline() {
  const { publications } = await gql(`{ publications(first: 20) { nodes { id catalog { title } } } }`);
  const pub = publications.nodes.find((p) => p.catalog && /online store/i.test(p.catalog.title));
  if (!pub) throw new Error('No se encontró el canal Tienda online');
  return pub.id;
}

async function publicarNuevos() {
  const publicationId = await tiendaOnline();
  const q = `status:active published_status:unpublished created_at:>=${DESDE}`;
  const pendientes = [];
  let after = null;
  for (;;) {
    const { products } = await gql(
      `query($q: String!, $after: String) { products(first: 100, query: $q, after: $after) { nodes { id totalInventory featuredMedia { id } } pageInfo { hasNextPage endCursor } } }`,
      { q, after }
    );
    pendientes.push(...products.nodes.filter((p) => p.featuredMedia && p.totalInventory > 0));
    if (!products.pageInfo.hasNextPage) break;
    after = products.pageInfo.endCursor;
  }
  for (const p of pendientes) {
    revisarErrores(
      (
        await gql(`mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`, {
          id: p.id,
          input: [{ publicationId }],
        })
      ).publishablePublish,
      'Publicar producto'
    );
  }
  return pendientes.length;
}

module.exports = { publicarNuevos, tiendaOnline };
