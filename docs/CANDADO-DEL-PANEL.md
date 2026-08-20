# El candado del panel

_20/08/2026_

## El problema

Hasta hoy el panel y la API estaban **abiertos**. Cualquiera que llegara a la
URL de Render podía:

- leer el catálogo entero,
- cambiar precios y stock en la tienda,
- crear productos,
- y, desde que existe la fase 6, **emitir comprobantes ante SUNAT**.

Las URLs de Render no son secretas. Y un comprobante emitido no se borra: se
anula con otro documento.

Esto debió plantearse al añadir la emisión. En las fases de sólo lectura el
riesgo era discutible; con la emisión cambió de categoría.

## La solución de ahora

Autenticación básica HTTP sobre todo el servicio: el panel y la API a la vez.
El navegador pide usuario y contraseña la primera vez y ya no vuelve a
molestar.

Se elige por ser la que menos piezas nuevas añade: sin sesiones, sin cookies,
sin tabla de usuarios, sin pantalla de login que mantener.

### Sus límites, dichos claramente

- La contraseña viaja en cada petición. Sobre HTTPS va cifrada; sin HTTPS sería
  visible.
- No hay usuarios ni permisos: quien entra, puede todo.
- No caduca; se cierra cerrando el navegador.

Para un panel interno de una persona, detrás de HTTPS, basta mientras dure.

## La solución buena

La app embebida en el admin de Shopify. Ahí la identidad la pone Shopify con un
token de sesión firmado, así que sólo funciona para quien esté dentro del admin
de esa tienda: autenticación real, atada a los usuarios de Shopify, sin
inventar contraseñas.

Cuando eso esté, `src/lib/auth.ts` se retira.

## Por qué el servicio se niega a arrancar sin contraseña

En producción, si faltan `PANEL_USER` o `PANEL_PASSWORD`, `loadEnv` no deja
arrancar.

Arrancar «con un aviso en el log» es lo cómodo, y es justo lo que hace que un
agujero siga abierto durante meses: nadie lee los logs de un servicio que
funciona. Fallar al arrancar es ruidoso, se ve en el acto y se arregla en dos
minutos.

En desarrollo sí se permite sin clave: ahí el servidor sólo escucha en local.

## Qué hacer al desplegar

**Pon las variables ANTES de subir el código.** Si despliegas primero, el
servicio no arrancará hasta que estén.

En Render → tu servicio → **Environment**:

| Variable | Valor |
|---|---|
| `PANEL_USER` | `rolando` |
| `PANEL_PASSWORD` | una contraseña larga y aleatoria |

Para generarla, en PowerShell:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | % {[char]$_})
```

Guárdala en tu gestor de contraseñas. **No la pegues en un chat.**

## Comprobar que funciona

Abre la URL del panel en una ventana de incógnito. Debe pedir usuario y
contraseña antes de enseñar nada. Si entra directo, el despliegue no ha cogido
las variables.
