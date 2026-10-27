// Publishes a generated PDF: uploads it to Shopify Files, makes sure the fixed link
// /catalogos/<slug> exists (URL redirect), and deletes the previous file.
const { gql, revisarErrores, sleep } = require('./shopify');

async function subirPDF(bytes, filename) {
  const staged = revisarErrores(
    (
      await gql(
        `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
        { input: [{ resource: 'FILE', filename, mimeType: 'application/pdf', httpMethod: 'POST', fileSize: String(bytes.length) }] }
      )
    ).stagedUploadsCreate,
    'Preparar subida'
  ).stagedTargets[0];

  const form = new FormData();
  for (const p of staged.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  const up = await fetch(staged.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Subida del PDF falló (${up.status})`);

  const created = revisarErrores(
    (
      await gql(
        `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id } userErrors { field message } } }`,
        { files: [{ originalSource: staged.resourceUrl, contentType: 'FILE', filename, duplicateResolutionMode: 'APPEND_UUID' }] }
      )
    ).fileCreate,
    'Crear archivo'
  ).files[0];

  // Shopify processes the file asynchronously; its URL appears once it is READY
  for (let i = 0; i < 30; i++) {
    const { node } = await gql(`query($id: ID!) { node(id: $id) { ... on GenericFile { fileStatus url } } }`, { id: created.id });
    if (node && node.fileStatus === 'READY' && node.url) return { id: created.id, url: node.url };
    if (node && node.fileStatus === 'FAILED') throw new Error(`Shopify no pudo procesar ${filename}`);
    await sleep(2000);
  }
  throw new Error(`${filename} tardó demasiado en procesarse`);
}

async function enlaceFijo(path, target) {
  const { urlRedirects } = await gql(`query($q: String!) { urlRedirects(first: 5, query: $q) { nodes { id path target } } }`, { q: `path:${path}` });
  const existing = urlRedirects.nodes.find((r) => r.path === path);
  if (existing && existing.target === target) return;
  if (existing) {
    revisarErrores((await gql(`mutation($id: ID!, $r: UrlRedirectInput!) { urlRedirectUpdate(id: $id, urlRedirect: $r) { userErrors { field message } } }`, { id: existing.id, r: { path, target } })).urlRedirectUpdate, 'Actualizar enlace');
  } else {
    revisarErrores((await gql(`mutation($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { userErrors { field message } } }`, { r: { path, target } })).urlRedirectCreate, 'Crear enlace');
  }
}

async function borrarArchivos(ids) {
  const list = ids.filter(Boolean);
  if (!list.length) return;
  const res = await gql(`mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { userErrors { field message } } }`, { ids: list });
  // A missing old file is not a reason to fail the run
  if (res.fileDelete.userErrors.length) console.warn('  aviso al borrar archivos anteriores:', JSON.stringify(res.fileDelete.userErrors));
}

async function guardarResultado(catalogoId, campos) {
  const fields = Object.entries(campos).map(([key, value]) => ({ key, value: value == null ? '' : String(value) }));
  revisarErrores((await gql(`mutation($id: ID!, $m: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $m) { userErrors { field message } } }`, { id: catalogoId, m: { fields } })).metaobjectUpdate, 'Guardar resultado del catálogo');
}

module.exports = { subirPDF, enlaceFijo, borrarArchivos, guardarResultado };
