# Mundo Love Pet — Shopify × Bsale

Integración entre la tienda Shopify de Mundo Love Pet y Bsale Perú.

📄 **Lee primero [`ARQUITECTURA.md`](./ARQUITECTURA.md)** — arquitectura, endpoints
oficiales, esquema de base de datos, flujos completos, riesgos y plan por fases.

🚀 **¿Vas a desplegar en Render?** → [`DESPLIEGUE-RENDER.md`](./DESPLIEGUE-RENDER.md)
(blueprint listo, costos reales y las tres cosas que cambian respecto al VPS).

---

## Estado actual: FASE 1 — Conexión ✅

| Entregable | Estado |
|---|---|
| Cliente de la API Bsale v1 (auth por header `access_token`) | ✅ |
| Cliente de la Admin GraphQL API de Shopify `2026-07` | ✅ |
| Cifrado de credenciales en reposo (AES-256-GCM) | ✅ |
| Enmascarado y redacción de secretos en logs y respuestas | ✅ |
| Endpoints de prueba de conexión | ✅ |
| Descubrimiento de la configuración real de Bsale | ✅ |
| Panel web con estado de conexiones | ✅ |
| Esquema completo de base de datos (Prisma) | ✅ |
| Docker Compose + Caddy con HTTPS | ✅ |
| Token de Shopify por client credentials, con renovación automática | ✅ |
| **108 pruebas automáticas, typecheck limpio** | ✅ |

**Lo que esta fase NO hace todavía**, a propósito: no escribe precios ni stock en
Shopify, no crea clientes, no emite boletas ni facturas, y no registra webhooks.
Eso llega en las fases 2 a 7, y sólo después de que confirmes que la conexión
funciona con tus credenciales reales.

---

## Puesta en marcha

### 1. Crear la app de Shopify y obtener sus credenciales

> ⚠️ **Esto cambió el 1 de enero de 2026.** Shopify ya no permite crear apps
> personalizadas desde el admin de la tienda (*Configuración → Apps y canales de
> venta → Desarrollar apps*). Eran las que entregaban un token estático
> `shpat_…` que se copiaba y pegaba. Las apps creadas antes de esa fecha siguen
> funcionando, pero **no se pueden crear nuevas**.
>
> Si sigues una guía que te dice que copies un token del admin, está desfasada.

Las apps nuevas se crean en el **Dev Dashboard** y no dan ningún token que
copiar: dan un **Client ID** y un **Client Secret**, y la app pide el token ella
misma cada ~24 horas. Eso lo hace `src/integrations/shopify/token.ts`; tú solo
necesitas las dos credenciales.

1. Entra a <https://dev.shopify.com/dashboard> → **Create app** → nombre: `Bsale Sync`
2. **Configuration** → marca exactamente estos ámbitos de Admin API:
   `read_products`, `write_products`, `read_inventory`, `write_inventory`,
   `read_orders`, `read_customers`, `read_locations`
3. **Instala la app en tu tienda** desde el enlace que te da el dashboard
4. **Settings → Credentials** → copia el **Client ID** y el **Client Secret**

El Client ID no es secreto y puede ir a la vista. El **Client Secret sí**:
trátalo como una contraseña. La app lo guarda cifrado con AES-256-GCM y nunca lo
devuelve por la API del panel.

> El flujo de client credentials sólo funciona con apps de tu propia
> organización instaladas en tiendas que tú posees. Es exactamente este caso.

### 2. Obtener el token de Bsale

- **Para pruebas** (recomendado empezar aquí): crea una cuenta sandbox gratuita
  en <https://account.bsale.dev/users/create>.
- **Para producción**: en tu cuenta Bsale Perú. Crea un **usuario dedicado**
  llamado por ejemplo "Integración Shopify" en vez de usar tu token personal —
  así los documentos quedan atribuidos a ese usuario y puedes revocarlo sin
  afectar a nadie más.

### 3. Configurar el entorno

```bash
cp .env.example .env
npm run keygen          # genera ENCRYPTION_KEY → cópiala al .env
```

