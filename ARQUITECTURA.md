# Mundo Love Pet — Shopify × Bsale

Documento de arquitectura y plan de implementación
Versión 1.0 · 16 de agosto de 2026

> **Regla base de este documento:** todo endpoint, campo y comportamiento descrito
> está tomado de la documentación oficial vigente de Shopify (shopify.dev) y de
> Bsale (docs.bsale.dev / apiperu.bsalelab.com). Donde la documentación **no**
> especifica algo, se indica explícitamente como *"a confirmar"* en lugar de
> inventarlo.

---

## 1. Arquitectura propuesta

### 1.1 Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Lenguaje / runtime | Node.js 22 LTS + TypeScript 5 | Shopify publica y mantiene SDKs oficiales en JS/TS (`@shopify/shopify-api`, `@shopify/shopify-app-express`). Tipado fuerte reduce errores en payloads fiscales. |
| Tipo de app Shopify | **Custom App** (tienda única) | Token de Admin API directo desde el admin de Shopify. Sin OAuth, sin Partners, sin revisión. Es lo correcto porque la app es sólo para Mundo Love Pet. |
| API de Shopify | **Admin GraphQL API `2026-07`** | Es la versión estable más reciente. La Admin REST API está en modo legacy; Shopify dirige todo desarrollo nuevo a GraphQL. |
| API de Bsale | **API REST v1 Perú** (`https://api.bsale.io/v1/...`) | Única API oficial. Auth por header `access_token`. |
| Base de datos | PostgreSQL 16 + Prisma | Transacciones ACID, necesarias para la garantía anti-duplicados. |
| Colas / background | BullMQ sobre Redis 7 | Reintentos con backoff, jobs idempotentes, concurrencia controlada por API. |
| Panel | React 18 + Vite + TailwindCSS | SPA servida por el mismo backend, autenticada por sesión. |
| Despliegue | Docker Compose en VPS + Caddy (HTTPS automático) | Portable, barato, control total. |

> **Alternativa gestionada:** la app también corre en **Render** (PaaS). El
> blueprint está en [`render.yaml`](./render.yaml) y la guía completa en
> [`DESPLIEGUE-RENDER.md`](./DESPLIEGUE-RENDER.md). Un cambio importante en esa
> opción: los comprobantes PDF **no** pueden guardarse en disco (en Render un
> disco es accesible por un único servicio, y el worker que descarga el PDF no
> es el mismo que lo sirve). Ahí se usa almacenamiento S3-compatible con URLs
> firmadas de corta duración.

### 1.2 Diagrama de componentes

```
                          Internet (HTTPS / TLS 1.2+)
                                     │
                          ┌──────────▼───────────┐
                          │   Caddy (reverse      │
                          │   proxy + Let's       │
                          │   Encrypt)            │
                          └──────────┬───────────┘
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
     ┌────────▼────────┐   ┌─────────▼─────────┐  ┌─────────▼─────────┐
     │  Panel React    │   │  API / Webhooks   │  │  Worker BullMQ    │
     │  (estático)     │   │  (Express + TS)   │  │  (proceso aparte) │
     └─────────────────┘   └─────────┬─────────┘  └─────────┬─────────┘
                                     │                       │
                     ┌───────────────┼───────────────────────┤
                     │               │                       │
            ┌────────▼──────┐ ┌──────▼──────┐        ┌───────▼───────┐
            │ PostgreSQL 16 │ │  Redis 7    │        │ Almacenamiento│
            │ (estado,      │ │ (colas +    │        │ de PDFs       │
            │  mapeos, logs)│ │  idempot.)  │        │ (disco/S3     │
            └───────────────┘ └─────────────┘        │  privado)     │
                                                     └───────────────┘
                     │                                       │
     ┌───────────────▼───────────────┐   ┌───────────────────▼──────────┐
     │  Shopify Admin GraphQL 2026-07│   │  Bsale API v1 (api.bsale.io) │
     └───────────────────────────────┘   └──────────────────────────────┘
```

### 1.3 Separación de capas

```
src/
├── config/          Validación de variables de entorno (zod). Falla al arrancar si falta algo.
├── lib/             Cripto (AES-256-GCM), logger con redacción, enmascarado, errores.
├── integrations/
│   ├── bsale/       Cliente HTTP Bsale + tipos + rate limiter + mapeo de errores.
│   └── shopify/     Cliente GraphQL Shopify + verificación HMAC + manejo de coste de consulta.
├── domain/          Reglas de negocio puras y testeables (boleta vs factura, resolución de SKU,
│                    normalización de precios, validación de DNI/RUC). Sin I/O.
├── services/        Orquestación: sincronización de productos, stock, precios, pedidos, documentos.
├── queues/          Definición de colas BullMQ, jobs, políticas de reintento.
├── routes/          Endpoints HTTP: API del panel + receptores de webhooks.
├── db/              Prisma client, repositorios.
└── web/             SPA React del panel de administración.
```

