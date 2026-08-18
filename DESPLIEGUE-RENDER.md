# Despliegue en Render

Alternativa a la sección §2.1 de [`ARQUITECTURA.md`](./ARQUITECTURA.md) (VPS + Docker).

**Respuesta corta: sí, funciona bien en Render.** Pero hay tres cosas que cambian
respecto al diseño original, y una de ellas es un cambio real de arquitectura,
no un detalle de configuración.

---

## 1. Qué cambia respecto al VPS

| Componente | VPS + Docker | Render |
|---|---|---|
| HTTPS / certificados | Caddy + Let's Encrypt | Automático. **Se elimina el `Caddyfile`.** |
| Orquestación | `docker-compose.yml` | [`render.yaml`](./render.yaml) (blueprint) |
| PostgreSQL | Contenedor propio | Render Postgres gestionado, con backups y PITR |
| Redis | Contenedor propio | Render Key Value (Valkey 8, compatible con Redis) |
| Worker de colas | Proceso en el mismo host | Servicio `worker` independiente |
| Cron de polling | `cron` del sistema | Servicio `cron` de Render |
| **PDFs de comprobantes** | Volumen Docker compartido | **⚠️ No sirve un disco. Ver §4.** |
| Administración de servidor | Tuya (parches, backups, monitoreo) | De Render |

El blueprint ya está listo en [`render.yaml`](./render.yaml).

---

## 2. El plan Free NO sirve para esto

Es tentador, y es la trampa más común. Cuatro razones, todas de la documentación
oficial de Render:

1. **Los servicios web Free se apagan tras 15 minutos sin tráfico** y tardan
   **cerca de un minuto en despertar.** Shopify espera una respuesta rápida a
   sus webhooks; si tarda, reintenta. Un pedido pagado a las 3 de la madrugada
   caería justo en ese hueco. Este punto solo ya descarta el plan Free.
2. **Postgres Free expira a los 30 días** y no admite backups de ningún tipo.
   Tu tabla de relación pedido ↔ comprobante viviría con fecha de caducidad.
3. **Key Value Free es sólo en memoria**, sin persistencia. Un reinicio de
   Render borra la cola: pedidos pagados que nunca se facturan, sin rastro.
4. El sistema de archivos es efímero en todos los planes, y los servicios Free
   ni siquiera admiten disco persistente.

**Para producción, el mínimo real es todo en `starter`/`basic`.**

---

## 3. Costo mensual estimado

Con workspace **Hobby** ($0/mes, permite hasta 25 servicios y ya incluye PITR de
3 días y soporte por chat):

| Servicio | Instancia | Costo |
|---|---|---|
| Web (`mlp-sync`) | Starter · 512 MB · 0.5 CPU | $7 |
| Worker (`mlp-worker`) | Starter | $7 |
| Postgres (`mlp-db`) | Basic-256mb | $6 |
| Key Value (`mlp-queue`) | Starter · 256 MB | $10 |
| Cron (`mlp-poll-bsale`) | Starter · ~1 min/día de ejecución | < $1 |
| **Total** | | **≈ $31/mes** |

Ancho de banda: 5 GB/mes incluidos en Hobby, de sobra para esta carga.

### Cómo empezar más barato

Durante las **Fases 1 y 2 no hay colas ni polling todavía.** Comenta los
servicios `mlp-worker` y `mlp-poll-bsale` en `render.yaml` y arranca sólo con
web + Postgres + Key Value: **≈ $23/mes**. Los activas en la Fase 3.

> Comparado con un VPS (~$12-25/mes con todo incluido), Render sale algo más
> caro. Lo que compras con la diferencia es no administrar servidor, TLS,
> backups ni actualizaciones de seguridad. Para una tienda que factura
> electrónicamente, esa tranquilidad suele valer los $10 de diferencia.

---

## 4. ⚠️ Los PDFs: el cambio de arquitectura real

El diseño original guardaba los comprobantes en un volumen Docker compartido
entre el worker (que descarga el PDF) y el servicio web (que lo sirve al
cliente). **Eso no se traduce a Render**, y no por una limitación menor:

Según la documentación de discos persistentes de Render:

- **Un disco es accesible por un único servicio.** El worker no podría leer el
  disco del web service, ni al revés. El flujo "worker descarga → web sirve" se
  rompe de raíz.
- **Adjuntar un disco desactiva los despliegues sin caída.** Render apaga la
  instancia vieja antes de levantar la nueva. Durante esos segundos, un webhook
  de Shopify se pierde.
- **Un servicio con disco no puede escalar** más allá de una instancia.

**Solución: almacenamiento de objetos S3-compatible.**

| Opción | Por qué |
|---|---|
| **Cloudflare R2** (recomendado) | Sin cargos de egreso. 10 GB gratis al mes. |
| Backblaze B2 | Muy barato, ~$6/TB al mes. |
| AWS S3 | Estándar, pero cobra egreso. |

Un comprobante PDF pesa unos 50-100 KB. Con 500 pedidos al mes son ~50 MB
mensuales: **cabe holgadamente en la capa gratuita de R2 durante años.**

