# IDs de Bsale — sandbox y producción

Registro de los IDs descubiertos con `GET /api/connections/bsale/discover`.

> **Los IDs de Bsale son propios de cada cuenta.** No se heredan del sandbox a
> producción, ni entre empresas. Cada vez que cambie el `BSALE_ACCESS_TOKEN` hay
> que repetir el descubrimiento y confirmar los valores uno por uno.

---

## Sandbox — confirmado el 18/08/2026

Cuenta de pruebas propia de Mundo Love Pet. Se reconoce por la **«T»** al final
del nombre de cada tipo de documento: es la convención de Bsale para el entorno
de pruebas.

| Variable | Valor | Corresponde a |
|---|---|---|
| `BSALE_OFFICE_ID` | `1` | Tienda |
| `BSALE_PRICE_LIST_ID` | `4` | Lista de Precios Base |
| `BSALE_DOCTYPE_BOLETA_ID` | `1` | BOLETA - T |
| `BSALE_DOCTYPE_FACTURA_ID` | `50` | FACTURA - T |
| `BSALE_TAX_ID_IGV` | `1` | IGV 18 % |

La otra sucursal es `2` (Local Comercial); la otra lista de precios es `5` («AA»,
aparentemente de prueba). No se usan.

### Por qué aquí `isElectronic` es false en todos

Ninguno de los 11 tipos de documento del sandbox tiene `isElectronic: true`, y
es correcto: en pruebas no se emite nada ante SUNAT, así que no existe el
documento electrónico. **En producción sí los habrá**, y son esos —y sólo
esos— los que deben usarse.

Consecuencia práctica: en el sandbox no se puede validar que el ID elegido sea
realmente el electrónico. Esa comprobación queda pendiente para producción.

---

## Producción — PENDIENTE

Cuando se conecte la cuenta real:

1. Cambiar `BSALE_ACCESS_TOKEN` por el de producción
2. Volver a pulsar **Descubrir configuración de Bsale**
3. **Filtrar por `isElectronic: true`** y elegir de ahí la boleta y la factura
4. Confirmar visualmente el nombre de cada uno antes de guardar
5. Anotar los valores en la tabla de abajo

| Variable | Valor | Corresponde a |
|---|---|---|
| `BSALE_OFFICE_ID` | | |
| `BSALE_PRICE_LIST_ID` | | |
| `BSALE_DOCTYPE_BOLETA_ID` | | |
| `BSALE_DOCTYPE_FACTURA_ID` | | |
| `BSALE_TAX_ID_IGV` | | |

> ⚠️ Este es el punto del proyecto donde un error no se arregla con un
> despliegue. Si se emite el tipo de comprobante equivocado, hay que anularlo
> ante SUNAT con otro documento. La app sugiere candidatos por coincidencia de
> nombre, pero la confirmación es humana. No la delegues.

---

## Nota sobre la cuenta sandbox compartida

En una primera prueba se usó por error el sandbox **compartido** de Bsale
(`account.bsale.dev`), con 11 sucursales y 50 tipos de documento de varias
empresas mezcladas: *STAGING CARESTINO*, *CRAFTDEMO*, *RIQRA*, *EZ Company*.

Se reconoce a simple vista por el desorden y por nombres de terceros. Si el
descubrimiento devuelve algo así, el token no es el de tu cuenta.
