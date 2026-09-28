/**
 * Logger de aplicación.
 *
 * Dos capas de redacción, porque un token filtrado en un log es un incidente
 * de seguridad, no una molestia:
 *
 *  1. El `redact` de pino, por RUTA exacta (`*.token`, `*.secret`...). Rápido,
 *     pero sólo cubre las formas que alguien previó al escribir la lista.
 *  2. `redact()` de `mask.ts` corriendo sobre TODO objeto que se loguea, vía
 *     `formatters.log`. Recorre cualquier estructura anidada y censura por
 *     nombre de clave sin importar la ruta — la red que atrapa lo que la
 *     lista de rutas no supo prever.
 */
import pino from 'pino';
import { redact } from './mask.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-shopify-access-token"]',
      'req.headers["x-shopify-hmac-sha256"]',
      'req.headers.access_token',
      'res.headers["set-cookie"]',
      '*.access_token',
      '*.accessToken',
      '*.token',
      '*.password',
      '*.secret',
    ],
    censor: '[REDACTADO]',
  },
  formatters: {
    log: (object) => redact(object) as Record<string, unknown>,
  },
  base: { app: 'mundolovepet-sync' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
