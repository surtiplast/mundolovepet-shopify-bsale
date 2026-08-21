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
import { logger } from '../../lib/logger.js';

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

/**
 * Variante de producto. GET /v1/variants.json
 *
 * La variante es la unidad real del catálogo: lo que tiene SKU, precio y stock.
 * El «producto» de Bsale es la agrupación (por ejemplo «Collar»), y sus
 * variantes son las que se venden («Collar rojo talla M»).
 *
 * Un producto sin variantes explícitas tiene igualmente una variante por
 * defecto, así que recorrer variantes cubre el catálogo entero.
 */
export interface BsaleVariant {
  href: string;
  id: number;
  description?: string | null;
  /** El SKU. Es la clave que une Bsale con Shopify. Puede venir vacío. */
  code?: string | null;
  barCode?: string | null;
  state?: number;
  /**
   * El producto al que pertenece. Llega gracias a `expand=[product]`.
   *
   * Su `name` importa mucho: en Bsale el nombre comercial suele estar aquí y no
   * en la variante. «EQUILIBRIO GRAIN FREE PUPPIES SMALL BREEDS 1.5» es el
   * nombre del producto; la variante puede no tener descripción ninguna.
   */
  product?: {
    href?: string;
    id?: number;
    name?: string | null;
    /**
     * La marca. **No está documentada.**
     *
     * La interfaz de Bsale muestra una marca por producto, pero la referencia
     * de `/v1/products.json` no la incluye entre sus campos. Se leen aquí las
     * tres formas en que podría venir, por si la API devuelve más de lo que
     * documenta —cosa habitual—:
     *
     *   · `brand` como texto suelto
     *   · `brand.name` si viene expandida
     *   · `brandName`, que es como la nombra la respuesta de crear packs
     *
     * Si no llega ninguna, el producto se crea sin marca y ya está. El panel
     * enseña cuántas se han leído, así que con una lectura del catálogo se ve
     * si esto sirve o si hay que buscar la marca por otro camino.
     */
    brand?: string | { name?: string | null } | null;
    brandName?: string | null;
  } | null;
}

/**
 * Costo de una variante. GET /v1/variants/{id}/costs.json
 *
 * `averageCost` es el costo promedio ponderado de todas las recepciones. Bsale
 * lo devuelve como cadena («"4140.0"»), no como número.
 *
 * `history` trae el costo de cada recepción. No se usa: para el campo «Costo por
 * artículo» de Shopify el promedio es lo correcto, y el histórico sólo pesaría
 * la respuesta.
 */
export interface BsaleCosts {
  averageCost?: string | number | null;
  history?: Array<{ cost?: number; admissionDate?: number; availableFifo?: number }>;
}

/** Cliente de Bsale. GET/POST /v1/clients.json */
export interface BsaleClienteRegistro {
  href?: string;
  id: number;
  /** El DNI o el RUC. Bsale lo llama `code` por herencia del RUT chileno. */
  code?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  email?: string | null;
  /** 0 persona natural, 1 empresa. */
  companyOrPerson?: number | null;
  state?: number;
}

/** Lo que hace falta para dar de alta un cliente. */
export interface NuevoCliente {
  /** DNI (8) o RUC (11). */
  code: string;
  /** Razón social. Obligatoria para factura. */
  company?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  municipality?: string | null;
  /** 0 persona, 1 empresa. */
  companyOrPerson: 0 | 1;
  activity?: string | null;
}

/** Una línea del comprobante. */
export interface DetalleDocumento {
  /** El SKU. Bsale acepta `code` en vez de `variantId`, y así no hay que resolverlo. */
  code?: string;
  variantId?: number;
  /** Valor unitario SIN impuesto. Bsale rechaza los negativos. */
  netUnitValue: number;
  quantity: number;
  /** Los ids de impuesto entre corchetes, como cadena: "[1]". Así lo pide Bsale. */
  taxId: string;
  comment?: string;
  /** PORCENTAJE de descuento, no importe. */
  discount?: number;
}

/** Lo que se manda para emitir. */
export interface NuevoDocumento {
  documentTypeId: number;
  officeId: number;
  priceListId?: number;
  /** Segundos desde epoch. Sin zona horaria: sólo cuenta la fecha. */
  emissionDate: number;
  expirationDate: number;
  /** 1 para declarar ante SUNAT. */
  declare: 0 | 1;
  clientId?: number;
  client?: Record<string, unknown>;
  details: DetalleDocumento[];
  references?: Array<{ number: string; referenceDate: number; reason: string; code: string }>;
  /**
   * La clave anti-duplicado.
   *
   * Si Bsale ya tiene un documento con este `salesId` para este tipo de
   * documento, **devuelve el existente en vez de crear otro**. Es la última
   * defensa: aunque falle todo lo demás, no se emiten dos comprobantes por el
   * mismo pedido.
   */
  salesId?: string;
  /** 1 descuenta stock en Bsale. */
  dispatch?: 0 | 1;
  sendEmail?: 0 | 1;
}