**Por qué `domain/` está separado:** la decisión "esto es boleta o es factura" y "este
SKU corresponde a esta variante" son las reglas que más caro cuesta equivocar
(un documento mal emitido ante SUNAT). Al ser funciones puras sin red ni base de
datos, se pueden cubrir al 100 % con tests automáticos.

---

## 2. Requisitos

### 2.1 Infraestructura mínima

| Recurso | Mínimo | Recomendado |
|---|---|---|
| VPS | 2 vCPU / 4 GB RAM / 40 GB SSD | 4 vCPU / 8 GB RAM / 80 GB SSD |
| Sistema | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |
| Software | Docker Engine 26+, Docker Compose v2 | idem |
| Dominio | Uno con DNS apuntando al VPS (ej. `sync.mundolovepet.pe`) | idem |
| Certificado | Let's Encrypt vía Caddy (automático) | idem |
| Backups | Dump diario de PostgreSQL fuera del VPS | Backup gestionado + retención 30 días |

**El dominio con HTTPS válido es obligatorio, no opcional:** Shopify no entrega
webhooks a endpoints HTTP ni a certificados autofirmados, y Bsale solicita
expresamente que la notificación POST sea sobre SSL.

### 2.2 Cuentas y accesos

- Acceso de propietario o staff con permiso "Apps y canales de venta" en la tienda Shopify.
- Cuenta Bsale Perú activa con facturación electrónica habilitada ante SUNAT.
- Token de acceso de Bsale en producción (ver §3.2).
- Opcional pero muy recomendado: cuenta sandbox gratuita en `account.bsale.dev`
  para probar sin emitir documentos reales.

### 2.3 Variables de entorno

Ninguna credencial vive en el código ni en el frontend. Todas se inyectan por entorno:

```
NODE_ENV, PORT, APP_URL, DATABASE_URL, REDIS_URL,
ENCRYPTION_KEY            # 32 bytes en base64, clave maestra AES-256-GCM
SESSION_SECRET            # firma de cookies del panel
ADMIN_EMAIL, ADMIN_PASSWORD_HASH   # acceso al panel (argon2id)
SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION, SHOPIFY_WEBHOOK_SECRET
BSALE_ACCESS_TOKEN, BSALE_API_BASE_URL, BSALE_OFFICE_ID, BSALE_PRICE_LIST_ID
BSALE_DOCTYPE_BOLETA_ID, BSALE_DOCTYPE_FACTURA_ID, BSALE_TAX_ID_IGV
BSALE_WEBHOOK_SHARED_SECRET
```

---

## 3. Permisos necesarios

### 3.1 Shopify — scopes de la app

> **Actualización (17/08/2026).** Desde el 1 de enero de 2026 Shopify no permite
> crear apps personalizadas desde el admin de la tienda. Las apps nuevas se
> crean en el Dev Dashboard y **no entregan un token estático `shpat_`**: dan
> Client ID y Client Secret, y el token se pide con el flujo de *client
> credentials*, caducando cada ~24 h.
>
> La app lo renueva sola en `src/integrations/shopify/token.ts`. Las variables
> de entorno son `SHOPIFY_CLIENT_ID` y `SHOPIFY_CLIENT_SECRET`; ya no existe
> `SHOPIFY_ADMIN_TOKEN`.
>
> Los scopes de abajo no cambian: se configuran igual, solo que en el Dev
> Dashboard.


Se aplica el principio de privilegio mínimo. Se piden **sólo** estos:

| Scope | Para qué |
|---|---|
| `read_products`, `write_products` | Leer catálogo, resolver SKU → variante, actualizar precios. |
| `read_inventory`, `write_inventory` | Leer y fijar niveles de inventario por ubicación. |
| `read_orders` | Leer pedidos que se van a facturar. |
| `read_customers` | Leer datos del comprador para armar el cliente en Bsale. |
| `read_locations` | Resolver la ubicación (location) a la que se aplica el stock. |
| `write_order_edits` *(opcional)* | Sólo si se decide escribir metafields de orden con el número de comprobante. |

**No se piden:** `write_orders`, `write_customers`, `read_all_orders`,
`write_discounts`, ni ningún scope de checkout. La app nunca modifica pedidos ni
clientes en Shopify.

> ⚠️ `read_orders` en una Custom App sólo devuelve los últimos 60 días de
> pedidos. Para el histórico completo se requiere `read_all_orders`, que Shopify
> concede bajo solicitud. Para esta integración (facturar pedidos nuevos) los 60
> días son suficientes; se documenta por si más adelante se quiere migrar
> histórico.

### 3.2 Bsale — token de acceso

