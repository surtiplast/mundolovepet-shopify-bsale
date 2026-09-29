/**
 * Sincronización automática Bsale → Shopify.
 *
 * Hace, sin que nadie pulse nada, lo mismo que los botones del panel: lee el
 * catálogo de Bsale, lo compara con Shopify y aplica las diferencias.
 *
 * ── Por qué un cron y no una cola con worker ─────────────────────────────────
 *
 * La arquitectura original planteaba BullMQ con un worker permanente. Para este
 * caso es desproporcionado: sincronizar un catálogo dos veces al día no es una
 * carga que necesite una cola, y en Render un worker encendido las 24 horas más
 * su Redis cuestan unos 21 USD al mes.
 *
 * Un cron ejecuta este archivo, hace el trabajo y termina. Cuesta una fracción,
 * no añade una pieza más que pueda romperse, y reutiliza exactamente el mismo
 * código que ya usa el panel — lo que significa que está igual de probado.
 *
 * La cola tendría sentido si hubiera que reaccionar a webhooks en segundos o si
 * el volumen creciera mucho. Hoy no es el caso, y montarla «por si acaso» sería
 * pagar y mantener algo que no resuelve ningún problema actual.
 *
 * ── Qué sincroniza y qué no ──────────────────────────────────────────────────
 *
 * **Stock, siempre.** Es lo que cambia a todas horas y lo que provoca sobreventa
 * si se queda viejo.
 *
 * **Precios, sólo si se pide.** Un precio que cambia solo en mitad del día es
 * mucho más delicado: un error en Bsale se propaga a la tienda sin que nadie lo
 * mire. Por eso hay que activarlo a conciencia con `SYNC_AUTO_PRECIOS=1`.
 *
 * **Costo y productos nuevos, sólo si se pide.** Igual que los precios: por
 * defecto quedan desactivados y se activan desde el mismo botón del panel que
 * stock y precios. El costo sólo rellena lo que en Shopify falta o es cero
 * (nunca pisa uno puesto a mano — ver `repair.service.ts`), y los productos se
 * crean **en borrador**, nunca publicados — ver `create.service.ts`.
 *
 * **Comprobantes, nunca.** Emitir declara ante SUNAT.
 */