/** El comprobante emitido. */
export interface DocumentoEmitido {
  id: number;
  number: number;
  /** Serie y número, p. ej. «B001-1234». */
  serialNumber?: string | null;
  emissionDate: number;
  totalAmount: number;
  netAmount?: number;
  taxAmount?: number;
  token: string;
  urlPdf?: string | null;
  urlPublicView?: string | null;
  urlXml?: string | null;
  /** 0 correcto, 1 enviado, 2 rechazado por SUNAT. */
  informed?: number | null;
  responseMsg?: string | null;
  salesId?: string | null;
  document_type?: { id?: string | number } | null;
  client?: { id?: string | number } | null;
}

/** Precio de una variante en una lista. GET /v1/price_lists/{id}/details.json */
export interface BsalePriceDetail {
  href: string;
  id: number;
  variant?: { href?: string; id?: number } | null;
  variantValue?: number;
  variantValueWithTaxes?: number;
}

/** Stock por variante y sucursal. GET /v1/stocks.json */
export interface BsaleStock {
  href: string;
  id: number;
  quantity?: number;
  quantityReserved?: number;
  quantityAvailable?: number;
  variant?: { href?: string; id?: number } | null;
  office?: { href?: string; id?: number } | null;
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

  // ── Catálogo (Fase 2) ──────────────────────────────────────────────────────