- El `access_token` de Bsale es **por usuario**, no por aplicación.
- Se envía en la cabecera: `access_token: <token>`.
- Recomendación fuerte: crear en Bsale un **usuario de integración dedicado**
  (ej. "Integración Shopify") en lugar de usar el token personal del dueño. Así
  los documentos quedan atribuidos a ese usuario y el token se puede revocar sin
  afectar a nadie más.
- Token de pruebas: `https://account.bsale.dev/users/create`.
- Token de producción: se gestiona por el flujo descrito en `docs.bsale.dev/oauth`.

---

## 4. Endpoints oficiales que se utilizarán

### 4.1 Bsale — `https://api.bsale.io/v1` · header `access_token`

| Recurso | Método y ruta | Uso en la app |
|---|---|---|
| Sucursales | `GET /v1/offices.json` | **Prueba de conexión** y selector de sucursal en Configuración. |
| Productos | `GET /v1/products.json` | Catálogo base (nombre, tipo de producto). |
| Variantes | `GET /v1/variants.json?code={SKU}` | Resolución SKU → `variantId`. Núcleo del mapeo. |
| Listas de precio | `GET /v1/price_lists.json` · `GET /v1/price_lists/{id}/details.json` | Precio vigente por variante. |
| Stock | `GET /v1/stocks.json?code={SKU}&officeid={id}` | Lectura de `quantityAvailable` por sucursal. |
| Recepción de stock | `POST /v1/stocks/receptions.json` | Sólo si se decide devolver stock a Bsale (no en el alcance inicial). |
| Consumo de stock | `POST /v1/stocks/consumptions.json` | Sólo ajustes manuales. Fuera del alcance inicial. |
| Clientes | `GET /v1/clients.json?code={DNI\|RUC}` | Buscar cliente existente antes de crear. Evita duplicados. |
| Clientes | `POST /v1/clients.json` | Crear cliente. `code` = DNI o RUC. |
| Tipos de documento | `GET /v1/document_types.json` | Descubrir los IDs reales de Boleta y Factura de **esta** cuenta. |
| Impuestos | `GET /v1/taxes.json` | Descubrir el `taxId` del IGV de esta cuenta. |
| Documentos | `POST /v1/documents.json` | **Emisión de boleta / factura electrónica.** |
| Documentos | `GET /v1/documents/{id}.json` | Consultar estado de declaración a SUNAT. |
| Documentos | `GET /v1/documents.json?referencenumber={n}` | Verificación anti-duplicado adicional. |

#### Campos clave del `POST /v1/documents.json`

Confirmados en la documentación oficial:

```jsonc
{
  "documentTypeId": 0,          // ID real de Boleta o Factura en ESTA cuenta (se descubre, no se asume)
  "officeId": 0,                // sucursal emisora
  "priceListId": 0,             // opcional; si se omite usa la de la sucursal
  "emissionDate": 1755302400,   // Unix, sólo fecha (sin zona horaria)
  "expirationDate": 1755302400,
  "declare": 1,                 // 1 = declarar a SUNAT
  "salesId": "shopify-order-1058",  // ⭐ CLAVE ANTI-DUPLICADO (ver §8)
  "client": {
    "code": "20123456789",      // RUC (factura) o DNI (boleta)
    "company": "Razón Social SAC",
    "firstName": "Rolando",
    "lastName": "Pérez",
    "activity": "Giro",
    "address": "Av. Ejemplo 123",
    "city": "Lima",
    "district": "Miraflores",
    "municipality": "Miraflores",
    "email": "cliente@correo.com"
  },
  "sendEmail": 1,               // Bsale envía el comprobante al correo del cliente
  "details": [
    {
      "variantId": 0,           // o "code": "<SKU>" como alternativa oficial
      "netUnitValue": 84.75,    // valor unitario SIN impuestos
      "quantity": 1,
      "taxId": "[1]",           // ⚠️ string con array dentro. Si se omite, sale EXENTO.
      "discount": 0,            // porcentaje, no monto
      "comment": "Nombre del producto"
    }
  ],
  "payments": [
    { "paymentTypeId": 0, "amount": 100.00, "recordDate": 1755302400 }
  ],
  "references": [
    { "number": "1058", "referenceDate": 1755302400, "reason": "Pedido Shopify #1058", "code": 801 }
  ]
}
```

**Tres detalles que rompen la integración si se ignoran:**

1. `taxId` es un **string** que contiene un array (`"[1]"`), no un array JSON.
   Si no se envía, el documento sale exento y queda mal declarado ante SUNAT.
2. `discount` es un **porcentaje**, no un monto. Shopify entrega descuentos en
   monto → hay que convertirlos (ver §8, riesgo de redondeo).
3. `netUnitValue` es el valor **neto** (sin IGV). Shopify entrega precios con o
   sin impuesto según configuración de la tienda → hay que normalizar.

#### Obtención del PDF del comprobante

La respuesta del `POST /v1/documents.json` y el `GET /v1/documents/{id}.json`
incluyen estos campos oficiales:

| Campo | Contenido |
|---|---|
| `urlPdf` | URL del PDF con todas sus copias |
| `urlPdfOriginal` | URL del PDF sólo del original |
| `urlPublicView` | Vista pública HTML |
| `urlXml` | Respaldo XML del documento electrónico |
| `token` | Token único del documento |
| `serialNumber` | Serie y número, ej. `B001-1234` |
| `informed` | Estado SUNAT: `0` correcto, `1` enviado, `2` rechazado |
| `responseMsg` | Mensaje de respuesta de SUNAT |

> **No existe un endpoint dedicado tipo `/documents/{id}/pdf`.** El mecanismo
> oficial es el campo `urlPdf` que Bsale devuelve en el propio documento. Esa URL
> es pública (contiene un token no adivinable). Por eso la app **descarga el PDF,
> lo guarda en almacenamiento privado y nunca expone `urlPdf` al cliente final**
> (§7 y §8).

### 4.2 Bsale — Webhooks

Bsale ofrece webhooks para: documentos, productos, variantes, precios, stock,
documentos pagados y notificaciones de tienda en línea. La estructura de la
notificación es:

```json
{ "cpnId": 0, "resource": "/v1/stocks/629.json", "resourceId": 629,
  "topic": "stock", "action": "PUT", "send": 1755302400 }
```

> ⚠️ **Los webhooks de Bsale no se activan solos.** Hay que solicitarlos por
> correo a `ayuda@bsale.app` indicando la URL de destino y el RUC o `cpnId` de la
> empresa. **Esto es un trámite con plazo, no una llamada de API.** Se debe
> iniciar en paralelo a la Fase 1 para que estén listos en la Fase 3.
>
> Mientras no estén activos, la app funciona en **modo polling** con un cron
> conservador (§9).

> ⚠️ La documentación de Bsale **no publica un mecanismo de firma HMAC** para sus
> webhooks. Mitigación adoptada: URL de recepción con un segmento secreto largo
> y aleatorio (`/webhooks/bsale/<32-bytes-aleatorios>`), verificación de que
> `cpnId` coincide con el de la empresa configurada, y **re-lectura obligatoria
> del recurso vía API** antes de actuar. Nunca se confía en el payload del
> webhook como fuente de verdad.

### 4.3 Shopify — Admin GraphQL API `2026-07`

Endpoint: `POST https://{shop}.myshopify.com/admin/api/2026-07/graphql.json`
Cabecera: `X-Shopify-Access-Token: <token>`

| Operación | Uso |
|---|---|
| `query { shop { name myshopifyDomain currencyCode ianaTimezone } }` | **Prueba de conexión.** |
| `query { locations(first:20) { ... } }` | Resolver la ubicación de inventario. |
| `query { productVariants(query:"sku:<SKU>", first:2) { ... } }` | SKU → `variantId` + `inventoryItem.id`. Pedir 2 permite **detectar SKU duplicados**. |
| `mutation productVariantsBulkUpdate` | Actualizar precios de variantes. |
| `mutation inventorySetQuantities` | Fijar stock absoluto (Bsale es la fuente de verdad). |
| `query { orders(...) }` / `query { order(id:) }` | Leer pedidos a facturar. |
| `mutation metafieldsSet` | Guardar en la orden el número de comprobante emitido. |

#### Detalle crítico de `inventorySetQuantities`

Documentación oficial, versión 2026-07:

- `name`: sólo acepta `"available"` u `"on_hand"`.
- `reason`: obligatorio, debe ser uno de los valores permitidos por Shopify.
- `referenceDocumentUri`: opcional pero **muy recomendado**. Formato GID:
  `gid://mundolovepet-bsale/SyncJob/<id>`. Hace que el nombre de la app aparezca
  en el historial de inventario del admin de Shopify → trazabilidad real.
- `compareQuantity`: control de concurrencia optimista. **No se debe desactivar
  con `ignoreCompareQuantity` salvo en la carga inicial.**
- ⚠️ **Desde la versión `2026-04` la clave de idempotencia es obligatoria** y se
  provee mediante la directiva `@idempotent`. La app la genera de forma
  determinista a partir de `(inventoryItemId, locationId, cantidad, ventana)`.

#### Webhooks de Shopify

Temas suscritos: `orders/create`, `orders/paid`, `orders/updated`,
`orders/cancelled`, `refunds/create`.

Verificación obligatoria: HMAC-SHA256 del **cuerpo crudo** (raw body, sin
parsear) con el secreto compartido, comparado contra la cabecera
`X-Shopify-Hmac-Sha256` usando comparación en tiempo constante
(`crypto.timingSafeEqual`).

#### Límites de tasa (rate limits)