El acceso se mantiene protegido igual que en el diseño original: el bucket es
**privado**, y el backend genera una **URL firmada con expiración corta** (5-10
minutos) sólo después de verificar que quien pide el PDF es el dueño del pedido
o un administrador. La URL de Bsale nunca se expone.

Las variables `S3_*` ya están declaradas en `render.yaml`. Se implementan en la
**Fase 7**; hasta entonces no hacen falta.

---

## 5. Pasos de despliegue

### 5.1 Subir el proyecto a GitHub

```bash
cd mundolovepet-shopify-bsale
rm -rf node_modules            # ya está en .gitignore
git init && git add . && git commit -m "Fase 1: conexión Shopify × Bsale"
git remote add origin git@github.com:<tu-usuario>/mundolovepet-shopify-bsale.git
git push -u origin main
```

> Verifica que `.env` **no** esté en el commit. El `.gitignore` ya lo excluye,
> pero revisa `git status` antes de subir.

### 5.2 Crear el blueprint

1. [Dashboard de Render](https://dashboard.render.com) → **New** → **Blueprint**
2. Selecciona el repositorio. Render detecta `render.yaml`.
3. Render te pedirá los valores marcados con `sync: false`:
   - `SHOPIFY_SHOP_DOMAIN` → `mundolovepet.myshopify.com`
   - `SHOPIFY_ADMIN_TOKEN` → el `shpat_...` de tu Custom App
   - `BSALE_ACCESS_TOKEN` → tu token de Bsale
   - El resto puedes dejarlos vacíos por ahora
4. **Apply**. El primer despliegue tarda unos minutos.

`ENCRYPTION_KEY` y `SESSION_SECRET` los genera Render automáticamente
(`generateValue: true` produce 256 bits en base64 — justo los 32 bytes que
exige AES-256-GCM). No tienes que crearlos a mano.

### 5.3 Verificar

Abre `https://mlp-sync-XXXX.onrender.com` y pulsa **Probar ambas conexiones**.
Deben quedar las dos en 🟢.

Luego **Descubrir configuración de Bsale** y copia los IDs resultantes a las
variables `BSALE_*` en el dashboard de Render (Environment → Add).

### 5.4 Dominio propio (opcional pero recomendado)

Settings → Custom Domains → `sync.mundolovepet.pe`. Render emite el certificado
solo. El plan Hobby incluye 2 dominios.

Conviene hacerlo **antes** de registrar los webhooks: si más adelante cambias de
`onrender.com` a tu dominio, tendrás que reconfigurar los webhooks en Shopify y
volver a pedirle el cambio a Bsale por correo — y ese trámite tarda.

---

## 6. Detalles a tener presentes en Render

**Región.** Todo está en `virginia` (US East), la más cercana a Perú entre las
opciones de Render (Oregon, Ohio, Virginia, Frankfurt, Singapur). **Los
servicios deben estar en la misma región** para comunicarse por la red privada;
si mezclas regiones, Postgres y Key Value dejan de ser alcanzables por la URL
interna.

**Migraciones.** Se ejecutan en `preDeployCommand`, no dentro del `startCommand`.
Si una migración falla, Render aborta el despliegue y mantiene viva la versión
anterior, en lugar de dejarte un servicio arrancando en bucle.

**Apagado ordenado.** El worker tiene `maxShutdownDelaySeconds: 120`. Es
deliberado: cortar un job a mitad de un `POST /v1/documents.json` es justo el
escenario que deja un documento en estado indeterminado en Bsale.

**Red privada.** Postgres y Key Value tienen `ipAllowList: []` — sólo aceptan
conexiones internas. No están expuestos a internet.

**Logs.** El plan Hobby retiene 7 días. Como nuestro `SyncLog` vive en Postgres,
el historial de sincronizaciones no depende de esa retención.

**Health check.** `/api/health` ya existe y Render lo usa para decidir si un
despliegue quedó sano.

---

## 7. ¿Render o VPS?

| | Render | VPS + Docker |
|---|---|---|
| Costo | ≈ $31/mes | ≈ $12-25/mes |
| Puesta en marcha | Minutos | Unas horas |
| TLS, backups, parches | Incluido | Tuyo |
| Control | Menor | Total |
| PDFs | Requiere R2/S3 | Volumen local |
| Riesgo de olvidar un parche de seguridad | Bajo | Real |

**Mi recomendación para tu caso:** Render. Estás montando una integración
fiscal para una tienda real, y el tiempo que ahorras en administrar servidores
es tiempo que puedes dedicar a validar que los comprobantes salgan correctos.
La diferencia de precio es menor que una hora de tu trabajo al mes.

Si más adelante quieres migrar a un VPS, el `Dockerfile` y el
`docker-compose.yml` siguen en el repositorio y funcionan.

---

## Fuentes

- [Render — Deploy for Free (límites)](https://render.com/docs/free)
- [Render — Persistent Disks](https://render.com/docs/disks)
- [Render — Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Render — Key Value](https://render.com/docs/key-value)
- [Render — Pricing](https://render.com/pricing)
