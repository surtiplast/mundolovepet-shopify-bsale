/**
 * API de comprobantes — fases 4 a 6.
 *
 *   GET  /api/pedidos              lista los pedidos pagados y qué se emitiría
 *   POST /api/pedidos/:id/emitir   emite de verdad. Exige confirmar=si.
 *
 * La emisión es de uno en uno y a mano, a propósito. Un comprobante mal emitido
 * no se corrige con un despliegue: hay que anularlo ante SUNAT con otro
 * documento. Mientras el flujo no lleve semanas funcionando sin sobresaltos,
 * conviene que una persona mire cada uno antes de declararlo.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import type { ConnectionService } from '../services/connection.service.js';
import {
  planificarComprobante,
  emitirComprobante,
  type ConfigComprobante,
  type PlanComprobante,
} from '../services/invoice.service.js';
import type { PedidoShopify } from '../integrations/shopify/client.js';
import { IntegrationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** El IGV peruano. Se deja como constante nombrada, no como 0.18 suelto. */
const TASA_IGV = 0.18;

const emitirLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas emisiones seguidas. Espera unos minutos.' },
});

/**
 * Reúne la configuración de Bsale y explica qué falta si falta algo.
 *
 * Los ids son OPCIONALES en el esquema de entorno porque en las fases 1 a 3 no
 * hacían falta. Para emitir sí, y sin ellos la app no puede saber si está
 * mandando una boleta o una factura. Antes que adivinar, se para con un
 * mensaje que dice exactamente qué variable falta.
 */
function configuracion(env: Env): ConfigComprobante {
  const faltan: string[] = [];
  if (!env.BSALE_OFFICE_ID) faltan.push('BSALE_OFFICE_ID');
  if (!env.BSALE_DOCTYPE_BOLETA_ID) faltan.push('BSALE_DOCTYPE_BOLETA_ID');
  if (!env.BSALE_DOCTYPE_FACTURA_ID) faltan.push('BSALE_DOCTYPE_FACTURA_ID');
  if (!env.BSALE_TAX_ID_IGV) faltan.push('BSALE_TAX_ID_IGV');

  if (faltan.length > 0) {
    throw new IntegrationError(
      `Faltan variables de entorno para emitir: ${faltan.join(', ')}. ` +
        'Pulsa «Descubrir configuración de Bsale» y ponlas en Render.',
      { provider: 'BSALE', retryable: false },
    );
  }

  return {
    officeId: env.BSALE_OFFICE_ID!,
    priceListId: env.BSALE_PRICE_LIST_ID,
    doctypeBoletaId: env.BSALE_DOCTYPE_BOLETA_ID!,
    doctypeFacturaId: env.BSALE_DOCTYPE_FACTURA_ID!,
    taxIdIgv: env.BSALE_TAX_ID_IGV!,
    tasaIgv: TASA_IGV,
    // El stock ya se sincroniza desde Bsale hacia Shopify. Si además el
    // comprobante descontara stock, la misma venta se restaría dos veces.
    descontarStock: false,
  };
}

/** Lo que se manda al panel. El documento entero no hace falta ahí. */
function resumirParaPanel(plan: PlanComprobante) {
  return {
    id: plan.pedido.id,
    nombre: plan.pedido.nombre,
    fecha: plan.pedido.creadoEl,
    cliente: plan.pedido.cliente?.nombre ?? plan.pedido.email,
    empresa: plan.pedido.empresa,
    comprobante: plan.decision.comprobante,
    identificacion: {
      tipo: plan.decision.identificacion.tipo,
      numero: plan.decision.identificacion.numero,
      razonSocial: plan.decision.identificacion.razonSocial,
    },
    motivoDecision: plan.decision.motivo,
    puedeEmitirse: plan.documento !== null,
    motivos: plan.motivos,
    avisos: plan.avisos,
    resumen: plan.resumen,
    lineas: plan.pedido.lineas.length,
  };
}

