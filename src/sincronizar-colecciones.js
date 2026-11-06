// Keeps each store collection in step with its catalog's manual changes (owner request 2026-11-06):
//  - "Quitar" in a catalog  → the product is excluded from that catalog's collection
//  - "Agregar" in a catalog → the product is included in that collection by hand
// Done through the collection's own conditions source (manual exclusion / inclusion selections), so
// the collection's rules stay as they are. What the app added is remembered in the collection
// metafield gestion.sincronizado, so exclusions or inclusions made by hand in Shopify are never touched.
const { gql, revisarErrores } = require('./shopify');

const LOTE = 100;

async function seleccionesDe(coleccionId) {
  const { collection } = await gql(
    `query($id: ID!) { collection(id: $id) { title metafield(namespace: "gestion", key: "sincronizado") { value }
      sources { ... on CollectionConditionsSource { id
        exclusion { selections(first: 250) { nodes { product { id } } } }
        inclusion { selections(first: 250) { nodes { product { id } } } } } } } }`,
    { id: coleccionId }
  );
  if (!collection) return null;
  const fuente = collection.sources.find((s) => s.id && s.id.includes('CollectionConditionsSource'));
  let previo = { excluir: [], incluir: [] };
  try {
    previo = { ...previo, ...JSON.parse((collection.metafield && collection.metafield.value) || '{}') };
  } catch (e) {
    // keep the empty record
  }
  return {
    titulo: collection.title,
    fuenteId: fuente && fuente.id,
    excluidos: new Set(fuente && fuente.exclusion ? fuente.exclusion.selections.nodes.map((n) => n.product.id) : []),
    incluidos: new Set(fuente && fuente.inclusion ? fuente.inclusion.selections.nodes.map((n) => n.product.id) : []),
    previo,
  };
}

async function actualizar(coleccionId, fuenteId, cambios) {
  const pasos = [];
  const add = (campo, lista, ids) => {
    for (let i = 0; i < ids.length; i += LOTE) pasos.push({ [campo]: { [lista]: ids.slice(i, i + LOTE).map((productId) => ({ productId })) } });
  };
  add('inclusion', 'selectionsToRemove', cambios.incluirQuitar);
  add('inclusion', 'selectionsToAdd', cambios.incluirAgregar);
  add('exclusion', 'selectionsToRemove', cambios.excluirQuitar);
  add('exclusion', 'selectionsToAdd', cambios.excluirAgregar);
  for (const paso of pasos) {
    revisarErrores(
      (
        await gql(`mutation($c: CollectionUpdateInput!) { collectionUpdate(collection: $c) { userErrors { field message } } }`, {
          c: { id: coleccionId, sourcesToUpdate: [{ condition: { id: fuenteId, ...paso } }] },
        })
      ).collectionUpdate,
      'Sincronizar colección'
    );
  }
}

async function guardarRegistro(coleccionId, registro) {
  revisarErrores(
    (
      await gql(`mutation($c: CollectionUpdateInput!) { collectionUpdate(collection: $c) { userErrors { field message } } }`, {
        c: { id: coleccionId, metafields: [{ namespace: 'gestion', key: 'sincronizado', type: 'json', value: JSON.stringify(registro) }] },
      })
    ).collectionUpdate,
    'Guardar registro de sincronización'
  );
}

// catalogos: active catalogs built from a collection (from fuente-admin.leerCatalogos)
async function sincronizarColecciones(catalogos) {
  // A collection used by several catalogs gets the union of their manual changes
  const porColeccion = new Map();
  for (const c of catalogos) {
    if (c.origen !== 'Colección' || !c.coleccion) continue;
    const g = porColeccion.get(c.coleccion.id) || { excluir: new Set(), incluir: new Set() };
    c.excluir.forEach((id) => g.excluir.add(id));
    c.incluir.forEach((id) => g.incluir.add(id));
    porColeccion.set(c.coleccion.id, g);
  }

  const resumen = [];
  for (const [coleccionId, deseado] of porColeccion) {
    const actual = await seleccionesDe(coleccionId);
    if (!actual || !actual.fuenteId) continue;
    const previoEx = new Set(actual.previo.excluir);
    const previoIn = new Set(actual.previo.incluir);
    const excluirAgregar = [...deseado.excluir].filter((id) => !actual.excluidos.has(id));
    const cambios = {
      excluirAgregar,
      // Only undo what the app itself excluded
      excluirQuitar: [...previoEx].filter((id) => !deseado.excluir.has(id) && actual.excluidos.has(id)),
      incluirAgregar: [...deseado.incluir].filter((id) => !actual.incluidos.has(id) && !deseado.excluir.has(id)),
      // What the app added and the catalog no longer has, plus anything included by hand in Shopify that
      // the catalog now removes (Shopify won't exclude a product that is manually included)
      incluirQuitar: [
        ...new Set([
          ...[...previoIn].filter((id) => !deseado.incluir.has(id) && actual.incluidos.has(id)),
          ...excluirAgregar.filter((id) => actual.incluidos.has(id)),
        ]),
      ],
    };
    // Inclusions first, so a product is no longer included by hand when it gets excluded
    const ordenados = { incluirQuitar: cambios.incluirQuitar, incluirAgregar: cambios.incluirAgregar, excluirQuitar: cambios.excluirQuitar, excluirAgregar: cambios.excluirAgregar };
    const total = Object.values(cambios).reduce((n, l) => n + l.length, 0);
    if (total) {
      try {
        await actualizar(coleccionId, actual.fuenteId, ordenados);
      } catch (e) {
        // One collection failing must not stop the others
        resumen.push({ coleccion: actual.titulo, error: e.message });
        continue;
      }
      resumen.push({
        coleccion: actual.titulo,
        excluidos: cambios.excluirAgregar.length,
        devueltos: cambios.excluirQuitar.length,
        agregados: cambios.incluirAgregar.length,
        retirados: cambios.incluirQuitar.length,
      });
    }
    const registro = { excluir: [...deseado.excluir], incluir: [...deseado.incluir] };
    if (JSON.stringify(registro) !== JSON.stringify({ excluir: actual.previo.excluir, incluir: actual.previo.incluir })) await guardarRegistro(coleccionId, registro);
  }
  return resumen;
}

module.exports = { sincronizarColecciones };
