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
 * sólo se guarda el evento crudo (ver `db/webhook.store.ts`) y se responde.
 *
 * ── Qué SÍ hace con el `topic` ────────────────────────────────────────────
 *
 * No se intenta leer del cuerpo qué cambió exactamente — eso sí seguiría sin
 * payloads reales con los que validarlo, y adivinar la forma es la manera
 * más rápida de repetir el bug de `isElectronicDocument`. En cambio, el aviso
 * se usa sólo como una señal («algo cambió, revisa ahora») para lanzar fuera
 * de turno la misma sincronización que ya corre cada minuto por cron — ver
 * `dispararSincronizacion` más abajo. Así el panel refleja un cambio real de
 * Bsale en segundos en vez de esperar al siguiente minuto, sin tener que
 * confiar en ningún campo del cuerpo del webhook más que `topic`.
 */
import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import type { Env } from '../config/env.js';
import type { WebhookStore } from '../db/webhook.store.js';
import { igualSeguro } from '../lib/auth.js';
import { logger } from '../lib/logger.js';

/** Los únicos topics que Bsale manda y que de verdad cambian el catálogo. */
const TOPICS_QUE_DISPARAN_SYNC = new Set(['price', 'stock', 'product', 'variant']);

/**
 * No más de un disparo cada tantos milisegundos: una importación masiva en
 * Bsale puede mandar cientos de webhooks casi juntos, y no hace falta lanzar
 * un proceso por cada uno — el candado de abajo ya rechaza los solapados, esto
 * sólo evita gastar en arrancar procesos que van a chocar con ese candado.
 */
const DEBOUNCE_MS = 5_000;
let ultimoDisparo = 0;

/**
 * Lanza una pasada de sincronización fuera de turno, sin esperarla.
 *
 * Reutiliza el mismo script que el cron (`dist/jobs/sincronizar.js`), no una
 * copia de su lógica: así queda igual de probado y respeta los mismos
 * interruptores de automático/manual del panel. El candado —`flock -n` sobre
 * un archivo dentro del propio contenedor— es el mismo tipo que ya usa el
 * cron para no solaparse consigo mismo; aquí además evita que un disparo por
 * webhook choque con una corrida del cron que ya esté en marcha. Si el
 * candado está tomado, `flock -n` simplemente no llega a arrancar `node` — no
 * espera, no encola: esa pasada normal del cron de todas formas iba a llegar
 * al mismo resultado en menos de un minuto.
 */
function dispararSincronizacion(motivo: string): void {
  const ahora = Date.now();
  if (ahora - ultimoDisparo < DEBOUNCE_MS) return;
  ultimoDisparo = ahora;

  const proceso = spawn(
    'flock',
    ['-n', '/tmp/sincronizar.lock', 'node', 'dist/jobs/sincronizar.js'],
    { stdio: 'ignore', detached: true },
  );
  proceso.on('error', (error) => {
    logger.error({ motivo, err: error.message }, 'No se pudo lanzar la sincronización disparada por webhook');
  });
  proceso.unref();
  logger.info({ motivo }, 'Sincronización disparada fuera de turno por un webhook de Bsale');
}

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

    // Va después de intentar guardar, pero no depende de que se haya
    // guardado: reaccionar al cambio real de Bsale importa más que nuestro
    // propio registro de auditoría de webhooks.
    if (TOPICS_QUE_DISPARAN_SYNC.has(topic)) {
      dispararSincronizacion(topic);
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
