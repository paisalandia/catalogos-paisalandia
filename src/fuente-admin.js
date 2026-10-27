// Reads the catalog definitions (metaobjects "catalogo_pdf") and their products from the Admin API.
// A product enters a catalog only if it is active, published on the online store, has a photo and
// has stock. Products that come back (restocked and re-activated) enter on the next run.
const { gql } = require('./shopify');
const { partirNombre } = require('./nombre');

const PAIS = 'CO'; // Prices as the Colombia market shows them (includes the +19% adjustment)

const CAMPOS_PRODUCTO = `
  id handle title status onlineStoreUrl totalInventory productType createdAt
  featuredMedia { preview { image { url } } }
  contextualPricing(context: { country: ${PAIS} }) {
    minVariantPricing { price { amount } }
    maxVariantPricing { price { amount } }
  }
  variants(first: 1) { nodes { sku } }
`;

async function leerCatalogos() {
  const data = await gql(`{
    metaobjects(type: "catalogo_pdf", first: 250) {
      nodes {
        id handle updatedAt
        fields { key value reference { ... on Collection { id handle title } ... on GenericFile { id url } ... on MediaImage { id image { url } } } }
      }
    }
  }`);
  return data.metaobjects.nodes.map((m) => {
    const f = Object.fromEntries(m.fields.map((x) => [x.key, x]));
    const val = (k) => (f[k] ? f[k].value : null);
    return {
      id: m.id,
      slug: m.handle,
      titulo: val('nombre'),
      origen: val('origen'),
      coleccion: f.coleccion && f.coleccion.reference,
      valor: val('valor'),
      mostrarPrecios: val('mostrar_precios') !== 'false',
      sinPrecios: val('version_sin_precios') === 'true',
      disposicion: (val('disposicion') || '').startsWith('4') ? '2x2' : '3x3',
      activo: val('activo') !== 'false',
      huella: val('huella'),
      pdfId: val('pdf'),
      pdfSinPreciosId: val('pdf_sin_precios'),
      portadaUrl: f.portada && f.portada.reference && f.portada.reference.image ? f.portada.reference.image.url : null,
    };
  });
}

const comillas = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function paginar(build, pick) {
  const out = [];
  let after = null;
  for (;;) {
    const conn = pick(await gql(build(), { after }));
    if (!conn) return out;
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
}

async function leerProductos(catalogo) {
  let nodes;
  if (catalogo.origen === 'Colección') {
    if (!catalogo.coleccion) throw new Error(`«${catalogo.titulo}»: falta elegir la colección`);
    // Keep the collection's own order (the one set in Shopify)
    nodes = await paginar(
      () => `query($after: String) { collection(id: "${catalogo.coleccion.id}") { products(first: 100, after: $after) { nodes { ${CAMPOS_PRODUCTO} } pageInfo { hasNextPage endCursor } } } }`,
      (d) => d.collection && d.collection.products
    );
  } else {
    const filtro = { Etiqueta: 'tag', 'Tipo de producto': 'product_type', Marca: 'vendor' }[catalogo.origen];
    if (!filtro || !catalogo.valor) throw new Error(`«${catalogo.titulo}»: falta la etiqueta, tipo o marca`);
    const q = `status:active ${filtro}:${comillas(catalogo.valor)}`;
    // Newest products first
    nodes = await paginar(
      () => `query($after: String) { products(first: 100, after: $after, query: ${JSON.stringify(q)}, sortKey: CREATED_AT, reverse: true) { nodes { ${CAMPOS_PRODUCTO} } pageInfo { hasNextPage endCursor } } }`,
      (d) => d.products
    );
  }

  const todos = nodes.filter((p) => p.status === 'ACTIVE' && p.onlineStoreUrl);
  const productos = todos.filter((p) => p.featuredMedia && p.totalInventory > 0).map(aProducto);
  return {
    productos,
    excluidos: {
      sinFoto: todos.filter((p) => !p.featuredMedia).length,
      sinInventario: todos.filter((p) => p.featuredMedia && !(p.totalInventory > 0)).length,
      inactivos: nodes.length - todos.length,
    },
  };
}

function aProducto(p) {
  const min = Number(p.contextualPricing.minVariantPricing.price.amount);
  const max = Number(p.contextualPricing.maxVariantPricing.price.amount);
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    ...partirNombre(p.title),
    sku: (p.variants.nodes[0] || {}).sku || '',
    image: p.featuredMedia.preview.image.url,
    precio: Math.round(min),
    precioVariable: Math.round(max) !== Math.round(min),
    url: p.onlineStoreUrl,
  };
}

module.exports = { leerCatalogos, leerProductos };
