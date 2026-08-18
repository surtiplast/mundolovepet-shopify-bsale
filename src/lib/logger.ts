/**
 * Logger de aplicación.
 *
 * pino con redacción activada a nivel de librería, además de nuestro `redact()`
 * para el contenido que va a la base de datos. Dos capas, porque un token
 * filtrado en un log es un incidente de seguridad, no una molestia.
 */
import pino from 'pino';

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
  base: { app: 'mundolovepet-sync' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
