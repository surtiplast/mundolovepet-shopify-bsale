# Emisión de comprobantes — cómo funciona

_18/08/2026 · Fases 4 a 6_

## El recorrido

```
Pedido pagado en Shopify
        ↓  se lee el campo «Empresa» del checkout
   ¿DNI, RUC, o nada?
        ↓
   RUC válido → FACTURA        DNI → BOLETA
   sin nada   → BOLETA a consumidor final
   RUC inválido → NO se emite. Revisión humana.
        ↓
   Se arma el comprobante: valores sin IGV, línea de envío, cuadre ±0,02
        ↓
   Bsale: buscar el cliente por DNI/RUC → crear sólo si no existe
        ↓
   POST /v1/documents.json con salesId  →  SUNAT
```

## De dónde sale el DNI/RUC

Del campo **Empresa** (`company`) del checkout de Shopify. Es un campo nativo de
la dirección, disponible en todos los planes; los campos propios del checkout
exigirían Shopify Plus.

Se lee primero el de la dirección de facturación y, si está vacío, el de envío.

El cliente escribe texto libre, así que `src/domain/documento.ts` acepta todas
estas formas:

| Lo que escribe el cliente | Qué se entiende |
|---|---|
| `20131312955` | RUC → factura |
| `RUC 20131312955` | RUC → factura |
| `20131312955 - MI EMPRESA SAC` | RUC + razón social → factura |
| `20-131312955` | RUC → factura |
| `DNI 45678912` | DNI → boleta |
| *(vacío)* | boleta a consumidor final |
| `Veterinaria San Roque` | **revisión**: hay nombre pero no número |
| `20131312954` | **revisión**: el dígito verificador no cuadra |

### Por qué un RUC inválido no se degrada a boleta

Es la decisión de diseño más importante del módulo. Quien escribe un RUC quiere
factura, y una boleta no le sirve para deducir el gasto. Emitirle una boleta
obligaría a anularla ante SUNAT y emitir la factura después.

Es más barato no emitir y preguntarle el número correcto.

## El dígito verificador del RUC

Módulo 11 con los factores `5 4 3 2 7 6 5 4 3 2`. El verificador es
`11 − (suma mod 11)`, con dos casos especiales: 10 → 0 y 11 → 1.

Comprobado contra el RUC de la propia SUNAT, `20131312955`: la suma da 94,
94 mod 11 = 6, y 11 − 6 = 5, que es su último dígito. Las pruebas usan además
los de RENIEC y el BCP.

También se comprueba el prefijo: sólo 10, 15, 17 y 20 son RUCs. Un número de 11
dígitos que empiece por otra cosa no lo es aunque el verificador cuadre por
casualidad.

## El cálculo del IGV

Es lo que más fácil sale mal. En Perú los precios de la tienda llevan el IGV
dentro. Bsale quiere el valor **sin** impuesto:

```
101,00 / 1,18 = 85,593220…
```

No se asume que los lleve: Shopify lo dice en cada pedido (`taxesIncluded`), y
se usa ese dato. Si un día se cambia la configuración de la tienda, asumirlo
emitiría todos los comprobantes con un 18 % de más o de menos.

### El descuento va incorporado, no como porcentaje

Bsale admite un `discount` en porcentaje por línea. No se usa: se manda
directamente el precio ya rebajado. Un porcentaje obliga a redondear dos veces
y basta un céntimo de deriva para descuadrar. Con el precio final el total sale
exacto por construcción.

### El envío

Va como una línea más, con su IGV y **sin `code`**: no es un producto del
inventario, así que no debe buscarse en el catálogo de Bsale ni descontar stock.

### El cuadre

Antes de emitir se comprueba que lo calculado coincide con lo que cobró Shopify,
con dos céntimos de margen para el redondeo. Si no cuadra **no se emite nada**:
la diferencia suele ser un descuento a nivel de pedido o un impuesto distinto, y
declarar un importe que no es el cobrado es un problema con SUNAT y con el
cliente.

## Los tres candados anti-duplicado

Emitir dos veces el mismo comprobante es el peor fallo posible de esta app.

1. **`salesId` en Bsale** — `shopify-order-<id>`. Si Bsale ya tiene un documento
   con ese id, **devuelve el existente en vez de crear otro**. Es la defensa que
   funciona aunque falle todo lo demás, y por eso `emitirDocumento()` se niega a
   emitir sin él.
2. **`OrderSync.shopifyOrderId @unique`** — un pedido no puede registrarse dos
   veces, ni aunque dos procesos lo intenten a la vez: lo rechaza PostgreSQL.
3. **`BsaleDocument.bsaleDocumentId @unique`** — un documento de Bsale no puede
   asociarse a dos pedidos.

## La fecha de emisión

Bsale avisa de que a este campo **no se le aplica zona horaria**: sólo cuenta la
fecha. Por eso se manda a medianoche UTC. Mandar la hora local haría que un
pedido de las 23:30 en Lima se emitiera con la fecha del día siguiente, y eso
descuadra la declaración mensual.

## Por qué la emisión es manual

Un comprobante mal emitido no se corrige con un despliegue: hay que anularlo
ante SUNAT con otro documento. Mientras el flujo no lleve semanas funcionando
sin sobresaltos, conviene que una persona mire cada uno.

Automatizarlo después no obliga a rehacer nada: el mismo servicio se llamaría
desde un webhook. Sí requiere activar la cola y el worker en Render (unos 21 USD
al mes), hoy comentados en `render.yaml`.

## El stock no se descuenta al emitir

`dispatch: 0`. El stock ya se sincroniza desde Bsale hacia Shopify; si además el
comprobante descontara stock en Bsale, la misma venta se restaría dos veces.

## Antes de poder emitir

Hacen falta cuatro variables de entorno en Render. La app se niega a emitir sin
ellas, con un mensaje que dice cuál falta:

| Variable | De dónde sale |
|---|---|
| `BSALE_OFFICE_ID` | «Descubrir configuración de Bsale» |
| `BSALE_DOCTYPE_BOLETA_ID` | ídem — **en producción, filtrando `isElectronic: true`** |
| `BSALE_DOCTYPE_FACTURA_ID` | ídem |
| `BSALE_TAX_ID_IGV` | ídem |

> ⚠️ En el sandbox ningún tipo de documento tiene `isElectronic: true`, y es
> correcto: en pruebas no se declara nada ante SUNAT. En producción sí los
> habrá, y son esos —y sólo esos— los que valen. Ver `docs/IDS-BSALE.md`.

## Qué falta

- Guardar cada emisión en `OrderSync` y `BsaleDocument`. Hoy la app emite pero
  no deja rastro en su propia base de datos: el candado que funciona es el
  `salesId` de Bsale.
- Descargar el PDF a almacenamiento privado (fase 7).
- Escribir la serie y el número en un metafield del pedido de Shopify.
- Notas de crédito para devoluciones.
