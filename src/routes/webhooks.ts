/**
 * Receptor de webhooks de Bsale.
 *
 * ── El formato del payload ────────────────────────────────────────────────
 *
 * No es una suposición: es el que documenta Bsale en
 * https://docs.bsale.dev/formas-de-pago/webhooks/
 *
 *   { "cpnId": 8849, "resource": "/v1/payments/3229.json",
 *     "resourceId": "3229", "topic": "payment", "action": "post",
 *     "send": 1646914861 }
 *
 * `action` es `post` (creación) o `put` (actualización); Bsale no notifica
 * `DELETE`. Los topics que se pidieron activar (ver docs/CORREO-A-BSALE.md)
 * son `document`, `stock`, `product`, `variant` y `price` — no `payment`,
 * que es sólo el ejemplo de la documentación.
 *
 * ── Por qué el secreto va en la URL y no en una cabecera ────────────────────
 *
 * La documentación de Bsale no describe ninguna firma HMAC para sus
 * webhooks (a diferencia de Shopify). El único candado disponible es que la
 * URL de destino sea impredecible: por eso lleva un segmento aleatorio de 32
 * bytes, y por eso un secreto que no calza responde 404 — nunca 401 ni 403,
 * que confirmarían que el endpoint existe.
 *
 * ── Por qué responde 200 casi sin mirar el cuerpo ────────────────────────────
 *
 * Un webhook que tarda o falla se reintenta y satura la cola de Bsale. Aquí
 * sólo se guarda el evento crudo (ver `db/webhook.store.ts`) y se responde;
 * decidir qué hacer con cada `topic` es un paso posterior, deliberadamente
 * fuera de este archivo — no hay payloads reales todavía con los que
 * validar esa lógica, y adivinarla es la forma más rápida de escribir un
 * bug igual que el de `isElectronicDocument`.
 */
import { Router, type Request, type Response } from 'express';
import type { Env } from '../config/env.js';
import type { WebhookStore } from '../db/webhook.store.js';
import { igualSeguro } from '../lib/auth.js';
import { logger } from '../lib/logger.js';

interface PayloadBsale {
  cpnId?: number;
  resource?: string;
  resourceId?: string | number;
  topic?: string;
  action?: string;
  send?: number;
}

export function webhooksRouter(env: Env, webhooks: WebhookStore): Router {
  const router = Router();

  router.post('/webhooks/bsale/:secreto', async (req: Request, res: Response) => {
    const esperado = env.BSALE_WEBHOOK_PATH_SECRET;
    // Sin secreto configurado, la función no está activa: mismo 404 que un
    // secreto equivocado, para no distinguir los dos casos desde fuera.
    if (!esperado || !igualSeguro(req.params.secreto ?? '', esperado)) {
      res.status(404).end();
      return;
    }

    const cuerpo = (req.body ?? {}) as PayloadBsale;
    const topic = typeof cuerpo.topic === 'string' && cuerpo.topic ? cuerpo.topic : 'desconocido';
    // `resourceId` debería venir siempre, pero si Bsale mandara algo fuera de
    // formato no hay que perderlo: se guarda igual, con un id propio.
    const externalId =
      cuerpo.resourceId !== undefined && cuerpo.resourceId !== null
        ? String(cuerpo.resourceId)
        : `sin-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const { yaExistia } = await webhooks.registrar({
        source: 'BSALE',
        externalId,
        topic,
        payload: cuerpo,
      });
      logger.info({ topic, action: cuerpo.action, externalId, yaExistia }, 'Webhook de Bsale recibido');
    } catch (error) {
      // No se reintenta desde aquí ni se le pide a Bsale que reintente por un
      // fallo nuestro de guardado: el evento ya quedó en este log si hace
      // falta reconstruirlo.
      logger.error(
        { topic, externalId, err: (error as Error).message },
        'No se pudo guardar el webhook de Bsale',
      );
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