- **Shopify GraphQL Admin API**: modelo de *calculated query cost* con algoritmo
  leaky bucket. Cada respuesta incluye `extensions.cost` con `throttleStatus`
  (`currentlyAvailable`, `maximumAvailable`, `restoreRate`). La app lee ese
  bloque en cada respuesta y **se auto-regula con el dato real** en vez de
  asumir una cuota fija, porque el tamaño del bucket depende del plan de la
  tienda. Al recibir `THROTTLED` se aplica backoff exponencial con jitter.
- **Bsale**: la documentación pública **no especifica un límite de tasa**. Se
  adopta una política conservadora propia: máximo 2 peticiones concurrentes,
  reintento con backoff exponencial ante HTTP 429/5xx, y paginación respetando
  el `limit` máximo documentado de **50** ítems por respuesta.

---

## 5. Estructura de base de datos

```prisma
// ─────────── Configuración y credenciales ───────────

model Connection {
  id              String   @id @default(cuid())
  provider        Provider           // SHOPIFY | BSALE
  encryptedToken  Bytes              // AES-256-GCM. Nunca en claro, nunca en logs.
  tokenIv         Bytes
  tokenTag        Bytes
  tokenLast4      String             // últimos 4 caracteres, sólo para mostrar "••••ab12"
  metadata        Json               // shopDomain, officeId, priceListId... nada sensible
  status          ConnStatus @default(UNKNOWN)
  lastCheckedAt   DateTime?
  lastError       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([provider])
}

// ─────────── Catálogo y mapeo por SKU ───────────

model ProductMap {
  id                 String   @id @default(cuid())
  sku                String   @unique      // ⭐ Bsale SKU == Shopify SKU
  bsaleVariantId     Int?
  bsaleProductId     Int?
  shopifyVariantGid  String?
  shopifyProductGid  String?
  shopifyInventoryItemGid String?
  name               String?
  brand              String?
  category           String?
  bsalePrice         Decimal? @db.Decimal(12,4)
  shopifyPrice       Decimal? @db.Decimal(12,4)
  bsaleStock         Int?
  shopifyStock       Int?
  status             MapStatus @default(PENDING)  // SYNCED|PENDING|ERROR|MISSING_SKU|DUPLICATE_SKU|INACTIVE
  lastError          String?
  lastSyncedAt       DateTime?
  updatedAt          DateTime @updatedAt

  @@index([status])
  @@index([bsaleVariantId])
  @@index([shopifyVariantGid])
}

// ─────────── Clientes ───────────

model CustomerMap {
  id              String   @id @default(cuid())
  docType         DocIdType          // DNI | RUC | NONE
  docNumber       String?            // normalizado, sin guiones ni espacios
  email           String?
  bsaleClientId   Int?
  shopifyCustomerGid String?
  createdAt       DateTime @default(now())

  @@unique([docType, docNumber])
  @@index([email])
}

// ─────────── Pedidos y documentos: el corazón anti-duplicados ───────────

model OrderSync {
  id                 String   @id @default(cuid())
  shopifyOrderId     BigInt   @unique   // ⭐ garantía a nivel de BD: 1 pedido = 1 registro
  shopifyOrderName   String              // "#1058"
  shopifyOrderGid    String
  idempotencyKey     String   @unique   // "shopify-order-<id>" → se envía como salesId a Bsale
  customerMapId      String?
  documentKind       DocumentKind?       // BOLETA | FACTURA
  totalAmount        Decimal  @db.Decimal(12,2)
  currency           String
  status             SyncStatus @default(PENDING) // PENDING|PROCESSING|SYNCED|ERROR|NEEDS_ATTENTION|CANCELLED
  attempts           Int      @default(0)
  lastError          String?
  lastErrorCode      String?
  payload            Json                // snapshot del pedido tal como llegó
  processedAt        DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  document           BsaleDocument?

  @@index([status])
  @@index([createdAt])
}

model BsaleDocument {
  id                 String   @id @default(cuid())
  orderSyncId        String   @unique
  orderSync          OrderSync @relation(fields:[orderSyncId], references:[id])

  bsaleDocumentId    Int      @unique   // ⭐ segunda garantía
  documentTypeId     Int
  kind               DocumentKind
  serialNumber       String              // "B001-00001234"
  number             Int
  emissionDate       DateTime
  totalAmount        Decimal  @db.Decimal(12,2)
  bsaleToken         String              // token del documento en Bsale
  sunatState         Int?                // informed: 0 ok, 1 enviado, 2 rechazado
  sunatMessage       String?
  pdfStorageKey      String?             // ruta interna del PDF, NUNCA una URL pública
  pdfFetchedAt       DateTime?
  createdAt          DateTime @default(now())
}

// ─────────── Trazabilidad ───────────

model SyncLog {
  id          String   @id @default(cuid())
  occurredAt  DateTime @default(now())
  level       LogLevel            // INFO | WARN | ERROR
  system      SystemTag           // SHOPIFY | BSALE | APP
  action      String              // "order.invoice", "stock.push", "price.push"
  sku         String?
  orderRef    String?
  documentRef String?
  result      String              // OK | FAIL | SKIPPED
  message     String
  errorCode   String?
  context     Json?               // ⚠️ pasa por redacción antes de guardarse

  @@index([occurredAt])
  @@index([system, level])
  @@index([sku])
  @@index([orderRef])
}

model SyncRun {
  id          String   @id @default(cuid())
  kind        RunKind             // PRODUCTS | PRICES | STOCK | ORDERS | RETRY
  trigger     RunTrigger          // MANUAL | SCHEDULED | WEBHOOK
  status      RunStatus           // RUNNING | DONE | FAILED
  total       Int      @default(0)
  processed   Int      @default(0)
  succeeded   Int      @default(0)
  failed      Int      @default(0)
  startedAt   DateTime @default(now())
  finishedAt  DateTime?
  summary     Json?
}

model WebhookEvent {
  id          String   @id @default(cuid())
  source      SystemTag
  externalId  String              // X-Shopify-Webhook-Id, o hash del payload en Bsale
  topic       String
  receivedAt  DateTime @default(now())
  processedAt DateTime?
  payload     Json

  @@unique([source, externalId])  // ⭐ deduplicación de webhooks reenviados
}

model AdminUser {
  id           String @id @default(cuid())
  email        String @unique
  passwordHash String            // argon2id
  role         Role   @default(ADMIN)
  lastLoginAt  DateTime?
  createdAt    DateTime @default(now())
}
```