  /**
   * Recorre TODAS las páginas de un recurso paginado.
   *
   * Bsale devuelve como mucho 50 elementos por página. Quedarse con la primera
   * es el error clásico: en pruebas parece que funciona —porque el catálogo de
   * prueba cabe en una página— y en producción sincroniza sólo los 50 primeros
   * productos sin dar ningún error.
   *
   * Se avanza por `offset` y no por el campo `next` porque `next` es una URL
   * absoluta que ya trae el token en algunos despliegues, y no queremos que un
   * token acabe en una URL que pueda registrarse.
   *
   * `maxItems` es un tope de seguridad: sin él, un `count` erróneo del servidor
   * dejaría el bucle girando indefinidamente.
   */
  async *paginar<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    maxItems = 100_000,
  ): AsyncGenerator<T, void, undefined> {
    let offset = 0;
    let vistos = 0;

    for (;;) {
      const page = await this.get<BsalePage<T>>(path, {
        ...query,
        limit: BSALE_MAX_LIMIT,
        offset,
      });

      const items = page.items ?? [];
      for (const item of items) {
        yield item;
        vistos++;
        if (vistos >= maxItems) return;
      }

      // Última página: llegó menos de lo pedido, o ya cubrimos el total.
      if (items.length < BSALE_MAX_LIMIT) return;
      if (typeof page.count === 'number' && vistos >= page.count) return;

      offset += BSALE_MAX_LIMIT;
    }
  }

  /** Todas las variantes activas del catálogo. Es la unidad con SKU. */
  listarVariantes(maxItems?: number): AsyncGenerator<BsaleVariant, void, undefined> {
    // expand=[product] evita una petición extra por variante para conocer su
    // producto: con miles de variantes, esa diferencia es de minutos.
    return this.paginar<BsaleVariant>('/variants.json', { expand: '[product]' }, maxItems);
  }

  /** Precios de una lista concreta. Bsale no expone «el precio» sin lista. */
  listarPrecios(
    priceListId: number,
    maxItems?: number,
  ): AsyncGenerator<BsalePriceDetail, void, undefined> {
    return this.paginar<BsalePriceDetail>(`/price_lists/${priceListId}/details.json`, {}, maxItems);
  }

  /**
   * Stock de una sucursal.
   *
   * Se filtra por sucursal a propósito: sin `officeid`, Bsale devuelve una fila
   * por variante Y sucursal, y con varias sucursales el número de páginas se
   * multiplica sin que ninguna de las extra sirva para nada.
   */
  listarStock(officeId: number, maxItems?: number): AsyncGenerator<BsaleStock, void, undefined> {
    return this.paginar<BsaleStock>('/stocks.json', { officeid: officeId }, maxItems);
  }

  /**
   * Costo promedio de UNA variante.
   *
   * ── Por qué esto no se puede pedir en bloque ──────────────────────────────
   *
   * Bsale no expone un listado de costos: hay que preguntar variante por
   * variante. Con 3.238 variantes serían 3.238 peticiones en serie —más de
   * media hora—, así que **no se llama al leer el catálogo**. Sólo se pide para
   * los productos que se van a crear o reparar, que son unos cientos.
   *
   * Devuelve `null`, sin lanzar, cuando la variante no tiene costo registrado:
   * un producto que nunca ha entrado por una recepción no lo tiene, y eso es
   * normal, no un fallo. Que falte el costo no debe impedir crear el producto.
   */
  async obtenerCosto(variantId: number): Promise<number | null> {
    try {
      const datos = await this.get<BsaleCosts>(`/variants/${variantId}/costs.json`);
      const bruto = datos?.averageCost;
      if (bruto === null || bruto === undefined || bruto === '') return null;

      // Bsale lo manda como cadena. Number('') es 0, de ahí el descarte previo.
      const valor = typeof bruto === 'number' ? bruto : Number(bruto);
      if (!Number.isFinite(valor) || valor <= 0) return null;
      return valor;
    } catch (error) {
      // Un 404 aquí significa «sin costo», no «algo va mal».
      logger.debug({ variantId, err: (error as Error).message }, 'Sin costo en Bsale');
      return null;
    }
  }

  // ── Clientes y comprobantes ────────────────────────────────────────────────

  /**
   * Busca un cliente por su DNI o RUC.
   *
   * Se busca ANTES de crear, siempre. Bsale no impide dar de alta dos clientes
   * con el mismo documento, y una base llena de duplicados hace inservibles los
   * informes de ventas por cliente.
   */
  async buscarCliente(code: string): Promise<BsaleClienteRegistro | null> {
    const limpio = code.replace(/\D/g, '');
    if (!limpio) return null;

    const datos = await this.get<BsalePage<BsaleClienteRegistro>>('/clients.json', {
      code: limpio,
      limit: 5,
    });

    // Se compara otra vez el código: el filtro de Bsale es laxo en algunos
    // recursos y devolver el cliente equivocado sería facturar a otra persona.
    return (datos.items ?? []).find((c) => (c.code ?? '').replace(/\D/g, '') === limpio) ?? null;
  }

  /** Da de alta un cliente. Usar sólo después de que `buscarCliente` diga que no existe. */
  async crearCliente(cliente: NuevoCliente): Promise<BsaleClienteRegistro> {
    return this.post<BsaleClienteRegistro>('/clients.json', {
      ...cliente,
      code: cliente.code.replace(/\D/g, ''),
    });
  }

  /**
   * Emite un comprobante. **Esto declara ante SUNAT y no se deshace.**
   *
   * ── Por qué esta llamada no se reintenta ─────────────────────────────────
   *
   * `requestWithRetry` reintenta los fallos de red. Aquí eso sería peligroso:
   * un tiempo de espera agotado no significa que el documento no se haya
   * emitido —puede haberse creado y haberse perdido la respuesta—, y reintentar
   * a ciegas emitiría el segundo.
   *
   * La protección real es `salesId`: si se manda, Bsale devuelve el documento
   * que ya existe en vez de crear otro. Por eso el servicio lo pone siempre, y
   * por eso aquí sí se puede reintentar sin miedo **mientras `salesId` venga
   * informado**. Si falta, se rechaza antes de llamar.
   */
  async emitirDocumento(documento: NuevoDocumento): Promise<DocumentoEmitido> {
    if (!documento.salesId) {
      throw new IntegrationError(
        'No se puede emitir sin salesId: es lo que impide que un reintento genere un segundo comprobante.',
        { provider: 'BSALE', retryable: false },
      );
    }
    if (documento.details.length === 0) {
      throw new IntegrationError('No se puede emitir un comprobante sin líneas.', {
        provider: 'BSALE',
        retryable: false,
      });
    }
    for (const d of documento.details) {
      if (d.netUnitValue < 0) {
        throw new IntegrationError(
          'Bsale y SUNAT rechazan un valor unitario negativo. Revisa los descuentos del pedido.',
          { provider: 'BSALE', retryable: false },
        );
      }
    }

    return this.post<DocumentoEmitido>('/documents.json', documento);
  }

  // ── Transporte ─────────────────────────────────────────────────────────────

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.enqueue(() => this.requestWithRetry<T>('GET', url.toString()));
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(this.baseUrl + path);
    return this.enqueue(() => this.requestWithRetry<T>('POST', url.toString(), body));
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
