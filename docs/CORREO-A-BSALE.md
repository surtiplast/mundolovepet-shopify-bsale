# Correo a Bsale — activación de API y webhooks

Dos peticiones en un solo correo. La segunda tarda en tramitarse, así que
conviene mandarla ya aunque la emisión no esté lista.

**Para:** ayuda@bsale.app
**Asunto:** Activación de emisión electrónica por API y webhooks — RUC [TU RUC]

---

Buenos días,

Soy Rolando, de **Mundo Love Pet** (RUC **[TU RUC]**). Estamos integrando
nuestra tienda de Shopify con Bsale para que los pedidos de la web generen
automáticamente su boleta o factura en Bsale, y necesito confirmar dos cosas.

**1. Emisión electrónica por API**

Tenemos contratado el plan **Estándar**. Quiero confirmar que nuestra cuenta
puede **emitir comprobantes electrónicos a través de la API**, concretamente con
`POST /v1/documents.json`, y no sólo desde la interfaz de Bsale.

Si hace falta activar algo o cambiar de plan para eso, agradecería que me lo
indiquen antes de continuar con el desarrollo.

**2. Activación de webhooks**

Solicito la activación de webhooks para nuestra cuenta, con estos *topics*:

- `document` (documento emitido)
- `stock`
- `product`
- `variant`
- `price`

URL de destino:

```
https://[TU-DOMINIO-EN-RENDER]/webhooks/bsale/[SEGMENTO-SECRETO]
```

Sin los webhooks tendríamos que consultar la API periódicamente para enterarnos
de cada cambio de stock o de precio, lo que multiplica las llamadas sin
necesidad.

Quedo atento. Gracias.

Rolando
Mundo Love Pet
surtiplast.pe@gmail.com

---

## Antes de enviarlo

Hay tres huecos que rellenar:

| Hueco | De dónde sale |
|---|---|
| `[TU RUC]` | El RUC de Mundo Love Pet |
| `[TU-DOMINIO-EN-RENDER]` | La URL del servicio en Render |
| `[SEGMENTO-SECRETO]` | Ver abajo |

### El segmento secreto

Es una cadena larga y aleatoria que va en la URL del webhook. Sirve para que
nadie que no conozca esa URL pueda mandarle datos falsos a la app. Genérala así
en PowerShell:

```powershell
-join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
```

Guarda el resultado: va en el correo **y** en una variable de entorno de Render
(`BSALE_WEBHOOK_SECRET`). Tienen que coincidir.

No la pegues en un chat ni en un correo que no sea este.

## Qué esperar de la respuesta

- **Sobre la API:** puede que respondan que ya está activa, o que hay que
  pedirla aparte. Cualquiera de las dos respuestas sirve; lo que no sirve es
  seguir desarrollando sin saberlo.
- **Sobre los webhooks:** el trámite no es inmediato. Por eso se manda ahora.

Mientras tanto se puede seguir trabajando: la fase 4 recibe los pedidos de
**Shopify**, y eso no depende de Bsale.
