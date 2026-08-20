# Los SKU duplicados al crear productos

_20/08/2026_

## El síntoma

Al pulsar «Crear productos en Shopify», algunos SKU acababan **repetidos** en la
tienda: el producto ya existía y se creaba otra vez.

## La causa

`compararCatalogos` decide qué productos faltan en Shopify. Miraba **un solo
campo**:

```js
const indice = campoRecomendado === 'barcode' ? porBarcode : porSku;
```

`campoRecomendado` es el campo que más coincidencias produce — en esta tienda,
el SKU. Pero eso no significa que TODOS los productos tengan ahí su código.

Si un producto existía en Shopify con el código en **`barcode`** y el `sku`
vacío, la búsqueda por SKU no lo encontraba, entraba en `soloEnBsale`, y el alta
lo creaba otra vez.

No era hipotético: en la comparación de esta tienda, 802 productos emparejaban
por código de barras.

## Por qué se me pasó

El módulo estaba escrito para responder «¿en qué campo están los códigos?» y
elegir el mejor para **sincronizar** — ahí sí necesitas un campo concreto,
porque vas a escribir en una variante concreta.

Pero la misma función también decide **qué falta**, y para eso la pregunta es
otra: «¿está en Shopify, en el campo que sea?». Reutilicé una respuesta para dos
preguntas distintas.

## Cómo quedó

**El campo recomendado ahora decide cuál se prueba primero, no cuál es el único
que cuenta.** Si el código no aparece en el campo preferido, se busca en el
otro. Sólo cuando no está en ninguno se considera ausente.

El informe trae una cifra nueva, `rescatadosPorElOtroCampo`: cuántos productos
se encontraron gracias a esa segunda búsqueda. Cada uno es un duplicado que se
habría creado.

### La segunda red

`planificarCreacion` recibe además el conjunto de **todos** los códigos que
Shopify ya conoce, de sus dos campos, y se niega a crear cualquiera que esté
ahí — aunque el informe diga que falta.

Es redundante a propósito. Los dos errores posibles no cuestan lo mismo:

- **No crear algo que faltaba** → se arregla pulsando otra vez.
- **Crear un duplicado** → hay que buscarlo y borrarlo a mano en Shopify.

Cuando la diferencia es esa, comprobar dos veces sale barato.

## Qué mirar en el panel

Dos contadores nuevos:

- **Comparar con Shopify** → «Hallados por el otro campo»
- **Simular alta de productos** → «Ya existían»

Si alguno sale distinto de cero, son duplicados que se acaban de evitar.

## Los duplicados que ya se crearon

Esto impide crear nuevos, **no limpia los que ya están**. Para encontrarlos, en
el admin de Shopify busca por el SKU repetido y borra el que esté en borrador y
sin foto — los que creó la app.

Si son muchos, se puede añadir un informe que los liste automáticamente
agrupando las variantes por código.
