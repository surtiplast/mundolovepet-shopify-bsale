/**
 * Worker de segundo plano — marcador de posición de la Fase 1.
 *
 * Existe para que el blueprint de Render despliegue sin fallar si decides
 * activar el servicio `mlp-worker` desde ya. En la Fase 3 este archivo pasa a
 * consumir las colas de BullMQ (sincronización de stock y precios) y en la
 * Fase 6 la cola de emisión de documentos.
 *
 * Si aún no llegas a la Fase 3, lo más sensato es dejar el servicio worker
 * comentado en render.yaml y ahorrarte su costo mensual.
 */
import { logger } from './lib/logger.js';

const HEARTBEAT_MS = 60_000;

logger.info(
  { fase: 1, rol: 'worker' },
  'Worker iniciado en modo inactivo. Las colas se activan en la Fase 3.',
);

const heartbeat = setInterval(() => {
  logger.debug({ rol: 'worker' }, 'Worker inactivo, sin colas registradas.');
}, HEARTBEAT_MS);

/**
 * Apagado ordenado. En la Fase 6 este bloque debe esperar a que termine
 * cualquier job de emisión en curso: cortar a mitad de un POST a Bsale es
 * exactamente el escenario que deja un documento en estado indeterminado.
 */
function shutdown(signal: string): void {
  logger.info({ signal }, 'Cerrando worker ordenadamente…');
  clearInterval(heartbeat);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