**Los tres candados anti-duplicado están en el esquema, no sólo en el código:**
`OrderSync.shopifyOrderId @unique`, `OrderSync.idempotencyKey @unique`,
`BsaleDocument.bsaleDocumentId @unique`. Aunque dos workers procesaran el mismo
pedido a la vez, PostgreSQL rechaza el segundo.

---

## 6. Flujo completo Shopify → Bsale

```
┌─ Cliente paga en Shopify
│
├─ Shopify emite webhook orders/paid → POST /webhooks/shopify/orders-paid
│
├─ [1] Verificar HMAC-SHA256 sobre el raw body ─── falla ──▶ 401, se descarta
│
├─ [2] ¿Existe WebhookEvent con este X-Shopify-Webhook-Id?
│       sí ──▶ 200 OK y salir (reenvío duplicado de Shopify)
│
├─ [3] Guardar WebhookEvent + crear OrderSync (PENDING)
│       Si shopifyOrderId ya existe ──▶ no se crea nada. 200 OK.
│
├─ [4] Responder 200 a Shopify en < 5 s ⚠️ y encolar el trabajo
│       (Shopify reintenta si tarda demasiado → causaría duplicados)
│
└─▶ Worker BullMQ, job "invoice-order", idempotente
    │
    ├─ [5] Releer el pedido completo desde Shopify (GraphQL). El payload del
    │      webhook no es fuente de verdad.
    │
    ├─ [6] ¿Ya existe BsaleDocument para este OrderSync? ──▶ salir. Nunca refacturar.
    │
    ├─ [7] Determinar tipo de documento (función pura, 100 % testeada):
    │        RUC 11 dígitos válido + razón social ──▶ FACTURA
    │        DNI 8 dígitos válido                 ──▶ BOLETA
    │        sin identificación                   ──▶ BOLETA a consumidor final
    │        RUC presente pero inválido           ──▶ NEEDS_ATTENTION (no se emite nada)
    │
    ├─ [8] Resolver cliente en Bsale:
    │        GET /v1/clients.json?code=<doc>  ──▶ existe: usar clientId
    │                                          ──▶ no existe: POST /v1/clients.json
    │
    ├─ [9] Resolver cada línea: SKU → variantId (ProductMap, o consulta a Bsale)
    │        SKU inexistente en Bsale ──▶ NEEDS_ATTENTION, no se emite el documento
    │
    ├─ [10] Construir el detalle:
    │        netUnitValue sin IGV · taxId "[<id IGV>]" · discount como PORCENTAJE
    │        + línea de envío si el pedido tiene costo de despacho
    │        Validación: Σ líneas + envío − descuentos ≈ total Shopify (±0.02)
    │        Si no cuadra ──▶ NEEDS_ATTENTION. Nunca se emite un documento descuadrado.
    │
    ├─ [11] POST /v1/documents.json con:
    │          salesId = "shopify-order-<id>"   ⭐ Bsale devuelve el documento ya
    │                                              existente en vez de crear otro
    │          references = [{ number, reason: "Pedido Shopify #1058", code: 801 }]
    │          declare = 1
    │
    ├─ [12] Persistir BsaleDocument en la MISMA transacción que marca
    │        OrderSync = SYNCED. Todo o nada.
    │
    ├─ [13] Descargar el PDF desde urlPdf → almacenamiento privado.
    │        Guardar sólo pdfStorageKey. La URL de Bsale no se expone jamás.
    │
    ├─ [14] metafieldsSet en la orden de Shopify:
    │        namespace "bsale" · keys: document_type, serial_number, document_id
    │
    └─ [15] SyncLog: "🟢 Boleta B001-00001234 creada para pedido #1058"
```