import { loadEnv } from '../config/env.js';
import { parseEncryptionKey } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { PrismaConnectionStore, type PrismaLike } from '../db/prisma.store.js';
import { PrismaCatalogStore, type PrismaCatalogLike } from '../db/catalog.store.js';
import {
  PrismaSettingsStore,
  leerInterruptor,
  CLAVE_SYNC_AUTO_PRECIOS,
  CLAVE_SYNC_AUTO_STOCK,
  CLAVE_REPARAR_AUTO_COSTO,
  CLAVE_CREAR_AUTO_PRODUCTOS,
  type PrismaSettingsLike,
} from '../db/settings.store.js';
import { ConnectionService } from '../services/connection.service.js';
import { leerCatalogo, normalizarSku, type ItemCatalogo } from '../services/catalog.service.js';
import { compararCatalogos } from '../services/matching.service.js';
import { planificar, aplicarStock, aplicarPrecios } from '../services/sync.service.js';
import { planificarReparacion, anadirCostosReparacion, aplicarReparacion } from '../services/repair.service.js';
import { planificarCreacion, anadirCostos, crearProductos } from '../services/create.service.js';
import type { ShopifyVariant } from '../integrations/shopify/client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const inicio = Date.now();

  if (!env.BSALE_OFFICE_ID || !env.BSALE_PRICE_LIST_ID) {
    // Sin sucursal y lista de precios no se puede leer el catálogo. Se sale con
    // error para que Render marque la ejecución como fallida y se vea.
    throw new Error(
      'Faltan BSALE_OFFICE_ID y BSALE_PRICE_LIST_ID. Sin ellos no se puede sincronizar.',
    );
  }

  const mod = (await import('@prisma/client')) as unknown as {
    PrismaClient: new (args?: unknown) => PrismaLike & { $connect(): Promise<void> };
  };
  const prisma = new mod.PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  await prisma.$connect();

  const service = new ConnectionService({
    store: new PrismaConnectionStore(prisma),
    encryptionKey: parseEncryptionKey(env.ENCRYPTION_KEY),
  });
  const catalogo = new PrismaCatalogStore(prisma as unknown as PrismaCatalogLike);
  const settings = new PrismaSettingsStore(prisma as unknown as PrismaSettingsLike);
  // Los botones del panel guardan aquí, no en el .env: este proceso es aparte
  // del servidor HTTP (lo lanza el cron vía `docker exec`), así que sólo la
  // base de datos compartida puede avisarle de un cambio hecho desde el
  // panel. El de stock por defecto es `true` —hasta que existió el botón, el
  // cron siempre lo aplicaba—; el de precios sigue usando
  // `env.SYNC_AUTO_PRECIOS` como antes si nadie tocó el botón todavía.
  const syncAutoStock = await leerInterruptor(settings, CLAVE_SYNC_AUTO_STOCK, true);
  const syncAutoPrecios = await leerInterruptor(
    settings,
    CLAVE_SYNC_AUTO_PRECIOS,
    env.SYNC_AUTO_PRECIOS,
  );
  const repararAutoCosto = await leerInterruptor(settings, CLAVE_REPARAR_AUTO_COSTO, false);
  const crearAutoProductos = await leerInterruptor(settings, CLAVE_CREAR_AUTO_PRODUCTOS, false);

  // ── 1. Leer Bsale ──────────────────────────────────────────────────────────
  const { items } = await service.usarBsale(env.BSALE_API_BASE_URL, (client) =>
    leerCatalogo(client, {
      priceListId: env.BSALE_PRICE_LIST_ID!,
      officeId: env.BSALE_OFFICE_ID!,
    }),
  );

  await catalogo.guardar(
    items.map((i: ItemCatalogo) => ({
      sku: i.sku,
      barcode: i.barcode,
      brand: i.marca,
      bsaleVariantId: i.bsaleVariantId,
      bsaleProductId: i.bsaleProductId,
      name: i.nombre,
      bsalePrice: i.precio,
      bsaleStock: i.stock,
    })),
  );

  const guardados = await catalogo.listar();

  // ── 2. Leer Shopify ────────────────────────────────────────────────────────
  const variantes: ShopifyVariant[] = [];
  let locationId: string | null = null;
  const productoPorVariante = new Map<string, string>();

  await service.usarShopify(
    env.SHOPIFY_SHOP_DOMAIN,
    env.SHOPIFY_API_VERSION,
    env.SHOPIFY_CLIENT_ID,
    async (client) => {
      for await (const v of client.listarVariantes()) {
        variantes.push(v);
        if (v.productId) productoPorVariante.set(v.id, v.productId);
      }
      const ubicaciones = await client.listLocations(10);
      locationId = ubicaciones.find((u) => u.isActive)?.id ?? ubicaciones[0]?.id ?? null;
    },
  );

  const informe = compararCatalogos(
    guardados.map((g) => ({
      sku: g.sku,
      bsaleVariantId: g.bsaleVariantId ?? 0,
      nombre: g.name,
      precio: g.bsalePrice,
      stock: g.bsaleStock,
    })),
    variantes,
  );

  // ── 3. Aplicar ─────────────────────────────────────────────────────────────
  const resumen: Record<string, unknown> = {
    variantesBsale: items.length,
    variantesShopify: variantes.length,
    emparejados: informe.emparejados.length,
    conDiferencias: informe.conDiferencias,
  };

  // El stock se aplica solo si el botón del panel lo dejó activo (por
  // defecto sí, para no cambiar el comportamiento de antes de que existiera
  // este interruptor). Apagarlo sirve, por ejemplo, mientras se hace un
  // conteo físico y no se quiere que el cron escriba encima a cada minuto.
  if (!syncAutoStock) {
    resumen.stock = { motivo: 'desactivado' };
  } else {
    const planStock = planificar(informe.emparejados, 'STOCK');
    if (planStock.cambios.length > 0) {
      // Si hay cambios reales pero no se encontró sucursal, esto NO es «sin
      // cambios»: es un fallo. Confundirlos dejaría el cron en verde mientras
      // el stock se desincroniza sin que nadie se entere (ver routes/sync.ts,
      // que sí distingue los dos casos).
      if (!locationId) {
        throw new Error(
          'Hay cambios de stock pendientes pero no se encontró ninguna sucursal activa en Shopify.',
        );
      }
      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          const r = await aplicarStock(client, planStock, locationId!);
          resumen.stock = r;
        },
      );
    } else {
      resumen.stock = { aplicados: 0, fallidos: 0, motivo: 'sin cambios' };
    }
  }

  // Los precios sólo si se ha pedido expresamente, desde el botón del panel
  // o (si nunca se tocó) desde SYNC_AUTO_PRECIOS.
  if (syncAutoPrecios) {
    const planPrecio = planificar(informe.emparejados, 'PRECIO');
    if (planPrecio.cambios.length > 0) {
      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          const r = await aplicarPrecios(client, planPrecio, productoPorVariante);
          resumen.precios = r;
        },
      );
    } else {
      resumen.precios = { aplicados: 0, fallidos: 0, motivo: 'sin cambios' };
    }
  } else {
    resumen.precios = { motivo: 'desactivado' };
  }

  // El costo: sólo rellena lo que en Shopify falta o es cero (ver
  // repair.service.ts), así que activarlo no puede pisar un costo puesto a
  // mano. No se toca el código de barras aquí: ese sigue siendo un botón
  // aparte porque casi no quedan productos con esa huella del fallo antiguo.
  if (repararAutoCosto) {
    const planReparacion = planificarReparacion(guardados, variantes, undefined, {
      barcode: false,
      costo: true,
    });
    if (planReparacion.reparaciones.length > 0) {
      const costos = await service.usarBsale(env.BSALE_API_BASE_URL, (bsale) =>
        anadirCostosReparacion(planReparacion, (variantId) => bsale.obtenerCosto(variantId)),
      );
      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          const r = await aplicarReparacion(client, planReparacion);
          resumen.costo = { ...r, ...costos };
        },
      );
    } else {
      resumen.costo = { reparados: 0, fallidos: 0, motivo: 'sin cambios' };
    }
  } else {
    resumen.costo = { motivo: 'desactivado' };
  }

  // Productos nuevos: siempre en borrador (crearProductos nunca publica), y
  // con la misma doble comprobación contra duplicados que usa el botón manual
  // — ver planificarCreacion.
  if (crearAutoProductos) {
    const codigosEnShopify = new Set<string>();
    for (const v of variantes) {
      const sku = normalizarSku(v.sku);
      const barcode = normalizarSku(v.barcode);
      if (sku) codigosEnShopify.add(sku);
      if (barcode) codigosEnShopify.add(barcode);
    }

    const planCreacion = planificarCreacion(guardados, informe.soloEnBsale, undefined, codigosEnShopify);
    if (planCreacion.candidatos.length > 0) {
      if (!locationId) {
        throw new Error(
          'Hay productos nuevos por crear pero no se encontró ninguna sucursal activa en Shopify.',
        );
      }
      const costos = await service.usarBsale(env.BSALE_API_BASE_URL, (bsale) =>
        anadirCostos(planCreacion, (variantId) => bsale.obtenerCosto(variantId)),
      );
      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          const r = await crearProductos(client, planCreacion, locationId!);
          resumen.productosNuevos = { ...r, ...costos };
        },
      );
    } else {
      resumen.productosNuevos = { creados: 0, fallidos: 0, motivo: 'sin candidatos' };
    }
  } else {
    resumen.productosNuevos = { motivo: 'desactivado' };
  }

  logger.info({ ...resumen, segundos: Math.round((Date.now() - inicio) / 1000) },
    'Sincronización automática terminada');
}

// Un cron TIENE que terminar. Si no llama a `process.exit`, Render lo da por
// colgado y sigue contando —y cobrando— su tiempo de ejecución.
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Falló la sincronización automática');
    process.exit(1);
  });
