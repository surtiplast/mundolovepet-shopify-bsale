# Prompt: conseguir el token de Admin API de Shopify

Copia todo lo que hay debajo de la línea y pégalo en una sesión nueva.

---

Necesito obtener el **Admin API access token** de mi tienda Shopify y me he
quedado atascado. **No soy desarrollador**: dime exactamente dónde hacer clic,
pantalla por pantalla, y si algo no aparece pídeme una captura en vez de asumir
que está.

## Qué necesito exactamente

Dos valores, para configurar una integración con Bsale:

- `SHOPIFY_SHOP_DOMAIN` — el dominio interno, formato `algo.myshopify.com`
- `SHOPIFY_ADMIN_TOKEN` — el **Admin API access token**, empieza por `shpat_`

Mi tienda es **Mundo Love Pet**. En la URL del admin aparece como
`admin.shopify.com/store/mundo-love-pet`, así que el dominio probablemente sea
`mundo-love-pet.myshopify.com` — con guiones. Ayúdame a confirmarlo en
**Configuración → Dominios** antes de darlo por bueno.

Los ámbitos que la app debe pedir son estos siete, ni uno más:

```
read_products, write_products, read_inventory, write_inventory,
read_orders, read_customers, read_locations
```

## Lo que YA intenté y no funcionó — no me lo repitas

Creé una app llamada **«Sinc Bsale Fac»** en el **panel de desarrollador**
(`dev.shopify.com/dashboard/...`) y la instalé en la tienda por OAuth. Esa app
tiene «ID de cliente» y «Secreto», y también vi un «Token de automatización de
la app».

**Ninguna de esas tres cosas es lo que necesito.** Ya me confirmaron que las
apps del panel de desarrollador funcionan con OAuth y no entregan un Admin API
access token. Esa vía está descartada: no me mandes de vuelta a Partners ni al
dev dashboard.

## Lo que necesito es otra cosa

Una **app personalizada creada dentro del admin de la tienda**, en:

**Configuración → Apps y canales de venta → Desarrollar apps**

Esa pantalla no pide client_id ni URLs de redirección: solo nombre, ámbitos e
instalar. Y al instalarla entrega el token `shpat_` directamente.

## Dónde estoy atascado

**No encuentro esa opción.** En Configuración → Apps y canales de venta no veo
ni «Desarrollar apps» ni nada parecido.

Lo que me han sugerido comprobar, y necesito que lo verifiquemos juntos:

1. Que exista el botón **«Permitir el desarrollo de apps personalizadas»** —
   Shopify lo bloquea por defecto y hay que activarlo una vez.
2. Que yo esté entrando como **propietario** de la tienda y no como colaborador,
   porque solo el propietario puede habilitarlo.
3. Si Shopify ha movido o retirado esa opción en la versión actual del admin, y
   en ese caso cuál es la alternativa vigente para obtener un token `shpat_`.

Empieza por ahí. Si resulta que la opción ya no existe, dímelo claramente en vez
de darme rodeos, y busca cuál es hoy la forma correcta.

## Avisos

- El token **se muestra una sola vez**. Recuérdame copiarlo antes de cerrar la
  ventana, y qué hacer si se me pasa.
- El dominio va **sin** `https://` y **sin** barra final. El validador de mi app
  lo rechaza si no cumple el formato exacto.
- Dominio y token tienen que ser de **la misma tienda**. Si mezclo el dominio de
  una con el token de otra, Shopify responde 401 o 404 sin explicar nada.
- **No me pidas que te pegue el token en el chat.** Dime dónde guardarlo y ya.