### Manejo de fallos en el paso [11]

Este es el punto más delicado de toda la integración: **si Bsale responde con
timeout, no sabemos si el documento se creó o no.**

Protocolo adoptado:

1. **Nunca reintentar a ciegas.** El job pasa a estado `NEEDS_ATTENTION`.
2. **Reconciliar antes de reintentar:** consultar
   `GET /v1/documents.json?referencenumber=<n° de pedido>` y verificar si el
   documento ya existe.
3. `salesId` actúa como red de seguridad: la documentación de Bsale indica que
   si ya existe un documento con ese identificador, la API **devuelve el
   documento previo en lugar de generar uno nuevo**.
4. Sólo tras confirmar que no existe, se permite el reintento (manual o
   automático con backoff).

---

## 7. Flujo Bsale → Shopify

```
┌─ Cambia stock o precio en Bsale
│
├─ Vía A · webhook (una vez activado por ayuda@bsale.app)
│    POST /webhooks/bsale/<segmento-secreto>
│    → validar cpnId · deduplicar · encolar
│
└─ Vía B · polling (fallback mientras el webhook no esté activo)
     cron cada 10 min · paginación limit=50
     │
     └─▶ Worker "sync-stock" / "sync-prices"
         │
         ├─ [1] Releer el recurso real desde Bsale
         │        GET /v1/stocks.json?code=<SKU>&officeid=<id>
         │
         ├─ [2] Resolver SKU → Shopify variant + inventoryItem
         │        productVariants(query:"sku:<SKU>", first:2)
         │        0 resultados ──▶ MISSING_SKU
         │        2 resultados ──▶ DUPLICATE_SKU · se BLOQUEA la escritura
         │
         ├─ [3] Normalizar cantidad:
         │        cantidad = max(0, floor(quantityAvailable))
         │        Bsale devuelve Float; Shopify exige entero. Nunca negativo.
         │
         ├─ [4] ¿Cambió respecto a ProductMap? no ──▶ SKIPPED (evita escrituras inútiles)
         │
         ├─ [5] inventorySetQuantities
         │        name: "available" · reason: <valor permitido>
         │        compareQuantity: valor leído  ⚠️ control de concurrencia
         │        referenceDocumentUri: gid://mundolovepet-bsale/SyncJob/<runId>
         │        @idempotent con clave determinista  (obligatorio desde 2026-04)
         │
         ├─ [6] Precios: productVariantsBulkUpdate
         │        Registrar SIEMPRE precio anterior y nuevo en SyncLog antes de escribir
         │
         └─ [7] Actualizar ProductMap + SyncLog
```

**Bsale es la única fuente de verdad de inventario y precio.** La app nunca
escribe stock ni precios desde Shopify hacia Bsale. Esta unidireccionalidad
elimina de raíz los bucles de sincronización.

---

## 8. Riesgos y limitaciones

### 8.1 Riesgos altos

| # | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R1 | **Doble facturación** de un pedido | Problema tributario real ante SUNAT | 4 capas: `@unique` en BD · `salesId` en Bsale · dedupe de webhooks · reconciliación previa al reintento |
| R2 | **Timeout de Bsale** sin saber si emitió | Documento fantasma o duplicado | Prohibido el reintento ciego → `NEEDS_ATTENTION` + reconciliación por `referencenumber` |
| R3 | **SKU duplicados en Shopify** | Stock escrito en el producto equivocado | Se consulta `first: 2`; con 2 resultados se bloquea la escritura y se marca `DUPLICATE_SKU` |
| R4 | **Descuento monto → porcentaje** | Total del comprobante ≠ total cobrado | Validación aritmética obligatoria antes de emitir (tolerancia ±0.02); si no cuadra, no se emite |
| R5 | **`taxId` omitido** | Documento emitido como exento → mal declarado | El constructor de detalles **exige** `taxId`; test unitario que falla si falta |
| R6 | **RUC/DNI inválido** | Rechazo de SUNAT | Validación de formato y dígito verificador **antes** de llamar a Bsale |

### 8.2 Limitaciones conocidas

- **Webhooks de Bsale = trámite manual.** Requieren solicitud por correo a
  `ayuda@bsale.app`. Hasta que se activen, la sincronización Bsale → Shopify
  funciona por polling, con la latencia que eso implica (~10 min).
- **Webhooks de Bsale sin firma HMAC documentada.** Mitigado con URL secreta +
  validación de `cpnId` + re-lectura vía API. No es equivalente a una firma
  criptográfica; se documenta como limitación aceptada.
