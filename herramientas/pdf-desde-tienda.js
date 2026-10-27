// Renders a catalog PDF from the public storefront JSON (no credentials needed), to preview the
// design or test the publishing steps by hand. Prices in the storefront JSON already include the
// market adjustment. The real job uses the Admin API (generar.js).
//   node herramientas/pdf-desde-tienda.js <coleccion> "<Título>" [2x2|3x3] [--sin-precios]
const fs = require('fs');
const path = require('path');
const { partirNombre } = require('../src/nombre');
const { crearPDF } = require('../src/pdf');
const TIENDA = require('../tienda.json');

(async () => {
  const [handle, titulo, disposicion = '3x3'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const sinPrecios = process.argv.includes('--sin-precios');
  const products = [];
  for (let page = 1; ; page++) {
    const { products: batch } = await (await fetch(`${TIENDA.web}/collections/${handle}/products.json?limit=250&page=${page}`)).json();
    products.push(...batch);
    if (batch.length < 250) break;
  }
  const productos = products
    .filter((p) => p.images.length && p.variants.some((v) => v.available))
    .map((p) => {
      const prices = p.variants.filter((v) => v.available).map((v) => Math.round(Number(v.price)));
      return { id: p.id, title: p.title, ...partirNombre(p.title), sku: p.variants[0].sku || '', image: p.images[0].src, precio: Math.min(...prices), precioVariable: new Set(prices).size > 1, url: `${TIENDA.web}/products/${p.handle}` };
    });
  const slug = `${handle}${sinPrecios ? '-sin-precios' : ''}`;
  const bytes = await crearPDF({ catalogo: { titulo, mostrarPrecios: !sinPrecios, disposicion }, tienda: TIENDA, productos, slug });
  const out = path.join(__dirname, '..', 'salida', `${slug}.pdf`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(out, productos.length, 'productos', bytes.length, 'bytes');
})();
