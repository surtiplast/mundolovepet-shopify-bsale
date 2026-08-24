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

---

## El hueco que quedaba: el candidato tiene DOS códigos

_24/08/2026_

`planificarCreacion` recibe `codigosEnShopify`, un conjunto con **los SKU y los
códigos de barras** que la tienda ya conoce. Bien construido. El problema estaba
en cómo se consultaba:

```ts
const clave = normalizarSku(p.sku);
if (codigosEnShopify?.has(clave)) { /* omitir */ }
```

Sólo se buscaba el SKU del candidato. **Su código de barras no se comprobaba
nunca**, aunque el comentario de al lado prometiera «por cualquiera de los dos
campos».

Eso dejaba pasar el caso más frecuente de todos: un artículo con SKU nuevo cuyo
EAN ya está en la tienda bajo otro SKU. Pasaba la comprobación, se creaba, y
nacía duplicado.

Ahora se miran los dos, y cada uno con su motivo, porque no significan lo mismo
para quien lee el informe:

- «Ya existe en Shopify (por SKU o código de barras)» → el SKU choca.
- «Su código de barras ya está en la tienda con otro SKU» → el EAN choca.

## Y el catálogo que se duplica a sí mismo

Hay un segundo camino, más sutil. Bsale tiene el mismo artículo dado de alta dos
veces, con SKU distinto y **el mismo EAN del fabricante**. Los dos son nuevos
para Shopify, así que los dos pasaban la comprobación —correctamente, porque
ninguno estaba— y **la propia pasada creaba el duplicado**.

De ahí el conjunto `reservados`: un candidato aceptado reserva sus dos códigos
para el resto de la pasada. El primero se crea; el segundo se omite con su
motivo. Ninguna comprobación contra Shopify podía atrapar esto, porque el choque
no era con la tienda: era consigo mismo.
