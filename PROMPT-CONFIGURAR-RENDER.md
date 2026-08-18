# Prompt para configurar Render

Copia todo lo que hay debajo de la línea y pégalo en una sesión nueva.

---

Necesito configurar y desplegar en Render un proyecto que ya tengo hecho. **No
soy desarrollador**: dame los comandos completos, sin marcadores de posición que
yo tenga que sustituir, y dime siempre en qué carpeta o en qué pantalla
ejecutarlos.

## Qué es el proyecto

**Mundo Love Pet — Shopify × Bsale.** Una integración entre la tienda Shopify de
Mundo Love Pet y Bsale Perú (facturación electrónica). Está en **Fase 1 de 10**:
por ahora solo conecta con ambas APIs, cifra las credenciales y muestra el
estado en un panel. Todavía no escribe precios ni stock, no crea clientes y no
emite comprobantes.

Node + TypeScript, Express, Prisma sobre PostgreSQL. 91 pruebas automáticas en
verde y typecheck limpio.

Lee primero, en este orden:

1. `DESPLIEGUE-RENDER.md` — la guía de despliegue propia del proyecto
2. `render.yaml` — el blueprint, ya preparado para la Fase 1
3. `.env.example` — todas las variables, explicadas
4. `src/config/env.ts` — la validación real que decide si la app arranca

## Objetivo concreto

Cerrar la Fase 1. Eso significa exactamente esto:

1. El servicio desplegado y respondiendo en `/api/health`
2. El panel accesible
3. **Las dos tarjetas de conexión en verde** — Shopify y Bsale — con mis
   credenciales reales
4. `GET /api/connections/bsale/discover` devolviendo los IDs reales de mi cuenta

## Qué está ya resuelto — no lo rehagas

- **La migración inicial de Prisma** existe en
  `prisma/migrations/20260817000000_inicial/migration.sql`, con las 9 tablas y
  12 enums, en UTF-8, y su `migration_lock.toml`.
- **`.gitignore` y `.env.example`** están creados.
- **`render.yaml` ya está ajustado a la Fase 1**: solo declara la base de datos
  `mlp-db` y el servicio web `mlp-sync`. La cola Key Value, el worker y el cron
  están comentados a propósito porque hoy no hacen nada y costarían unos 21 USD
  al mes. Cada bloque lleva escrito en qué fase reactivarlo.

## Configuración del servicio

| Campo | Valor |
|---|---|
| Runtime | Node |
| Región | Virginia (la misma que la base de datos, o la URL interna no resuelve) |
| Plan | Starter — **no** el gratuito |
| Build command | `npm ci && npx prisma generate && npm run build` |
| Pre-deploy command | `npx prisma migrate deploy` |
| Start command | `node dist/server.js` |
| Health check path | `/api/health` |
| Root directory | vacío |

La base de datos: plan `basic-256mb`, PostgreSQL 18, misma región. **No uses el
plan gratuito de Postgres**: expira y no tiene backups. Aquí se guardan
credenciales cifradas y el historial de documentos emitidos.

## Variables de entorno

Para la Fase 1 solo necesito rellenar **tres**:

- `SHOPIFY_SHOP_DOMAIN` — formato exacto `algo.myshopify.com`, sin `https://` ni
  barra final. La app lo valida con una expresión regular y no arranca si está mal.
- `SHOPIFY_ADMIN_TOKEN` — empieza por `shpat_`
- `BSALE_ACCESS_TOKEN`

Las demás que Render pida (`BSALE_*_ID`, `S3_*`, `ADMIN_PASSWORD_HASH`,
`SHOPIFY_WEBHOOK_SECRET`) van **vacías**: son opcionales en el validador. Los
IDs de Bsale los descubre la propia app en el último paso.

`ENCRYPTION_KEY`, `SESSION_SECRET` y `BSALE_WEBHOOK_PATH_SECRET` las genera
Render automáticamente (`generateValue: true`). No las toques.

Dos requisitos que la app comprueba al arrancar y conviene no romper:

- `ENCRYPTION_KEY` debe decodificar desde base64 a **exactamente 32 bytes**
- `SESSION_SECRET` debe tener **al menos 32 caracteres**

## Errores que ya me han costado tiempo — avísame si los ves

- **Pegar la línea entera en el campo del valor.** Si el valor acaba siendo
  `SHOPIFY_SHOP_DOMAIN=algo.myshopify.com` en vez de `algo.myshopify.com`, la
  app falla con un error de validación que no lo dice claro.
- **Barra final en las URL.** Rompe cosas de forma silenciosa.
- **PowerShell y los redirecciones `>`.** Escriben el archivo en UTF-16 y
  cualquier herramienta que lo lea después falla. Si me haces generar un archivo
  así, dime cómo guardarlo en UTF-8.
- **`npm install` con `NODE_ENV=production`** se salta las devDependencies, y el
  build las necesita.

## Cómo verificar que quedó bien

Por orden. Si uno falla, no sigas al siguiente:

1. `GET /api/health` responde
2. El panel carga
3. `GET /api/connections` — devuelve el estado y **nunca** tokens
4. `POST /api/connections/test-all` — ambas conexiones en verde
5. `GET /api/connections/bsale/discover` — sucursales, tipos de documento,
   impuestos y listas de precio de mi cuenta

Sobre el paso 5, un aviso que trae la documentación del proyecto y quiero
respetar: **los IDs de «Boleta Electrónica» y «Factura Electrónica» varían entre
cuentas de Bsale.** La app sugiere candidatos, pero la confirmación es mía.
Aceptar la sugerencia sin mirarla es la forma más rápida de emitir el
comprobante equivocado ante SUNAT. Enséñame el resultado y déjame confirmarlo
antes de guardar nada.

## Cómo quiero que trabajes

Paso a paso, verificando antes de concluir. Si un dato no lo puedes comprobar,
pídemelo en vez de asumirlo. No toques la configuración de mi tienda Shopify ni
de mi cuenta Bsale sin avisarme antes.
