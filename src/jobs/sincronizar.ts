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
 * **Productos nuevos, nunca.** Crear productos automáticamente llenaría la
 * tienda de fichas a medias. Eso sigue siendo una decisión humana.
 *
 * **Comprobantes, nunca.** Emitir declara ante SUNAT.
 */
import { loadEnv } from '../config/env.js';
import { parseEncryptionKey } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { PrismaConnectionStore, type PrismaLike } from '../db/prisma.store.js';
import { PrismaCatalogStore, type PrismaCatalogLike } from '../db/catalog.store.js';
import { ConnectionService } from '../services/connection.service.js';
import { leerCatalogo, type ItemCatalogo } from '../services/catalog.service.js';
import { compararCatalogos } from '../services/matching.service.js';
import { planificar, aplicarStock, aplicarPrecios } from '../services/sync.service.js';
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

  const planStock = planificar(informe.emparejados, 'STOCK');
  if (planStock.cambios.length > 0 && locationId) {
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

  // Los precios sólo si se ha pedido expresamente.
  if (env.SYNC_AUTO_PRECIOS) {
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
    resumen.precios = { motivo: 'desactivado (SYNC_AUTO_PRECIOS)' };
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