export function invoicesRouter(service: ConnectionService, env: Env): Router {
  const router = Router();

  /** Lista de pedidos con la simulación de cada uno. Nunca emite. */
  router.get('/pedidos', async (req: Request, res: Response) => {
    const limite = Number(req.query.limite) > 0 ? Math.min(Number(req.query.limite), 250) : 50;
    const filtro = String(req.query.filtro ?? 'financial_status:paid');

    try {
      const config = configuracion(env);
      const pedidos: PedidoShopify[] = [];

      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          for await (const p of client.listarPedidos(filtro, limite)) pedidos.push(p);
        },
      );

      const planes = pedidos.map((p) => planificarComprobante(p, config));

      res.json({
        ok: true,
        total: planes.length,
        resumen: {
          boletas: planes.filter((p) => p.decision.comprobante === 'BOLETA' && p.documento).length,
          facturas: planes.filter((p) => p.decision.comprobante === 'FACTURA' && p.documento).length,
          revisar: planes.filter((p) => !p.documento).length,
        },
        pedidos: planes.map(resumirParaPanel),
      });
    } catch (error) {
      responderError(res, error, 'No se pudieron leer los pedidos.');
    }
  });

  /** Simulación de un pedido concreto, con el JSON que se le mandaría a Bsale. */
  router.get('/pedidos/:id/simular', async (req: Request, res: Response) => {
    try {
      const config = configuracion(env);
      const plan = await planDe(req.params.id!, config);
      if (!plan) return res.status(404).json({ error: { message: 'Pedido no encontrado.' } });

      res.json({ ok: true, simulacion: true, ...resumirParaPanel(plan), documento: plan.documento });
    } catch (error) {
      responderError(res, error, 'No se pudo simular el comprobante.');
    }
  });

  /**
   * Emite. **Declara ante SUNAT.**
   *
   * Se relee el pedido de Shopify en vez de fiarse de lo que muestre el panel:
   * entre que se cargó la lista y se pulsa el botón, el pedido pudo cancelarse
   * o reembolsarse.
   */
  router.post('/pedidos/:id/emitir', emitirLimiter, async (req: Request, res: Response) => {
    if (String(req.query.confirmar) !== 'si') {
      return res.status(400).json({
        error: {
          message:
            'Emitir declara el comprobante ante SUNAT y no se deshace. Añade confirmar=si.',
        },
      });
    }

    try {
      const config = configuracion(env);
      const plan = await planDe(req.params.id!, config);
      if (!plan) return res.status(404).json({ error: { message: 'Pedido no encontrado.' } });

      if (!plan.documento) {
        return res.status(400).json({
          error: { message: plan.motivos.join(' | ') || 'Este pedido no se puede facturar.' },
        });
      }

      const resultado = await service.usarBsale(env.BSALE_API_BASE_URL, (bsale) =>
        emitirComprobante(bsale, plan),
      );

      if (!resultado.ok) {
        logger.error({ pedido: plan.pedido.nombre, error: resultado.error }, 'Emisión fallida');
        return res.status(502).json({ error: { message: resultado.error } });
      }

      logger.info(
        {
          pedido: plan.pedido.nombre,
          documento: resultado.documento?.serialNumber,
          tipo: plan.decision.comprobante,
          yaExistia: resultado.yaExistia,
        },
        'Comprobante emitido',
      );

      res.json({
        ok: true,
        comprobante: plan.decision.comprobante,
        documento: {
          id: resultado.documento?.id,
          serie: resultado.documento?.serialNumber,
          numero: resultado.documento?.number,
          total: resultado.documento?.totalAmount,
          // `informed`: 0 correcto, 1 enviado, 2 rechazado por SUNAT.
          sunat: resultado.documento?.informed,
          mensajeSunat: resultado.documento?.responseMsg,
          urlPdf: resultado.documento?.urlPdf,
        },
      });
    } catch (error) {
      responderError(res, error, 'No se pudo emitir el comprobante.');
    }
  });

  /** Relee el pedido de Shopify y calcula su plan. */
  async function planDe(id: string, config: ConfigComprobante): Promise<PlanComprobante | null> {
    const gid = id.startsWith('gid://') ? id : `gid://shopify/Order/${id}`;
    let pedido: PedidoShopify | null = null;

    await service.usarShopify(
      env.SHOPIFY_SHOP_DOMAIN,
      env.SHOPIFY_API_VERSION,
      env.SHOPIFY_CLIENT_ID,
      async (client) => {
        pedido = await client.obtenerPedido(gid);
      },
    );

    return pedido ? planificarComprobante(pedido, config) : null;
  }

  return router;
}

function responderError(res: Response, error: unknown, mensaje: string): void {
  const err =
    error instanceof IntegrationError
      ? error
      : new IntegrationError(mensaje, { provider: 'BSALE', retryable: false, cause: error });
  logger.error({ err: err.toPublic() }, mensaje);
  res.status(502).json({ error: err.toPublic() });
}
