# Código de barras y costo — qué salió mal y cómo quedó

_18/08/2026_

## El fallo

La primera versión del alta de productos mandaba a Shopify:

```ts
sku: p.sku,
barcode: p.sku,   // ← el mismo valor en los dos campos
```

Partía de una suposición mía que resultó falsa: que en Bsale había **un solo
código** por variante. No es así. Una variante de Bsale tiene dos campos
distintos:

| Campo en Bsale | Qué es | Ejemplo real |
|---|---|---|
| `code` | SKU interno | `74352029961567` |
| `barCode` | EAN del fabricante | `8595602559152` |

Al copiar el SKU encima, el EAN real nunca llegaba a la tienda. Es el código que
leen los lectores de código de barras del mostrador y el que usa Google Shopping,
así que la pérdida no era cosmética.

Además, el «Costo por artículo» nunca se enviaba: todos los productos creados
quedaban con costo vacío, y con el costo vacío Shopify no puede calcular márgenes.

## Cómo quedó

**Al leer el catálogo** se guarda también `barCode`, en la columna
`ProductMap.barcode` (migración `20260818200000_barcode`).

**Al crear un producto** se manda el EAN real. Si Bsale no tiene ninguno, el
campo se omite en vez de repetir el SKU: un código inventado es peor que ninguno,
porque un lector lo daría por bueno.

**El costo** se lee de `GET /v1/variants/{id}/costs.json` → `averageCost`, y se
manda en `inventoryItem.cost`.

### Por qué el costo se pide aparte

Bsale no expone un listado de costos: hay que preguntar **variante por variante**.
Con 3.238 variantes serían 3.238 peticiones en serie. Por eso no se pide al leer
el catálogo, sino sólo para los productos que se van a crear o reparar.

Ese es el motivo de que `anadirCostos` sea un paso separado de
`planificarCreacion`: planificar sigue siendo instantáneo y sin red, que es lo
que permite simular sin esperas.

Un producto sin costo en Bsale —uno que nunca entró por una recepción— se crea
igual, sin costo. Nunca se manda cero: Shopify leería «cuesta cero» y calcularía
un margen del 100 %.

## La reparación de lo ya creado

`POST /api/sync/reparar` arregla los productos creados antes del cambio, sin
volver a crearlos. Sin `confirmar=si`, simula.

### La regla conservadora, y por qué

El código de barras **sólo se toca cuando en Shopify vale exactamente lo mismo
que el SKU**. Esa igualdad es la huella del fallo, y ningún comerciante escribe
a mano un código de barras idéntico al SKU.

La regla obvia —«si difiere de Bsale, píselo»— habría sido mucho más destructiva.
En esta tienda hay 3.041 productos anteriores a la app cuyos códigos puso alguien
a mano; una sola pulsación los habría reescrito todos, y eso no se deshace.

El costo sigue el mismo criterio: sólo se rellena si en Shopify falta o es cero.
Uno puesto a mano se respeta.

## Referencias de API

- Bsale, costo de una variante:
  [`GET /v1/variants/{id}/costs.json`](https://docs.bsale.dev/PE/variantes#get-costo-de-una-variante)
  → `averageCost` (llega como cadena, no como número).
- Bsale, `barCode` vs `code`:
  [Variantes → Atributos](https://docs.bsale.dev/PE/variantes#atributos).
- Shopify 2026-07,
  [`InventoryItemInput.cost`](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryItemInput)
  (Decimal). Lo aceptan tanto `ProductVariantSetInput.inventoryItem` (el alta,
  vía `productSet`) como `ProductVariantsBulkInput.inventoryItem` (la
  reparación). Para **leerlo** el campo se llama `unitCost` y es un `MoneyV2`:
  esa asimetría entre lectura y escritura es de Shopify, no un error nuestro.
- Requiere los scopes `read_inventory` y `write_inventory`, que la app ya pide.

## Qué hay que hacer al desplegar

1. La migración se aplica sola en el build.
2. Pulsar **«Leer catálogo»** otra vez — los registros guardados no tienen
   todavía el código de barras; se rellena en esa lectura.
3. Pulsar **«Simular reparación»** para ver cuántos productos se corregirían.
4. Si el número cuadra, **«Reparar código de barras y costo»**.
