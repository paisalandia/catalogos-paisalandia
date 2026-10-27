# Catálogos PDF de Paisalandia

Genera los catálogos en PDF directamente desde Shopify, los actualiza solos cada hora y los publica con un enlace fijo para compartir.

## Cómo funciona

1. **Los catálogos se crean en Shopify**, en *Contenido → Metaobjetos → Catálogo PDF*. Cada catálogo tiene:
   - **Productos desde:** Colección, Etiqueta, Tipo de producto o Marca.
   - **Mostrar precios** y **Generar también versión sin precios**.
   - **Productos por página:** 4 (fotos grandes) o 9 (compacto).
   - **Activo** y **Mostrar en la página Catálogos**.
   - **Orden** en la página.
   - Los campos «(automático)» los llena el generador; no hay que tocarlos.
2. **Cada hora, GitHub Actions** ejecuta `generar.js`, que hace esto con cada catálogo activo:
   - Lee sus productos y deja solo los **activos, publicados en la tienda, con foto y con inventario**. Los productos que se reactivan entran solos en la siguiente hora.
   - Usa el **precio del mercado de Colombia**, el mismo que ve el cliente (IVA incluido).
   - **Solo si algo cambió** (productos, precios, fotos o ajustes), arma el PDF, lo sube a *Contenido → Archivos* y borra el anterior.
3. **Enlaces fijos para compartir** (nunca cambian):
   - `mayoristapaisalandia.com/catalogos/<nombre>` → con precios
   - `mayoristapaisalandia.com/catalogos/<nombre>-sin-precios` → sin precios
   - `<nombre>` es el identificador del catálogo en Shopify (ej.: `navidad`, `ropa-dama`).
4. **Página pública:** `mayoristapaisalandia.com/pages/catalogos` muestra todos los catálogos, con botones para ver el PDF y compartirlo por WhatsApp.
5. **Seguimiento:** cada producto del PDF lleva a su página con `utm_source=catalogo`. En *Shopify → Informes* se ven las visitas y ventas que trae cada catálogo (campaña = nombre del catálogo).

## Instalación (una sola vez)

### 1. App de Shopify (permisos de lectura y publicación)

1. Admin de Shopify → **Configuración → Apps → Desarrollar apps** → crear una app en el **Dev Dashboard** llamada «Catálogos PDF».
2. En la versión de la app, en **Admin API**, marca estos permisos:
   - `read_products`, `read_inventory`, `read_markets`
   - `read_metaobjects`, `write_metaobjects`
   - `read_files`, `write_files`
   - `read_online_store_navigation`, `write_online_store_navigation`
3. Publica la versión e **instálala en la tienda Paisalandia**.
4. Copia el **Client ID** y el **Client secret**. Son claves privadas: solo se pegan en GitHub (paso 3), nunca en un chat ni en un correo.

### 2. Repositorio en GitHub

1. Crea una cuenta en github.com, si no tienes una.
2. Crea un repositorio **privado** llamado `catalogos-paisalandia`.
3. Usa **Add file → Upload files** y arrastra el contenido de la carpeta `catalogos-app-subir` (no la carpeta, sino lo que hay dentro).
4. Si la carpeta `.github` no se subió (a veces el navegador oculta las carpetas que empiezan con punto):
   - usa **Add file → Create new file**;
   - escribe como nombre `.github/workflows/catalogos.yml`;
   - pega el contenido de ese archivo.

### 3. Claves en GitHub

En el repositorio: **Settings → Secrets and variables → Actions → New repository secret**. Crea tres claves:

| Nombre | Valor |
|---|---|
| `SHOPIFY_STORE` | `piuct7-r0.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | el Client ID de la app |
| `SHOPIFY_CLIENT_SECRET` | el Client secret de la app |

### 4. Primera ejecución

1. **Actions → Catálogos PDF → Run workflow**, con **forzar** marcado. La primera vez tarda unos 20 a 30 minutos, porque arma todos los catálogos.
2. Desde ahí corre solo cada hora. Cuando no hay cambios, termina en uno o dos minutos.

## Uso diario

- **Nuevo catálogo:** *Contenido → Metaobjetos → Catálogo PDF → Agregar*. Aparece en la siguiente hora; si lo necesitas antes, usa **Run workflow**.
- **Cambiar o regenerar uno ya:** en **Run workflow**, escribe su identificador (ej.: `navidad`) y marca **forzar**.
- **Pausar un catálogo:** apaga **Activo**.
- **Ver qué pasó en una ejecución:** abre la ejecución en **Actions**. Por cada catálogo dice cuántos productos entraron y cuántos quedaron fuera (sin foto, sin inventario, inactivos).

## Para desarrolladores

- `src/fuente-admin.js`: lee catálogos y productos (Admin API).
- `src/pdf.js`: diseño del PDF (portada, cuadrícula de productos, enlaces con UTM).
- `src/publicar.js`: sube a Shopify Files, crea los enlaces fijos y guarda el resultado.
- `src/nombre.js`: separa nombre, referencia y unidad, con las mismas reglas que el tema de la tienda.
- `herramientas/pdf-desde-tienda.js`: arma un PDF desde la tienda pública, sin claves, para probar el diseño.
- `herramientas/vista-previa.mjs`: convierte páginas del PDF en imágenes.
- Si cambias el diseño, sube `VERSION_DISENO` en `generar.js`; así todos los catálogos se regeneran una vez.
- Shopify acepta archivos de hasta 20 MB. Si un catálogo se pasa, el generador reduce la calidad de las fotos automáticamente.
