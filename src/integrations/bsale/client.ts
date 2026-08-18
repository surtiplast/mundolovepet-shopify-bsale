/**
 * Cliente de la API Bsale v1 (Perú).
 *
 * Documentación oficial:
 *   https://docs.bsale.dev/get-started      (autenticación por header `access_token`)
 *   https://docs.bsale.dev/PE/first-steps
 *
 * Notas de diseño:
 *  - Bsale NO publica sus límites de tasa. Se adopta una política conservadora
 *    propia (concurrencia 1 por defecto + backoff) en vez de asumir una cuota.
 *  - El límite de paginación documentado es 50 ítems por respuesta.
 *  - `fetchImpl` es inyectable para poder testear sin red.
 */
import { IntegrationError, backoffDelayMs } from '../../lib/errors.js';
import { scrubMessage } from '../../lib/mask.js';

export const BSALE_MAX_LIMIT = 50;

export interface BsaleClientOptions {
  accessToken: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Envoltura paginada estándar de Bsale. */
export interface BsalePage<T> {
  href: string;
  count: number;
  limit: number;
  offset: number;
  items: T[];
  next?: string;
}

/** Sucursal. GET /v1/offices.json */
export interface BsaleOffice {
  href: string;
  id: number;
  name: string;
  description?: string | null;
  address?: string | null;
  municipality?: string | null;
  city?: string | null;
  country?: string | null;
  state?: number;
  isVirtual?: number;
}

/** Tipo de documento. GET /v1/document_types.json */
export interface BsaleDocumentType {
  href: string;
  id: number;
  name: string;
  codeSii?: string | null;
  isElectronicService?: number;
  isSalesNote?: number;
  isExempt?: number;
  state?: number;
}

/** Impuesto. GET /v1/taxes.json */
export interface BsaleTax {
  href: string;
  id: number;
  name: string;
  percentage?: number;
  code?: string | null;
  state?: number;
}

/** Lista de precios. GET /v1/price_lists.json */
export interface BsalePriceList {
  href: string;
  id: number;
  name: string;
  description?: string | null;
  state?: number;
}

const DEFAULT_BASE_URL = 'https://api.bsale.io/v1';

export class BsaleClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Cola de un solo carril: nunca más de una petición en vuelo hacia Bsale. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: BsaleClientOptions) {
    if (!opts.accessToken) {
      throw new IntegrationError('Falta el access_token de Bsale.', {
        provider: 'BSALE',
        retryable: false,
      });
    }
    this.accessToken = opts.accessToken;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── API pública ────────────────────────────────────────────────────────────

  /**
   * Prueba de conexión.
   *
   * Se usa GET /v1/offices.json y no un endpoint arbitrario porque:
   *  1. Es de sólo lectura — no puede alterar nada en la cuenta.
   *  2. Devuelve exactamente el dato que la Fase 2 necesita (la sucursal).
   * Así "probar conexión" y "descubrir configuración" son la misma llamada.
   */
  async testConnection(): Promise<{ ok: true; officeCount: number; offices: BsaleOffice[] }> {
    const page = await this.get<BsalePage<BsaleOffice>>('/offices.json', { limit: BSALE_MAX_LIMIT });
    return { ok: true, officeCount: page.count, offices: page.items };
  }

  listOffices(): Promise<BsalePage<BsaleOffice>> {
    return this.get<BsalePage<BsaleOffice>>('/offices.json', { limit: BSALE_MAX_LIMIT });
  }

  /**
   * Tipos de documento de ESTA cuenta.
   * Los IDs de "Boleta Electrónica" y "Factura Electrónica" varían entre cuentas
   * de Bsale — por eso se descubren, nunca se codifican a mano.
   */
  listDocumentTypes(): Promise<BsalePage<BsaleDocumentType>> {
    return this.get<BsalePage<BsaleDocumentType>>('/document_types.json', { limit: BSALE_MAX_LIMIT });
  }

  /** Impuestos de esta cuenta. Necesario para obtener el taxId real del IGV. */
  listTaxes(): Promise<BsalePage<BsaleTax>> {
    return this.get<BsalePage<BsaleTax>>('/taxes.json', { limit: BSALE_MAX_LIMIT });
  }

  listPriceLists(): Promise<BsalePage<BsalePriceList>> {
    return this.get<BsalePage<BsalePriceList>>('/price_lists.json', { limit: BSALE_MAX_LIMIT });
  }

  // ── Transporte ─────────────────────────────────────────────────────────────

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.enqueue(() => this.requestWithRetry<T>('GET', url.toString()));
  }

  /** Serializa las peticiones. Bsale no documenta su cuota; no la presionamos. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    // La cadena continúa incluso si esta tarea falla, para no bloquear el cliente.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async requestWithRetry<T>(method: string, url: string, body?: unknown): Promise<T> {
    let lastError: IntegrationError | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.requestOnce<T>(method, url, body);
      } catch (error) {
        const err = error as IntegrationError;
        lastError = err;
        if (!err.retryable || attempt === this.maxRetries) throw err;
        await this.sleep(backoffDelayMs(attempt));
      }
    }
    throw lastError ?? new IntegrationError('Fallo desconocido en Bsale.', { provider: 'BSALE' });
  }

  private async requestOnce<T>(method: string, url: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          // Autenticación oficial de Bsale: header `access_token`.
          access_token: this.accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      const isAbort = (cause as Error)?.name === 'AbortError';
      throw new IntegrationError(
        isAbort ? `Bsale no respondió en ${this.timeoutMs} ms.` : 'No se pudo conectar con Bsale.',
        { provider: 'BSALE', retryable: true, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();

    if (!response.ok) {
      throw new IntegrationError(this.describeHttpError(response.status, raw), {
        provider: 'BSALE',
        status: response.status,
        detail: safeParse(raw),
      });
    }

    try {
      return JSON.parse(raw) as T;
    } catch (cause) {
      throw new IntegrationError('Bsale devolvió una respuesta que no es JSON válido.', {
        provider: 'BSALE',
        status: response.status,
        retryable: false,
        cause,
      });
    }
  }

  /** Traduce códigos HTTP a mensajes accionables en español, sin filtrar el token. */
  private describeHttpError(status: number, raw: string): string {
    const base = (() => {
      switch (status) {
        case 401:
        case 403:
          return 'Bsale rechazó la credencial (401/403). Verifica que el access_token sea correcto y esté vigente.';
        case 404:
          return 'El recurso solicitado no existe en Bsale (404). Verifica la ruta del endpoint.';
        case 429:
          return 'Bsale está limitando las peticiones (429). Se reintentará con espera.';
        default:
          return status >= 500
            ? `Error interno de Bsale (${status}). Se reintentará.`
            : `Bsale respondió con estado ${status}.`;
      }
    })();

    const detail = extractBsaleMessage(raw);
    const message = detail ? `${base} Detalle: ${detail}` : base;
    return scrubMessage(message, [this.accessToken]);
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 500);
  }
}

/** Bsale devuelve el detalle del error en `error` o en `message`, según el caso. */
function extractBsaleMessage(raw: string): string | null {
  const parsed = safeParse(raw);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['error', 'message', 'msg', 'description']) {
      const value = obj[key];
      if (typeof value === 'string' && value.length > 0) return value.slice(0, 300);
    }
  }
  return null;
}