- **Paginación de Bsale limitada a 50 ítems.** Un catálogo de 5 000 SKU son 100
  peticiones por pasada completa. Por eso la sincronización completa es un job
  de fondo, nunca una acción síncrona del panel.
- **Bsale no publica sus límites de tasa.** Se adopta una política conservadora
  propia; puede requerir ajuste tras observar el comportamiento real.
- **`read_orders` en Custom App = últimos 60 días.** Suficiente para operar; el
  histórico anterior requeriría solicitar `read_all_orders` a Shopify.
- **Multi-almacén.** La app soporta **una** sucursal Bsale ↔ **una** location de
  Shopify en la primera versión. El esquema admite crecer, pero mapeo N:N no
  está en el alcance inicial.
- **Bsale devuelve stock como Float** (ej. `60.36`) y Shopify exige entero.
  Se trunca hacia abajo. Para productos vendidos por peso esto pierde precisión;
  se documenta como comportamiento esperado.
- **Notas de crédito / devoluciones no están en el alcance inicial.** Existe el
  endpoint `/returns` en Bsale, pero se abordará como fase posterior una vez
  estable la emisión.

### 8.3 Verificaciones pendientes de confirmar con datos reales

Estos valores **no se pueden asumir** — se descubren llamando a la API de la
cuenta real en la Fase 1:

- ID real de "Boleta Electrónica" y "Factura Electrónica" → `GET /v1/document_types.json`
- ID real del IGV → `GET /v1/taxes.json`
- ID de la sucursal y de la lista de precios → `GET /v1/offices.json`, `GET /v1/price_lists.json`
- Valores permitidos de `reason` en `inventorySetQuantities` para esta tienda
- Si el plan Bsale contratado tiene habilitada la emisión electrónica vía API

---

## 9. Plan de implementación por fases

| Fase | Entregable | Criterio de aceptación | Estimación |
|---|---|---|---|
| **1** | Conexión Bsale + Shopify | ✅ Ambos "Probar conexión" en verde con credenciales reales. Tokens cifrados en BD. Tests en verde. | 2–3 días |
| **2** | Lectura desde Bsale | Catálogo completo (SKU, precio, stock) listado en el panel con paginación real. Detección de SKU faltantes/duplicados. | 3–4 días |
| **3** | Precios y stock → Shopify | Cambio de precio o stock en Bsale se refleja en Shopify. Historial con valor anterior y nuevo. | 4–5 días |
| **4** | Recepción de pedidos | Webhooks Shopify verificados por HMAC. Pedidos en el panel en estado `PENDING`. Sin emitir nada aún. | 3 días |
| **5** | Clientes en Bsale | Cliente creado o reutilizado por DNI/RUC. Cero duplicados en pruebas. | 2–3 días |
| **6** | Boletas y facturas | Emisión real en **sandbox**. Serie y número correctos. Doble envío no genera segundo documento. | 5–6 días |
| **7** | Comprobantes PDF | PDF descargado, almacenado en privado y servido sólo a su dueño o a un admin. | 2–3 días |
| **8** | Dashboard y logs | Todas las pantallas de §11–15 operativas. Sincronización manual con barra de progreso. | 4–5 días |
| **9** | Pruebas completas | Cobertura ≥ 80 % en `domain/`. Pruebas de carga, de fallo y de duplicados. | 3–4 días |
| **10** | Producción | Despliegue, backups, monitoreo, alertas. Primera semana con supervisión manual de cada documento. | 2–3 días |

**Regla operativa:** al terminar cada fase se entregan pruebas automáticas
verdes y un resumen de qué funciona y qué no, y no se avanza hasta que lo
verifiques.

Adicionalmente, **hoy mismo** conviene enviar el correo a `ayuda@bsale.app`
solicitando la activación de webhooks (topics: documento, stock, producto,
variante, precio) indicando el RUC de Mundo Love Pet y la URL
`https://<tu-dominio>/webhooks/bsale/<segmento-secreto>`. El trámite tarda, y
tenerlo listo para la Fase 3 evita quedarse esperando.

---

## Fuentes

- [Bsale — Primeros pasos](https://docs.bsale.dev/get-started)
- [Bsale Perú — Introducción](https://docs.bsale.dev/PE/first-steps)
- [Bsale Perú — Clientes](https://docs.bsale.dev/PE/clientes)
- [Bsale Perú — Webhooks](https://docs.bsale.dev/PE/webhooks)
- [Bsale — Documentos (estructura y POST)](https://apiperu.bsalelab.com/lista-de-endpoints/documentos)
- [Bsale — Stocks](https://apiperu.bsalelab.com/lista-de-endpoints/productos-y-servicios/stocks)
- [Shopify — InventorySetQuantitiesInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventorySetQuantitiesInput)
- [Shopify — inventorySetQuantities](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities)
- [Shopify — Versionado de API](https://shopify.dev/docs/api/usage/versioning)
