// Reads the catalog definitions (metaobjects "catalogo_pdf"), the global settings (metaobject
// "catalogo_ajustes", entry "general") and each catalog's products from the Admin API.
// A product enters a catalog only if it is active, published on the online store, has a photo and
// has stock. Products that come back (restocked and re-activated) enter on the next run.
// Each catalog can also add or remove products by hand and choose the product order.
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

// Defaults for every global setting, used when a field is left empty in Shopify
const AJUSTES_BASE = {
  tamanoNombre: 14,
  tamanoReferencia: 11.5,
  tamanoPrecio: 21,
  tamanoAviso: 10.5,
  mostrarReferencia: true,
  mostrarSku: true,
  colorPrecio: '#1F6B12',
  notaPrecios: 'Precios con IVA incluido',
  avisoHojas: 'Las referencias y productos se despachan en colores y estilos surtidos. Las imágenes son de referencia y pueden variar.',
};

async function leerAjustes() {
  const { metaobjectByHandle: m } = await gql(`{ metaobjectByHandle(handle: { type: "catalogo_ajustes", handle: "general" }) { fields { key value } } }`);
  if (!m) return { ...AJUSTES_BASE };
  const f = Object.fromEntries(m.fields.map((x) => [x.key, x.value]));
  const num = (k, base) => (f[k] && !Number.isNaN(Number(f[k])) ? Number(f[k]) : base);
  const bool = (k, base) => (f[k] == null ? base : f[k] !== 'false');
  return {
    tamanoNombre: num('tamano_nombre', AJUSTES_BASE.tamanoNombre),
    tamanoReferencia: num('tamano_referencia', AJUSTES_BASE.tamanoReferencia),
    tamanoPrecio: num('tamano_precio', AJUSTES_BASE.tamanoPrecio),
    tamanoAviso: num('tamano_aviso', AJUSTES_BASE.tamanoAviso),
    mostrarReferencia: bool('mostrar_referencia', AJUSTES_BASE.mostrarReferencia),
    mostrarSku: bool('mostrar_sku', AJUSTES_BASE.mostrarSku),
    colorPrecio: f.color_precio || AJUSTES_BASE.colorPrecio,
    notaPrecios: f.nota_precios || AJUSTES_BASE.notaPrecios,
    avisoHojas: f.aviso_hojas || AJUSTES_BASE.avisoHojas,
  };
}

async function leerCatalogos() {
  const data = await gql(`{
    metaobjects(type: "catalogo_pdf", first: 250) {
      nodes {
        id handle updatedAt
        fields {
          key value
          reference { ... on Collection { id handle title } ... on GenericFile { id url } ... on MediaImage { id image { url } } }
          references(first: 250) { nodes { ... on Product { id } } }
        }
      }
    }
  }`);
  return data.metaobjects.nodes.map((m) => {
    const f = Object.fromEntries(m.fields.map((x) => [x.key, x]));
    const val = (k) => (f[k] ? f[k].value : null);
    const ids = (k) => (f[k] && f[k].references ? f[k].references.nodes.map((n) => n.id).filter(Boolean) : []);
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
      orden: val('orden_productos') || 'Como en la colección',
      incluir: ids('incluir_productos'),
      excluir: ids('excluir_productos'),
      huella: val('huella'),
      pdfId: val('pdf'),
      pdfSinPreciosId: val('pdf_sin_precios'),
      portadaUrl: f.portada && f.portada.reference && f.portada.reference.image ? f.portada.reference.image.url : null,
      // What the PDF had last time ([id, price, sku, name] each), to record what changed
      previos: (() => {
        try {
          return JSON.parse(val('productos_ids') || 'null');
        } catch (e) {
          return null;
        }
      })(),
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

async function leerPorIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { nodes } = await gql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${CAMPOS_PRODUCTO} } } }`, { ids: ids.slice(i, i + 100) });
    out.push(...nodes.filter((n) => n && n.id));
  }
  return out;
}

const ORDENES = {
  'Nombre (A-Z)': (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base', numeric: true }),
  'Más nuevos primero': (a, b) => b.creado.localeCompare(a.creado),
  'Más antiguos primero': (a, b) => a.creado.localeCompare(b.creado),
  // Same price: newest first
    'Precio: menor a mayor': (a, b) => a.precio - b.precio || b.creado.localeCompare(a.creado),
  'Precio: mayor a menor': (a, b) => b.precio - a.precio || b.creado.localeCompare(a.creado),
};

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

  // Manual adjustments: added products go at the end (before sorting), removed ones never enter
  const ya = new Set(nodes.map((n) => n.id));
  const extra = await leerPorIds(catalogo.incluir.filter((id) => !ya.has(id)));
  const quitar = new Set(catalogo.excluir);
  const candidatos = [...nodes, ...extra].filter((p) => !quitar.has(p.id));

  const todos = candidatos.filter((p) => p.status === 'ACTIVE' && p.onlineStoreUrl);
  const productos = todos.filter((p) => p.featuredMedia && p.totalInventory > 0).map(aProducto);
  const orden = ORDENES[catalogo.orden];
  if (orden) productos.sort(orden);

  // Why each product of the source is not in the PDF (for the change history)
  const motivos = new Map();
  for (const p of nodes) if (quitar.has(p.id)) motivos.set(p.id, 'Quitado a mano');
  for (const p of candidatos) {
    if (p.status !== 'ACTIVE' || !p.onlineStoreUrl) motivos.set(p.id, 'Oculto o sin publicar');
    else if (!p.featuredMedia) motivos.set(p.id, 'Sin foto');
    else if (!(p.totalInventory > 0)) motivos.set(p.id, 'Sin inventario');
  }

  return {
    productos,
    motivos,
    excluidos: {
      sinFoto: todos.filter((p) => !p.featuredMedia).length,
      sinInventario: todos.filter((p) => p.featuredMedia && !(p.totalInventory > 0)).length,
      inactivos: candidatos.length - todos.length,
      aMano: nodes.length + extra.length - candidatos.length,
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
    creado: p.createdAt || '',
    url: p.onlineStoreUrl,
  };
}

module.exports = { leerAjustes, leerCatalogos, leerProductos };
