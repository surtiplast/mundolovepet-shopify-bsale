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

---

## Lo que pasó el 24/08 y por qué parecía que no funcionaba

_24/08/2026_

La reparación **sí funcionaba**. Los registros del servidor lo dicen sin
ambigüedad:

```
04:34:08  reparados:218  fallidos:0  errores:[]
          total:218  codigoDeBarras:189  costo:29  revisados:3282
```

218 productos corregidos, ninguno rechazado por Shopify. Y sin embargo la
impresión desde el panel era la contraria: «dice que corrigió pero no corrige».

Tres cosas distintas se juntaron para producir esa impresión, y las tres tienen
arreglo en la interfaz, no en la lógica.

### 1. El resumen contaba los éxitos y callaba los motivos

De 3.282 variantes revisadas se tocaron 218. Las otras ~3.000 no fallaron: es
que **Bsale no tiene el dato**. Muchas variantes llevan el SKU en el campo del
código de barras porque el `barCode` de Bsale está vacío, y el criterio —bien
elegido— es no inventarse un código antes que dejar uno falso que un lector de
tienda daría por bueno.

Pero el panel no decía eso. Decía «reparados 218» y nada más, así que al abrir
cualquier producto al azar era probable encontrarlo igual que antes. De ahí el
contador nuevo `sinCodigoEnBsale`, y el equivalente para el costo: el panel
ahora dice cuántos no se pueden arreglar **y por qué**. Un número que no cambia
deja de ser un misterio.

### 2. Un botón cobraba el precio del otro

El código de barras se decide con el catálogo que ya está en la base de datos:
es instantáneo. El costo obliga a preguntarle a Bsale variante por variante.
Con las dos cosas en un botón, cada pulsación pagaba los ~55 segundos del costo
aunque sólo se quisiera arreglar el código.

Ahora son dos operaciones (`?campos=barcode` y `?campos=costo`) con su botón
cada una. Sin el parámetro se hacen las dos, como antes, para que un enlace
guardado siga funcionando.

### 3. Reparar hace *aparecer* duplicados que ya existían

Esta es la parte que menos se ve venir. `buscarDuplicados` no indexa el código
de barras cuando es idéntico al SKU —sería contar el mismo choque dos veces—.
Así que **antes** de reparar, una variante con `barcode == sku` no aportaba
ningún grupo de duplicados.

Al reparar, esa variante pasa a tener su EAN real. Y si dos productos distintos
comparten el mismo EAN del fabricante —cosa normalísima: el mismo artículo dado
de alta dos veces en Bsale con SKU distinto— aparece un grupo de duplicados que
antes estaba escondido.

Se ve en el tamaño de las respuestas de `/api/duplicados` aquella tarde:

| Hora | Tamaño |
|---|---|
| 04:26 | 27 KB |
| **04:34** | **← se repararon 189 códigos de barras** |
| 04:37 | 59 KB |

**La reparación no creó ni un solo producto.** No puede: `productVariantsBulkUpdate`
actualiza variantes que ya existen. Lo que hizo fue destapar colisiones de EAN
preexistentes. El informe empeoró porque los datos mejoraron.

## El borrado de duplicados

`POST /api/duplicados/eliminar` borra los duplicados de los que se puede estar
seguro. Sin `confirmar=si`, simula.

Las cuatro reglas, y la lógica detrás de que sean tan estrechas: borrar un
producto en Shopify **no se deshace** —no hay papelera—, y recuperarlo significa
volver a crearlo a mano con sus fotos y su historial de ventas perdido. La
pregunta no es «¿cuántos puedo borrar?» sino «¿de cuáles estoy completamente
seguro?».

1. **Sólo borradores.** Un producto publicado puede estar vendiéndose ahora.
2. **Sólo sin imagen.** Una foto significa que una persona pasó por ahí.
3. **Sólo productos de una única variante.** Shopify borra el producto entero;
   si tiene dos tallas se llevaría la buena por delante.
4. **Siempre sobrevive uno** por cada código, aunque todos cumplan lo anterior.

Lo que no cumpla las cuatro se queda, y el informe dice el motivo. Un duplicado
que sobrevive se borra a mano en un minuto; uno borrado por error cuesta una
tarde.

Lleva además su propio limitador —4 llamadas cada 5 minutos, frente a las 10 del
resto— para que un reintento del navegador no pueda encadenar borrados.
