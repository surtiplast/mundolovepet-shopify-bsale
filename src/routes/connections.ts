/**
 * API del panel — Fase 1.
 *
 * Sólo endpoints de lectura y de prueba de conexión. No hay nada que escriba en
 * Shopify ni que emita documentos en Bsale hasta que las fases siguientes estén
 * aprobadas.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import type { ConnectionService } from '../services/connection.service.js';
import { IntegrationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Las pruebas de conexión salen a APIs externas. Sin límite, alguien podría
 * usarlas para golpear la cuota de Shopify o Bsale desde el panel.
 */
const testLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas pruebas de conexión. Espera un minuto.' },
});

export function connectionsRouter(service: ConnectionService, env: Env): Router {
  const router = Router();

  /** Estado de ambas conexiones. Nunca devuelve tokens. */
  router.get('/connections', async (_req: Request, res: Response) => {
    const connections = await service.listConnections();
    res.json({ connections });
  });

  router.post('/connections/bsale/test', testLimiter, async (_req: Request, res: Response) => {
    const result = await service.testBsale(env.BSALE_API_BASE_URL);
    res.status(result.ok ? 200 : 502).json(result);
  });

  router.post('/connections/shopify/test', testLimiter, async (_req: Request, res: Response) => {
    const result = await service.testShopify(env.SHOPIFY_SHOP_DOMAIN, env.SHOPIFY_API_VERSION, env.SHOPIFY_CLIENT_ID);
    res.status(result.ok ? 200 : 502).json(result);
  });

  /** Prueba ambas a la vez. Es lo que dispara el botón principal del panel. */
  router.post('/connections/test-all', testLimiter, async (_req: Request, res: Response) => {
    const [bsale, shopify] = await Promise.all([
      service.testBsale(env.BSALE_API_BASE_URL),
      service.testShopify(env.SHOPIFY_SHOP_DOMAIN, env.SHOPIFY_API_VERSION, env.SHOPIFY_CLIENT_ID),
    ]);
    const allOk = bsale.ok && shopify.ok;
    res.status(allOk ? 200 : 502).json({ ok: allOk, results: [bsale, shopify] });
  });

  /**
   * Descubre los IDs reales de la cuenta Bsale (sucursales, tipos de documento,
   * impuestos, listas de precio). Sólo lectura.
   */
  router.get('/connections/bsale/discover', testLimiter, async (_req: Request, res: Response) => {
    try {
      const discovery = await service.discoverBsale(env.BSALE_API_BASE_URL);
      res.json(discovery);
    } catch (error) {
      const err =
        error instanceof IntegrationError
          ? error
          : new IntegrationError('No se pudo leer la configuración de Bsale.', {
              provider: 'BSALE',
              retryable: false,
            });
      logger.error({ err: err.toPublic() }, 'Fallo al descubrir configuración de Bsale');
      res.status(502).json({ error: err.toPublic() });
    }
  });

  return router;
}
