// One-off migration: downloads the designed cover of each Catalogly online catalog into
// portadas/<slug>.jpg, to upload them as the "Portada" of our catalogs. The cover file names were
// read from each online catalog's first page (its first full-page background image).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PORTADAS = {
  crisalida: 'aa9af0cb-11a7-4a44-9ecc-0da046f1b20a/page-img-bg-MmMzYTRkNDU0YzlhMTk3ZTc3Yjk4MWNiMWQ4OThlMWRlOTE2MjcwOWQ0ZDBjOGEzYzIwNjRmNGQ3MTI4MWFhMQ',
  medias: '3b7614ec-0afd-401f-ac65-3398ffd06f98/page-img-bg-ODBiYWU1OGRmMTkzMDI0OGVhOTFhNWIyN2Q5YTEzNDVhNTIyOGEzZGUyYjM5NjIyMDdhYzc1M2M2YzgxMjZkZg',
  outlet: 'd0ad8477-1e94-4ed5-9056-b260dbb9b5ba/page-img-bg-Y2Q4OWMwZDc3NzcyNGY5Y2I0NjZiMDQ2YTYwMjliZWYxNWQ2NDFmYzhkYWNlNzM5MWM5OGJmYWJkMjZkZjgyOA',
  'ropa-interior': '7910daae-7679-44f8-b624-06f7d8da95ad/page-img-bg-YTE1YjU3OWE2OTAwY2JlNzQ2YjQyYjIwODQwOTk4YjI2M2JiN2IwOGY3ZTdmNjhlNDFiOTE2NzBkZjg3Y2FiNg',
  'ropa-nina': 'a38b1d2a-40be-4d69-9115-bb969bb07f13/page-img-bg-MmJlMDk2YWQzNjQxZDE3MDk4OGNmZTFhZDc3ODgwMDUyOTU2YWY3YjAzMmNkMTg2NzYzNzhjNmEzNzIxYjhjOA',
  'ropa-nino': '60c08bee-3c6d-474e-b734-828b1f2a66c4/page-img-bg-MzI0NGY5MzI4NzE3YmEwMmFiNjQ4N2E3ZDNlZGY4NzBlMGE3Y2UyYzM1NDBkYzg3MDAzZTRkZWVhODJhMjllYw',
  'ropa-hombre': '073986f7-d97c-4bfd-8be2-5e41b11705f8/page-img-bg-NmZjYmU0OGU0NWQzM2Q4NTY4OTY2YjI4Y2Q0ZTg3ZGJkOWE4NmFmOGNlNjkwZmE5MmU1OGVhMDJhOWY5ZjlmOQ',
  'ropa-dama': '8b4d86cd-ad7d-4159-8267-c6ac00b4af43/page-img-bg-MmYzY2U1ZDM0NzA2OTM4NmRiOGRhOGI2NDBmNGFkMmVlYTdiZmMzZWRhNWJjM2RhOTA1MGNiMmEzZDg0MTk0MQ',
  bebe: '5caad64c-244c-4ca4-b41a-d9286680cbb6/page-img-bg-NDk3NDg4ODg2OGZiZDAyMmU3MjE1YzZhZjc1OWYxYzMxZTcyYTYxYzQ3MWU2NGM5YjQzNDk2YmIyMjM3NDY4YQ',
  'lenceria-hogar-nuevo': '02128557-a47a-4482-bf72-5f727e00d42a/page-img-bg-Mjc4M2YzMDU3MDZkYzRjNzYwNDcyMDVhZmNhMmI3Njc4YjQ0NDRlZDc2Zjg4NTY2NTM3NjBiZmZkMzExYjE5Nw',
  escolar: '6c173047-ab4c-40ad-b279-ea9f97bf247d/page-img-bg-YjdlMzU2MmRkOThjMWRjNzZmY2JiZDhmZjQ3ZGQxYzgyNTZmMzUwYjczYWM3YzU5ZTJjZTY5ZWMzNWRlMzM1MQ',
  sentimientos: '13c4e80b-046f-4bda-9687-a49fe73b0c07/page-img-bg-MmE0YzU5N2ZmMGZmOGE1ZGQyYTdiYWEwZDhkNjJkOTUwMzcyMzZjYzViOWMxNDE2MWNmMjZjZjRiZGM4NzJiYQ',
  ferreteria: '316407dd-6bcb-4426-bfc5-3d7f4912be2e/page-img-bg-Y2I0NWZiMmRiNDBmZDA0NjM5OWZjZWM1YjAyM2JiNzljODBjZjc3YTM2OWU2OWNjNGZlYWE3Njc5ZDMzYjg4NQ',
  bolsos: 'caeb419c-827f-4517-996b-f7341f986956/page-img-bg-Y2QxZGNlYTQwMzFkZDRmZTA3NjNjMTEwMTE4NzY1ODM4NmQzNjk1YzlkNWM3NmJjY2MxMmM2Mzk1ZTkxYTJhYw',
  tecnologia: '5de32633-0f6d-447f-9e39-b90ef0889494/page-img-bg-MTRkYzU2ZjhiZTRjY2RhNjY4MjdhNjFjZTMwNGE5NTlhZDQwYmYzZTY3Yzc2M2I0OTJlZWNjNTBmYjFhMjBhNw',
  termos: '02a7c905-e78f-4a37-accd-c164599c4188/page-img-bg-MWU0ZWZlYjg0N2ViOWJlYzRlNTM4MjkxZTFmZWRkODcyZGQ5NWU3Mzk5NmVjZmI5YmM1ZjNjY2U1MzM5MmE2OA',
  plastico: 'd4336441-38e3-41f2-b72e-7fc6f53a89e7/page-img-bg-ZGQxNzNiODk1ZGQ1ZmZhMGFhNzMxYjIyZTNlM2ZlZDAzMGYyNDM2YzQ4MzRkZTI1NmUyNWFkYmNjZWE0YmRiZA',
  mascotas: '1e27b3f2-7fb4-43dc-b059-4a56a5ccc6e7/page-img-bg-MTFhZThkMDAzMzhmMDhiYjkxZjM3NjE1MzA1YzA1ODhiNzIyZTJkM2UwYmY4ZjhmNmEzOTAzNjA3NDA4YmQxNA',
  cosmeticos: '5ea47afa-b712-4a7b-80b1-8dd9c57698ac/page-img-bg-YjJjYzVjYzE3MTc2M2U4NTYyNjY5ZGQ4ZmIxN2ExNDFiMzViYTY3ODQ4YjlhZWM5MjAxY2NmNjNlM2MzODdhZg',
  cacharro: 'f6469a06-74a9-4e00-9b85-6f74c99097ae/page-img-bg-ZmIzMzY1ZGI3MDhlNDAyZGJiNWM2ZmU5NTk3ZDE1NjhjMDliYzdhOGIyOWZhY2NiNDgxMzcyZGFjMWIzMTM4Mw',
  gorras: 'd5747672-146d-40df-8374-e061aef56b02/page-img-bg-ZTcxYjZlNjQzY2RmZTFkOWVlZWY4OTBhNmMwNmY3ZTA1NDgwNzUwM2Q5NWZhNjI3Njc4YmM3ZjNmYjJkMTA1Yw',
  cocina: 'c37e4a8f-0e37-4aef-b7c9-572ca01993aa/page-img-bg-ZGVmOWU4ZjIyZjliYjI2YTg2Y2ZkZjMxMTA0MmFhODkxNWE2MTY5NzM1NmRkMTY4NzI2ODgzZTc5ZjE2N2U5Mg',
  'lenceria-hogar': '3d964120-fcc0-4e3d-8c31-c601ccde2f18/page-img-bg-M2ZiOGNlMTFjYTg5NmIzM2I4YTNhNmFmNDVjZWRiOWNkOWRmZDRhODU2ODJiMDZmYzk4ZWFiN2FiNmNiZDNiYg',
  jugueteria: 'cd8b0443-7811-4f1d-9cda-96641cf861e3/page-img-bg-YmZhZjU1YTViZDczZDA2MjNkODZhMjhhNWU5ZDdjOTU4ZDNiNWJlZTc4N2MwOTRjNjhkNDhjNjUwODkxMWQ3MA',
  navidad: 'a393b266-852c-43f0-a457-fcc65de64d0a/page-img-bg-YmUzZDAwZDhjZGVhNTg2ZmZkMDlkMTlkYThlMmRhMDFlZWUxNTljNTJiZDQwMWM5YTZiNTM2NWY2ZTY1OTE3YQ',
};

