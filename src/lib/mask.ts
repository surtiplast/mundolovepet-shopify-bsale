/**
 * Enmascarado y redacción.
 *
 * Regla del proyecto: un token completo NUNCA sale del backend, ni al panel,
 * ni a los logs, ni a un mensaje de error. Este módulo es el único lugar
 * autorizado para decidir qué parte de un secreto es visible.
 */

/**
 * Devuelve una representación segura de un token: sólo los últimos 4 caracteres.
 *   shpat_abc...wxyz  →  ••••wxyz
 * Tokens muy cortos se ocultan por completo — mostrar 4 de 6 caracteres sería
 * filtrar la mayor parte del secreto.
 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return '—';
  if (token.length < 8) return '••••';
  return `••••${token.slice(-4)}`;
}

/** Últimos 4 caracteres, para persistir junto al token cifrado y poder mostrarlo. */
export function tokenLast4(token: string): string {
  return token.length < 8 ? '' : token.slice(-4);
}

/** Claves cuyo valor jamás debe aparecer en un log, sin importar dónde estén anidadas. */
const SENSITIVE_KEYS = new Set([
  'access_token',
  'accesstoken',
  'accessToken',
  'token',
  'authorization',
  'x-shopify-access-token',
  'password',
  'passwordhash',
  'passwordHash',
  'secret',
  'sessionsecret',
  'encryptionkey',
  'encryptionKey',
  'apikey',
  'apiKey',
  'apisecret',
  'clientsecret',
  'hmac',
  'signature',
  'cookie',
  'set-cookie',
]);

const REDACTED = '[REDACTADO]';

/**
 * Recorre una estructura arbitraria y reemplaza los valores sensibles.
 * Se aplica a TODO lo que va a `SyncLog.context` y a los logs de pino.
 *
 * `depth` evita que una estructura circular o muy profunda haga explotar la pila.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[PROFUNDIDAD_MAXIMA]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return '[BUFFER]';

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Limpia un mensaje de error antes de mostrarlo o guardarlo.
 * Cubre el caso en que un token se cuele dentro del texto de un error (por
 * ejemplo, una URL con el token como query param, o un mensaje de librería).
 */
export function scrubMessage(message: string, secrets: readonly string[] = []): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join(REDACTED);
    }
  }
  // Patrones conocidos de tokens de Shopify.
  out = out.replace(/shp(at|ca|ss|pa)_[A-Za-z0-9]{8,}/g, REDACTED);
  return out;
}