Completa en `.env`: `ENCRYPTION_KEY`, `SESSION_SECRET`, `SHOPIFY_SHOP_DOMAIN`,
`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `BSALE_ACCESS_TOKEN`.

Los IDs de Bsale (`BSALE_OFFICE_ID`, `BSALE_DOCTYPE_BOLETA_ID`, etc.) se dejan
vacíos: los descubre la propia app en el paso 5.

> 🔑 Si pierdes `ENCRYPTION_KEY`, los tokens guardados quedan irrecuperables.
> Guárdala fuera del servidor.

### 4. Levantar

**Desarrollo local:**

```bash
npm install
npm run prisma:generate
npm run dev
# → http://localhost:3000
```

Si PostgreSQL no está disponible, la app arranca igual usando un almacén en
memoria y lo avisa en el log. Sirve para probar la conexión, pero los tokens no
persisten al reiniciar.

**Producción (VPS con Docker):**

```bash
# Edita el dominio en el Caddyfile primero
docker compose up -d --build
docker compose logs -f app
```

### 5. Verificar y descubrir la configuración

En el panel:

1. **Probar ambas conexiones** → las dos tarjetas deben quedar en 🟢 *Conectado*.
2. **Descubrir configuración de Bsale** → devuelve los IDs reales de tu cuenta:
   sucursales, tipos de documento, impuestos y listas de precio.
3. Copia esos IDs a tu `.env` **después de confirmarlos visualmente**.

> ⚠️ El paso 3 importa más de lo que parece. Los IDs de "Boleta Electrónica" y
> "Factura Electrónica" **varían entre cuentas de Bsale**. Codificarlos a mano o
> aceptar la sugerencia sin mirar es la forma más rápida de emitir el tipo de
> comprobante equivocado ante SUNAT. La app te sugiere candidatos, pero la
> confirmación es tuya.

---

## Comprobar que todo está bien

```bash
npm run typecheck   # sin errores
npm test            # 108 pruebas
```

Cobertura de las pruebas:

| Archivo | Qué verifica |
|---|---|
| `crypto.test.ts` | El texto plano nunca queda en el ciphertext · GCM detecta manipulación · los errores no filtran la clave |
| `mask.test.ts` | Redacción de claves sensibles anidadas · `maskToken` nunca devuelve el token completo |
| `bsale.client.test.ts` | Header `access_token` correcto · token nunca en la URL · 401 no reintentable, 429/5xx sí · límite de paginación 50 |
| `shopify.client.test.ts` | Endpoint GraphQL con versión `2026-07` · errores de GraphQL con HTTP 200 detectados · `THROTTLED` reintentable · lectura del bucket de coste |
| `shopify.token.test.ts` | El secreto viaja en el cuerpo y nunca en la URL · el token se cachea · se renueva **antes** de caducar · N llamadas simultáneas provocan una sola renovación · ni el secreto ni el client_id aparecen en los mensajes de error |
| `connection.service.test.ts` | Los tokens se guardan cifrados · las vistas del panel nunca contienen tokens · el descubrimiento prefiere el tipo **electrónico** y descarta notas de venta |
| `env.test.ts` | La app no arranca con configuración inválida · política de reintentos correcta |

Comprobación manual rápida:

```bash
curl localhost:3000/api/health
curl localhost:3000/api/connections          # nunca devuelve tokens
curl -X POST localhost:3000/api/connections/test-all
curl localhost:3000/api/connections/bsale/discover
```

---

## Endpoints de la Fase 1

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Estado del servicio |
| `GET` | `/api/connections` | Estado de ambas conexiones (sin tokens) |
| `POST` | `/api/connections/bsale/test` | Prueba Bsale vía `GET /v1/offices.json` |
| `POST` | `/api/connections/shopify/test` | Prueba Shopify vía `query { shop { … } }` |
| `POST` | `/api/connections/test-all` | Prueba ambas en paralelo |
| `GET` | `/api/connections/bsale/discover` | IDs reales de sucursales, tipos de documento, impuestos y listas de precio |

Los endpoints de prueba están limitados a 10 peticiones por minuto para no
quemar la cuota de las APIs externas desde el panel.

---

## Estructura

```
├── ARQUITECTURA.md          ← documento principal: léelo primero
├── prisma/schema.prisma     ← esquema completo (fases 1-10)
├── public/index.html        ← panel
├── src/
│   ├── config/env.ts        ← validación con zod; falla al arrancar si algo falta
│   ├── lib/
│   │   ├── crypto.ts        ← AES-256-GCM
│   │   ├── mask.ts          ← único lugar que decide qué parte de un secreto es visible
│   │   ├── errors.ts        ← IntegrationError con la distinción retryable / no retryable
│   │   └── logger.ts        ← pino con redacción
│   ├── integrations/
│   │   ├── bsale/client.ts
│   │   └── shopify/client.ts
│   ├── db/                  ← ConnectionStore (interfaz) + Prisma + memoria
│   ├── services/            ← ConnectionService
│   ├── routes/              ← API del panel
│   └── server.ts
├── tests/                   ← 108 pruebas
├── docker-compose.yml · Dockerfile · Caddyfile
```

> Nota: la carpeta viene con `node_modules/` ya instalado, así puedes ejecutar
> `npm test` de inmediato. Bórrala antes de subir el proyecto a git — ya está
> en el `.gitignore`.

---

## Trámite a iniciar en paralelo

Los **webhooks de Bsale no se activan por API**: hay que solicitarlos por correo.
Conviene enviarlo ahora para que estén listos cuando lleguemos a la Fase 3.

**Para:** `ayuda@bsale.app`
**Asunto:** Solicitud de activación de webhooks — RUC \<tu RUC\>

> Buenos días,
>
> Solicito la activación de webhooks para nuestra empresa (RUC \<tu RUC\>,
> Mundo Love Pet), con destino a la siguiente URL sobre SSL:
>
> `https://sync.mundolovepet.pe/webhooks/bsale/<segmento-secreto>`
>
> Topics requeridos: **documento, stock, producto, variante, precio**
> (acciones POST y PUT).
>
> Quedo atento. Gracias.

Genera el segmento secreto con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Seguridad — qué está implementado en esta fase

- Credenciales cifradas con AES-256-GCM. El texto plano nunca toca la base de datos.
- Sólo los últimos 4 caracteres de cada token salen del backend.
- Doble capa de redacción: en pino y en los mensajes de error, con detección de
  tokens de Shopify por patrón.
- Los mensajes de error de las APIs pasan por `scrubMessage` antes de guardarse
  o mostrarse, por si el proveedor devuelve el token dentro del texto.
- Cabeceras de seguridad vía helmet + CSP restrictiva.
- Rate limiting en los endpoints que salen a APIs externas.
- El contenedor no corre como root. PostgreSQL y Redis no publican puertos.
- Principio de privilegio mínimo en los scopes de Shopify.

Pendiente para fases posteriores: autenticación del panel (argon2id + sesión),
verificación HMAC de webhooks de Shopify, y control de acceso a los PDFs.

---

## Siguiente paso

Cuando ambas conexiones estén en 🟢 con tus credenciales reales y me pases el
resultado de **Descubrir configuración de Bsale**, arrancamos la **Fase 2**:
leer productos, SKU, precios y stock desde Bsale.
