/**
 * API del catálogo — Fase 2.
 *
 * Sólo lectura desde Bsale. No escribe nada en Shopify y no emite ningún
 * documento. Lo único que se guarda es el propio catálogo en `ProductMap`,
 * para poder consultarlo sin volver a recorrer la API entera.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import type { ConnectionService } from '../services/connection.service.js';
import type { CatalogStore } from '../db/catalog.store.js';
import { leerCatalogo, type ItemCatalogo } from '../services/catalog.service.js';
import { compararCatalogos } from '../services/matching.service.js';
import type { ShopifyVariant } from '../integrations/shopify/client.js';
import { IntegrationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Leer el catálogo recorre la API de Bsale entera. Con un catálogo grande son
 * cientos de peticiones, así que no puede dispararse a voluntad desde el panel.
 */
const lecturaLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas lecturas del catálogo. Espera unos minutos.' },
});

export function catalogRouter(
  service: ConnectionService,
  store: CatalogStore,
  env: Env,
): Router {
  const router = Router();

  /**
   * Lo último leído, desde la base de datos. Rápido y sin tocar Bsale.
   * Es lo que carga el panel al abrirse.
   */
  router.get('/catalog', async (_req: Request, res: Response) => {
    const [items, total] = await Promise.all([store.listar(), store.contar()]);
    res.json({ total, items });
  });

  /**
   * Relee el catálogo desde Bsale, lo diagnostica y lo guarda.
   *
   * Requiere que estén configurados el ID de lista de precios y el de sucursal:
   * sin ellos no se sabe qué precio publicar ni de qué stock partir. Se
   * descubren en la Fase 1 con `/api/connections/bsale/discover`.
   */
  router.post('/catalog/read', lecturaLimiter, async (req: Request, res: Response) => {
    const priceListId = env.BSALE_PRICE_LIST_ID;
    const officeId = env.BSALE_OFFICE_ID;

    if (!priceListId || !officeId) {
      return res.status(400).json({
        error: {
          message:
            'Faltan BSALE_PRICE_LIST_ID y/o BSALE_OFFICE_ID. Descúbrelos con «Descubrir configuración de Bsale» y añádelos a las variables de entorno.',
        },
      });
    }

    // Permite pedir sólo una muestra sin recorrer un catálogo enorme.
    const maxItems = Number(req.query.max) > 0 ? Number(req.query.max) : undefined;

    try {
      const { items, resumen } = await service.usarBsale(env.BSALE_API_BASE_URL, (client) =>
        leerCatalogo(client, { priceListId, officeId, maxItems }),
      );

      const guardados = await store.guardar(
        items.map((i: ItemCatalogo) => ({
          sku: i.sku,
          bsaleVariantId: i.bsaleVariantId,
          bsaleProductId: i.bsaleProductId,
          name: i.nombre,
          bsalePrice: i.precio,
          bsaleStock: i.stock,
        })),
      );

      logger.info(
        {
          total: resumen.total,
          conProblemas: resumen.conProblemas,
          sinSku: resumen.sinSku,
          duplicados: resumen.skusDuplicados,
          guardados,
        },
        'Catálogo de Bsale leído',
      );

      res.json({ ok: true, resumen, guardados, items });
    } catch (error) {
      const err =
        error instanceof IntegrationError
          ? error
          : new IntegrationError('No se pudo leer el catálogo de Bsale.', {
              provider: 'BSALE',
              retryable: false,
              cause: error,
            });
      logger.error({ err: err.toPublic() }, 'Fallo al leer el catálogo de Bsale');
      res.status(502).json({ error: err.toPublic() });
    }
  });

  /**
   * Compara el catálogo guardado de Bsale con el de Shopify — Fase 3, paso 1.
   *
   * SÓLO LECTURA. No escribe ni un precio. Su única función es responder a la
   * pregunta de la que depende toda la sincronización: ¿los códigos de Bsale
   * están en el campo `sku` de Shopify o en `barcode`?
   *
   * Si se acertara por suposición no pasaría nada; si se fallara, la
   * sincronización no actualizaría ningún producto y no daría ningún error.
   */
  router.post('/catalog/match', lecturaLimiter, async (req: Request, res: Response) => {
    const guardados = await store.listar();
    if (guardados.length === 0) {
      return res.status(400).json({
        error: { message: 'Primero lee el catálogo de Bsale: no hay nada con lo que comparar.' },
      });
    }

    const maxItems = Number(req.query.max) > 0 ? Number(req.query.max) : undefined;

    try {
      const variantes: ShopifyVariant[] = [];
      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          for await (const v of client.listarVariantes(maxItems)) variantes.push(v);
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

      logger.info(
        {
          campo: informe.campoRecomendado,
          porSku: informe.coincidenciasPorSku,
          porBarcode: informe.coincidenciasPorBarcode,
          emparejados: informe.emparejados.length,
          conDiferencias: informe.conDiferencias,
        },
        'Emparejamiento Bsale ↔ Shopify calculado',
      );

      // Se mandan TODOS los emparejados, no sólo los que difieren: el panel
      // filtra en local y así el comerciante puede buscar cualquier producto y
      // ver cómo está, no únicamente los que fallan.
      //
      // El tope existe igualmente: un catálogo de 50.000 variantes haría un
      // JSON de varios megas que el navegador tardaría en procesar.
      const conDiferencias = informe.emparejados.filter((e) => e.difierePrecio || e.difiereStock);

      res.json({
        ok: true,
        informe: {
          ...informe,
          emparejados: informe.emparejados.slice(0, 5000),
          soloEnBsale: informe.soloEnBsale.slice(0, 100),
          soloEnShopify: informe.soloEnShopify.slice(0, 100),
          totales: {
            emparejados: informe.emparejados.length,
            conDiferencias: conDiferencias.length,
            soloEnBsale: informe.soloEnBsale.length,
            soloEnShopify: informe.soloEnShopify.length,
          },
        },
      });
    } catch (error) {
      const err =
        error instanceof IntegrationError
          ? error
          : new IntegrationError('No se pudo comparar los catálogos.', {
              provider: 'SHOPIFY',
              retryable: false,
              cause: error,
            });
      logger.error({ err: err.toPublic() }, 'Fallo al comparar catálogos');
      res.status(502).json({ error: err.toPublic() });
    }
  });

  return router;
}
