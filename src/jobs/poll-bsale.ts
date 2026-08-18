/**
 * Cron de polling a Bsale — marcador de posición de la Fase 1.
 *
 * Motivo de existir: los webhooks de Bsale se activan por solicitud manual a
 * ayuda@bsale.app, no por API. Hasta que estén operativos, este cron es la
 * única forma de enterarse de cambios de stock y precio.
 *
 * En la Fase 3 pasa a:
 *   1. Leer GET /v1/stocks.json y las listas de precio, paginando de a 50.
 *   2. Comparar contra ProductMap.
 *   3. Encolar sólo las diferencias reales (evitando escrituras inútiles a Shopify).
 *
 * Un cron job debe terminar: si no llama a process.exit, Render lo da por
 * colgado y sigue facturando su tiempo de ejecución.
 */
import { logger } from '../lib/logger.js';

async function main(): Promise<void> {
  logger.info(
    { fase: 1, job: 'poll-bsale' },
    'Polling a Bsale aún no implementado. Se activa en la Fase 3.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Fallo el cron de polling a Bsale');
    process.exit(1);
  });
