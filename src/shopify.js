// Minimal Admin GraphQL client. Credentials come from environment variables (GitHub secrets):
//   SHOPIFY_STORE          piuct7-r0.myshopify.com
//   SHOPIFY_CLIENT_ID      + SHOPIFY_CLIENT_SECRET   (app from the Dev Dashboard), or
//   SHOPIFY_TOKEN          (legacy custom app Admin API token)
const API_VERSION = '2026-10';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null;

async function obtenerToken() {
  if (token) return token;
  if (process.env.SHOPIFY_TOKEN) return (token = process.env.SHOPIFY_TOKEN);
  const { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) throw new Error('Faltan SHOPIFY_TOKEN o SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  // Client credentials grant: the app is installed on its own store, so no user login is needed
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`No se pudo obtener el token de Shopify (${res.status}): ${await res.text()}`);
  return (token = (await res.json()).access_token);
}

async function gql(query, variables = {}, tries = 6) {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error('Falta SHOPIFY_STORE');
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': await obtenerToken() },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (i + 1));
      continue;
    }
    const body = await res.json();
    if (body.errors) {
      // Throttling and Shopify's occasional internal errors are temporary: wait and try again
      if (body.errors.some((e) => e.extensions && ['THROTTLED', 'INTERNAL_SERVER_ERROR'].includes(e.extensions.code))) {
        await sleep(2000 * (i + 1));
        continue;
      }
      throw new Error(`Shopify: ${JSON.stringify(body.errors)}`);
    }
    // Keep a margin in the cost bucket so long runs don't hit the limit
    const cost = body.extensions && body.extensions.cost;
    if (cost && cost.throttleStatus.currentlyAvailable < 300) await sleep(1500);
    return body.data;
  }
  throw new Error('Shopify no respondió después de varios intentos');
}

function revisarErrores(payload, accion) {
  const errs = payload && payload.userErrors;
  if (errs && errs.length) throw new Error(`${accion}: ${JSON.stringify(errs)}`);
  return payload;
}

module.exports = { gql, revisarErrores, sleep };
