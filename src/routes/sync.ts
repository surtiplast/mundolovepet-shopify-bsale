/**
 * API de sincronización Bsale → Shopify — Fase 3.
 *
 * Dos endpoints, y la diferencia entre ellos es la más importante del proyecto:
 *
 *   POST /api/sync/preview   calcula qué cambiaría. NO escribe.
 *   POST /api/sync/apply     escribe de verdad en la tienda.
 *
 * `apply` exige `?confirmar=si` en la URL. No es burocracia: evita que una
 * pulsación accidental, un enlace copiado o un reintento del navegador
 * modifiquen miles de precios. Escribir en la tienda de un cliente debe costar
 * un gesto deliberado.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import type { ConnectionService } from '../services/connection.service.js';
import type { CatalogStore } from '../db/catalog.store.js';
import { compararCatalogos } from '../services/matching.service.js';
import {
  planificar,
  aplicarStock,
  aplicarPrecios,
  type TipoSync,
  type ResultadoAplicacion,
} from '../services/sync.service.js';
import type { ShopifyVariant } from '../integrations/shopify/client.js';
import { IntegrationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const syncLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas sincronizaciones seguidas. Espera unos minutos.' },
});

function tipoDe(req: Request): TipoSync | null {
  const t = String(req.query.tipo ?? '').toUpperCase();
  return t === 'STOCK' || t === 'PRECIO' ? t : null;
}

export function syncRouter(service: ConnectionService, store: CatalogStore, env: Env): Router {
  const router = Router();

  /**
   * Vuelve a leer Shopify y calcula el plan.
   *
   * Se relee en vez de reutilizar lo del emparejamiento anterior: entre una
   * cosa y otra alguien pudo cambiar un precio a mano, y aplicar sobre datos
   * viejos escribiría valores que ya no corresponden.
   */
  async function calcularPlan(tipo: TipoSync, limite?: number) {
    const guardados = await store.listar();
    if (guardados.length === 0) {
      throw new IntegrationError('No hay catálogo de Bsale leído todavía.', {
        provider: 'BSALE',
        retryable: false,
      });
    }

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
        // La sucursal de Shopify donde vive el inventario. Se toma la primera
        // activa: la mayoría de tiendas tiene una sola.
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

    return { plan: planificar(informe.emparejados, tipo, limite), locationId, productoPorVariante };
  }

  /** Simulación. Nunca escribe. */
  router.post('/sync/preview', syncLimiter, async (req: Request, res: Response) => {
    const tipo = tipoDe(req);
    if (!tipo) return res.status(400).json({ error: { message: 'Indica tipo=STOCK o tipo=PRECIO.' } });

    const limite = Number(req.query.limite) > 0 ? Number(req.query.limite) : undefined;

    try {
      const { plan } = await calcularPlan(tipo, limite);
      res.json({
        ok: true,
        simulacion: true,
        tipo,
        resumen: plan.resumen,
        omitidos: plan.omitidos.slice(0, 50),
        totalOmitidos: plan.omitidos.length,
        cambios: plan.cambios.slice(0, 200),
      });
    } catch (error) {
      responderError(res, error, 'No se pudo calcular la simulación.');
    }
  });

  /** Aplicación real. Exige confirmación explícita en la URL. */
  router.post('/sync/apply', syncLimiter, async (req: Request, res: Response) => {
    const tipo = tipoDe(req);
    if (!tipo) return res.status(400).json({ error: { message: 'Indica tipo=STOCK o tipo=PRECIO.' } });

    if (String(req.query.confirmar) !== 'si') {
      return res.status(400).json({
        error: {
          message:
            'Esta operación modifica la tienda. Añade confirmar=si para ejecutarla, o usa /sync/preview para simular.',
        },
      });
    }

    const limite = Number(req.query.limite) > 0 ? Number(req.query.limite) : undefined;

    try {
      const { plan, locationId, productoPorVariante } = await calcularPlan(tipo, limite);

      if (plan.cambios.length === 0) {
        return res.json({ ok: true, simulacion: false, tipo, resultado: { aplicados: 0, fallidos: 0, errores: [] }, resumen: plan.resumen });
      }

      let resultado: ResultadoAplicacion = { aplicados: 0, fallidos: 0, errores: [] };
      if (tipo === 'STOCK') {
        if (!locationId) {
          throw new IntegrationError('No se encontró ninguna sucursal activa en Shopify.', {
            provider: 'SHOPIFY',
            retryable: false,
          });
        }
        await service.usarShopify(
          env.SHOPIFY_SHOP_DOMAIN,
          env.SHOPIFY_API_VERSION,
          env.SHOPIFY_CLIENT_ID,
          async (client) => {
            resultado = await aplicarStock(client, plan, locationId!);
          },
        );
      } else {
        await service.usarShopify(
          env.SHOPIFY_SHOP_DOMAIN,
          env.SHOPIFY_API_VERSION,
          env.SHOPIFY_CLIENT_ID,
          async (client) => {
            resultado = await aplicarPrecios(client, plan, productoPorVariante);
          },
        );
      }

      logger.info({ tipo, ...resultado, planificados: plan.cambios.length }, 'Sincronización aplicada');

      res.json({ ok: true, simulacion: false, tipo, resultado, resumen: plan.resumen });
    } catch (error) {
      responderError(res, error, 'No se pudo aplicar la sincronización.');
    }
  });

  return router;
}

function responderError(res: Response, error: unknown, mensaje: string): void {
  const err =
    error instanceof IntegrationError
      ? error
      : new IntegrationError(mensaje, { provider: 'SHOPIFY', retryable: false, cause: error });
  logger.error({ err: err.toPublic() }, mensaje);
  res.status(502).json({ error: err.toPublic() });
}
