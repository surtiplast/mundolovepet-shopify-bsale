/**
 * Errores de integración.
 *
 * La distinción clave para toda la app: `retryable`.
 * Un 429 o un 503 se puede reintentar. Un 401 o un 422 no — reintentarlos sólo
 * quema cuota y, en el caso de la emisión de documentos, puede duplicar.
 */

export type Provider = 'SHOPIFY' | 'BSALE';

export interface IntegrationErrorOptions {
  provider: Provider;
  status?: number;
  code?: string;
  retryable?: boolean;
  detail?: unknown;
  cause?: unknown;
}

export class IntegrationError extends Error {
  override readonly name = 'IntegrationError';
  readonly provider: Provider;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly detail: unknown;

  constructor(message: string, opts: IntegrationErrorOptions) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.provider = opts.provider;
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.retryable = opts.retryable ?? defaultRetryable(opts.status);
  }

  /** Forma segura para devolver al panel: sin stack, sin detalles crudos del proveedor. */
  toPublic(): { provider: Provider; message: string; status?: number; code?: string; retryable: boolean } {
    return {
      provider: this.provider,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.code !== undefined ? { code: this.code } : {}),
      retryable: this.retryable,
    };
  }
}

/**
 * Política por defecto:
 *  - 408 / 425 / 429 y todo 5xx  → reintentable (problema transitorio)
 *  - resto de 4xx                → NO reintentable (el request está mal, reintentar no lo arregla)
 *  - sin status (fallo de red)   → reintentable
 */
export function defaultRetryable(status?: number): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

/** Backoff exponencial con jitter completo, para no sincronizar reintentos entre workers. */
export function backoffDelayMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}
