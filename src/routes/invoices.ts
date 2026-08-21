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
import type { InvoiceStore } from '../db/invoice.store.js';
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
    // Bsale envía el comprobante al cliente. Se puede apagar con
    // `BSALE_ENVIAR_CORREO=0` si algún día su cuenta empieza a mandarlo por su
    // cuenta y los clientes lo recibieran dos veces.
    enviarCorreo: env.BSALE_ENVIAR_CORREO,
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

export function invoicesRouter(
  service: ConnectionService,
  env: Env,
  emisiones: InvoiceStore,
): Router {
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

      // Los que ya se emitieron. Sin esto el panel volvería a ofrecer el botón
      // de emitir en pedidos ya facturados, y aunque Bsale no crearía un
      // segundo comprobante, invitar a pulsarlo es pedir un susto.
      const facturados = await emisiones.listarFacturados();

      const filas = planes.map((plan) => {
        const ya = facturados.get(plan.pedido.legacyId);
        return {
          ...resumirParaPanel(plan),
          emitido: ya
            ? {
                comprobante: ya.kind,
                serie: ya.serialNumber,
                numero: ya.number,
                sunat: ya.sunatState,
                fecha: ya.emitidoEl,
                tienePdf: ya.tienePdf,
              }
            : null,
        };
      });

      res.json({
        ok: true,
        total: planes.length,
        resumen: {
          emitidos: filas.filter((f) => f.emitido).length,
          boletas: filas.filter((f) => !f.emitido && f.comprobante === 'BOLETA' && f.puedeEmitirse).length,
          facturas: filas.filter((f) => !f.emitido && f.comprobante === 'FACTURA' && f.puedeEmitirse).length,
          revisar: filas.filter((f) => !f.emitido && !f.puedeEmitirse).length,
        },
        pedidos: filas,
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

      // ── Registrar la emisión ────────────────────────────────────────────
      //
      // Va DESPUÉS de emitir y en su propio try: si Bsale ya emitió el
      // comprobante, un fallo al guardarlo en nuestra base no debe convertirse
      // en un error para el usuario. El comprobante existe; lo que faltaría es
      // el apunte, y eso se arregla sin consecuencias fiscales.
      const doc = resultado.documento;
      if (doc) {
        try {
          await emisiones.registrar({
            shopifyOrderId: plan.pedido.legacyId,
            shopifyOrderName: plan.pedido.nombre,
            shopifyOrderGid: plan.pedido.id,
            idempotencyKey: plan.documento.salesId!,
            kind: plan.decision.comprobante!,
            totalAmount: plan.resumen.total,
            currency: plan.pedido.moneda,
            documento: {
              bsaleDocumentId: doc.id,
              documentTypeId: plan.documento.documentTypeId,
              serialNumber: doc.serialNumber ?? String(doc.number),
              number: doc.number,
              emissionDate: doc.emissionDate,
              totalAmount: doc.totalAmount,
              token: doc.token,
              sunatState: doc.informed ?? null,
              sunatMessage: doc.responseMsg ?? null,
              // `urlPdfOriginal` trae sólo el original; `urlPdf` incluye las
              // copias. Se prefiere el segundo: es lo que el cliente espera
              // recibir.
              urlPdf: doc.urlPdf ?? doc.urlPublicView ?? null,
            },
          });
        } catch (error) {
          logger.error(
            { pedido: plan.pedido.nombre, err: (error as Error).message },
            'El comprobante se emitió pero no se pudo registrar en la base de datos',
          );
        }
      }

      // ── Dejarlo escrito en el pedido de Shopify ─────────────────────────
      //
      // Para que se vea desde el propio pedido, sin abrir esta app. Va en su
      // propio try por lo mismo que el registro: el comprobante ya existe, y
      // que no se pueda anotar no debe presentarse como un fallo de emisión.
      if (doc) {
        try {
          await service.usarShopify(
            env.SHOPIFY_SHOP_DOMAIN,
            env.SHOPIFY_API_VERSION,
            env.SHOPIFY_CLIENT_ID,
            async (client) => {
              const r = await client.guardarComprobanteEnPedido(plan.pedido.id, {
                tipo: plan.decision.comprobante!,
                serie: doc.serialNumber ?? String(doc.number),
                numero: doc.number,
                documentoId: doc.id,
              });
              if (!r.ok) {
                logger.warn(
                  { pedido: plan.pedido.nombre, errores: r.errores },
                  'No se pudieron escribir los metafields del comprobante',
                );
              }
            },
          );
        } catch (error) {
          logger.warn(
            { pedido: plan.pedido.nombre, err: (error as Error).message },
            'No se pudieron escribir los metafields del comprobante',
          );
        }
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

  /**
   * El PDF del comprobante.
   *
   * ── Por qué pasa por aquí y no se enlaza directamente ─────────────────────
   *
   * La URL que devuelve Bsale es pública para quien la tenga: lleva un token en
   * la propia dirección y no pide nada más. Enlazarla desde el panel la pondría
   * en el historial del navegador, en los registros de cualquier intermediario
   * y en el portapapeles de quien la copie.
   *
   * Sirviéndola desde aquí, el PDF queda detrás del mismo candado que el resto
   * del panel y la dirección de Bsale no sale nunca del servidor.
   */
  router.get('/comprobantes/:pedido/pdf', async (req: Request, res: Response) => {
    try {
      const url = await emisiones.urlPdfDe(req.params.pedido!);
      if (!url) {
        return res.status(404).json({ error: { message: 'Ese pedido no tiene comprobante.' } });
      }

      const respuesta = await fetch(url);
      if (!respuesta.ok || !respuesta.body) {
        throw new IntegrationError(`Bsale devolvió ${respuesta.status} al pedir el PDF.`, {
          provider: 'BSALE',
          retryable: true,
        });
      }

      res.setHeader('Content-Type', 'application/pdf');
      // `inline` para que se abra en el navegador; el nombre sólo importa si el
      // usuario lo descarga.
      res.setHeader(
        'Content-Disposition',
        `inline; filename="comprobante-${req.params.pedido}.pdf"`,
      );

      const buffer = Buffer.from(await respuesta.arrayBuffer());
      res.send(buffer);
    } catch (error) {
      responderError(res, error, 'No se pudo obtener el PDF del comprobante.');
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