const OUT = path.join(__dirname, '..', 'portadas');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  for (const [slug, ruta] of Object.entries(PORTADAS)) {
    try {
      const res = await fetch(`https://onlinecataloglyapp.com/${ruta}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      const jpg = await sharp(buf).flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
      fs.writeFileSync(path.join(OUT, `${slug}.jpg`), jpg);
      console.log(`${slug}: ${meta.width}x${meta.height} → ${Math.round(jpg.length / 1024)} KB`);
    } catch (e) {
      console.log(`${slug}: error ${e.message}`);
    }
  }
  // Contact sheet to check them at a glance
  const files = Object.keys(PORTADAS).filter((s) => fs.existsSync(path.join(OUT, `${s}.jpg`)));
  const tiles = await Promise.all(files.map((s) => sharp(path.join(OUT, `${s}.jpg`)).resize(180, 224, { fit: 'cover' }).toBuffer()));
  const cols = 7;
  await sharp({ create: { width: cols * 186, height: Math.ceil(tiles.length / cols) * 230, channels: 3, background: '#ffffff' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * 186 + 3, top: Math.floor(i / cols) * 230 + 3 })))
    .jpeg({ quality: 80 })
    .toFile(path.join(OUT, '_hoja.jpg'));
  console.log('hoja de contacto: portadas/_hoja.jpg', files.join(', '));
})();
