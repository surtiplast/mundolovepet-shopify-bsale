# La app dentro del admin de Shopify

_20/08/2026_

Que la app aparezca en **Aplicaciones** dentro de tu admin y se abra ahí, en vez
de tener que ir a la URL de Render.

No es sólo comodidad: al abrirse dentro de Shopify, Shopify firma un token en
cada llamada, y eso es autenticación de verdad — atada a tus usuarios de
Shopify, sin contraseñas que rotar.

## Cómo entra la gente ahora

Hay **dos puertas**, y las dos siguen abiertas a propósito.

### 1. Desde Shopify (la buena)

App Bridge entrega un token de sesión firmado con tu Client Secret. El servidor
comprueba cuatro cosas antes de dejar pasar:

- que la **firma** cuadre con el Client Secret,
- que el algoritmo sea **HS256** —exigido, no leído del token—,
- que `aud` sea el Client ID de **esta** app,
- que `dest` sea **tu** tienda.

El token dura **un minuto**, así que se pide en cada llamada. Cachearlo daría
401 al minuto de tener la pestaña abierta.

### 2. Por la URL, con usuario y contraseña

No se quita al llegar la primera, y es deliberado: si algún día la app deja de
cargar dentro de Shopify —una configuración mal puesta, un cambio de App
Bridge—, sin esta puerta no habría forma de entrar a arreglarlo. Un candado que
puede dejarte fuera de tu propia herramienta no es más seguro, es más frágil.

## Dos detalles que no son obvios

**El HTML del panel no pide credenciales cuando lo abre Shopify.** Tiene que ser
así: en ese momento lo pide el navegador para meterlo en el marco, App Bridge
todavía no se ha cargado y no hay ningún token que mandar. Exigir cabecera ahí
haría que la app no llegara a abrirse nunca.

No abre ningún agujero: el HTML no lleva datos. Todo lo que se ve viene de
`/api/*`, que sí exige token o contraseña. Lo único que decide es **qué puerta**
se le enseña a quien llama. Y hace falta en los dos sentidos: si el HTML se
sirviera siempre sin candado, al abrir el panel por su URL el navegador nunca
recibiría un 401 de navegación y nunca mostraría el cuadro de usuario y
contraseña.

**La cabecera `frame-ancestors` cambió.** Antes era `'none'` —nadie puede
enmarcar la app—, que es seguro pero incompatible con abrirla desde Shopify.
Ahora permite exactamente a tu tienda y a `admin.shopify.com`, y a nadie más.

## Qué hay que configurar

### 1. En el Dev Dashboard

Entra en tu app → **Configuration**:

| Campo | Valor |
|---|---|
| App URL | la URL de tu servicio en Render |
| Embedded | **activado** |
| Allowed redirection URL(s) | `<url-de-render>/api/auth/callback` |

Sin **Embedded** activado, Shopify abre la app en una pestaña aparte, no hay
token de sesión, y todo se queda como antes.

### 2. En el repositorio

`shopify.app.toml` tiene lo mismo por escrito, con dos huecos marcados
`RELLENAR`: el `client_id` y la `application_url`. Si usas la Shopify CLI, ese
fichero aplica la configuración sola; si no, basta con hacerlo a mano en el Dev
Dashboard y el fichero queda como documentación.

### 3. En Render

Nada nuevo. La clave de App Bridge que necesita el HTML es el
`SHOPIFY_CLIENT_ID`, que ya está, y el servidor la inyecta al servir la página.

## Comprobar que funciona

1. Admin de Shopify → **Aplicaciones** → tu app. Debe abrirse **dentro** del
   admin, con el menú de Shopify alrededor.
2. Pulsa cualquier botón. Si responde, el token de sesión está funcionando.
3. Abre la URL de Render directamente en una ventana de incógnito. Debe pedir
   usuario y contraseña.

Si la app aparece en blanco dentro de Shopify, mira la consola del navegador:
casi siempre es `frame-ancestors` o que **Embedded** sigue desactivado.

Si las llamadas dan 401 con «La firma no cuadra», el `SHOPIFY_CLIENT_SECRET` de
Render no es el de esta app.
