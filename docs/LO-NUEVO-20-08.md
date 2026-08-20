# Las cuatro mejoras del 20/08/2026

## 1. Informe de SKU duplicados

Botón **«Buscar SKU duplicados»**, en la pestaña *Productos nuevos*.

Agrupa las variantes de Shopify por código —SKU y código de barras— y lista las
repetidas. **No borra nada, y no va a hacerlo:** dos variantes con el mismo
código pueden ser un duplicado que creó la app o dos productos que registraste
así a propósito, y desde aquí no hay forma de distinguirlo con certeza.

Lo que sí hace es ordenar la sospecha. Marca como **probable duplicado** lo que
está en borrador y sin imagen, que es exactamente como crea la app. Así la
decisión es rápida en vez de arqueológica.

## 2. Las emisiones quedan registradas

Cada comprobante emitido se guarda en `OrderSync` y `BsaleDocument`, **en la
misma transacción**. Un pedido marcado como facturado sin su documento sería
peor que no guardar nada: diría estar emitido sin poder demostrarlo.

Consecuencia visible: el panel ya no ofrece el botón «Emitir» en un pedido ya
facturado. En su lugar enseña la serie y el número.

Antes de esto, el único candado contra emitir dos veces era el `salesId` de
Bsale. Sigue estando —y sigue siendo el que de verdad protege—, pero la app ya
no está ciega.

## 3. El comprobante, en el pedido de Shopify

Al emitir se escriben cuatro metafields en el pedido, bajo el espacio `bsale`:

| Clave | Contenido |
|---|---|
| `document_type` | BOLETA o FACTURA |
| `serial_number` | p. ej. `B001-1234` |
| `document_number` | el número |
| `document_id` | el id en Bsale |

Así se ve desde el propio pedido, que es donde lo va a buscar cualquiera que
atienda a un cliente, sin abrir esta app.

### El PDF

Enlace **«Ver PDF»** junto a cada comprobante emitido.

El PDF **no se enlaza directamente a Bsale**. La URL que Bsale devuelve es
pública para quien la tenga: lleva un token en la propia dirección y no pide
nada más. Enlazarla la dejaría en el historial del navegador, en los registros
de cualquier intermediario y en el portapapeles de quien la copie.

La app hace de intermediaria: `/api/comprobantes/:pedido/pdf` lo descarga de
Bsale y lo sirve detrás del mismo candado que el resto del panel. La dirección
de Bsale no sale nunca del servidor.

> Requiere la migración `20260820210000_url_pdf`, que se aplica sola en el
> build.

## 4. Sincronización automática

Cron **`mlp-sync-auto`**, dos veces al día (7:00 y 19:00 hora de Lima).

Lee Bsale, compara con Shopify y aplica las diferencias.

| Qué | Automático |
|---|---|
| Stock | **Sí**, siempre |
| Precios | Sólo con `SYNC_AUTO_PRECIOS=1` |
| Crear productos | **No** |
| Emitir comprobantes | **No** |

El stock es lo que cambia a todas horas y lo que provoca sobreventa si se queda
viejo. Los precios son más delicados: un error en Bsale se propagaría a la
tienda sin que nadie lo mire, así que hay que activarlo a conciencia.

### Por qué un cron y no la cola que planeaba la arquitectura

El plan original era BullMQ con un worker permanente. Para este caso es
desproporcionado: sincronizar un catálogo dos veces al día no necesita una cola,
y en Render un worker encendido las 24 horas más su Redis suman unos **21 USD al
mes**.

El cron hace el mismo trabajo, cuesta una fracción y reutiliza exactamente el
código que ya usa el panel — lo que significa que está igual de probado.

La cola tendría sentido si hubiera que reaccionar a webhooks en segundos o si el
volumen creciera mucho. Hoy no es el caso, y montarla «por si acaso» sería pagar
y mantener una pieza más que puede romperse sin resolver ningún problema real.

## Al desplegar

1. Las migraciones se aplican solas en el build.
2. El cron es un **servicio nuevo**: hay que crearlo desde el Blueprint en
   Render, o a mano copiando la configuración de `render.yaml`.
3. Comprueba la primera ejecución del cron en sus *Logs* antes de fiarte de él.

**336 pruebas en verde.**
