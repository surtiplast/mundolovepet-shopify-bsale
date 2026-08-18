/**
 * Cliente de la Admin GraphQL API de Shopify.
 *
 * Documentación oficial:
 *   https://shopify.dev/docs/api/admin-graphql/2026-07
 *   https://shopify.dev/docs/api/usage/rate-limits
 *
 * Notas de diseño:
 *  - Se usa GraphQL, no REST: Shopify dirige todo desarrollo nuevo a GraphQL.
 *  - El control de caudal se hace leyendo `extensions.cost.throttleStatus` de la
 *    respuesta real, en lugar de asumir una cuota fija. El tamaño del bucket
 *    depende del plan de la tienda, así que asumirlo sería adivinar.
 *  - Shopify devuelve HTTP 200 con un array `errors` en varios fallos de
 *    GraphQL. Ignorar eso es el error clásico de integración: hay que inspeccionar
 *    el cuerpo, no sólo el código de estado.
 */
import { IntegrationError, backoffDelayMs } from '../../lib/errors.js';
import { scrubMessage } from '../../lib/mask.js';

/**
 * El token puede ser una cadena fija o un proveedor que lo obtiene y renueva.
 *
 * Desde enero de 2026 las apps nuevas de Shopify no entregan un token estático:
 * hay que pedirlo con client credentials y caduca cada ~24 h. Ver
 * `token.ts`. Se admite la cadena para las apps antiguas que aún la tengan y
 * para que las pruebas no necesiten simular el flujo completo.
 */
export type AccessTokenSource = string | (() => Promise<string>);

export interface ShopifyClientOptions {
  shopDomain: string;
  accessToken: AccessTokenSource;
  apiVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: ThrottleStatus;
    };
  };
}

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  currencyCode: string;
  ianaTimezone: string;
  plan: { displayName: string };
}

export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
  address: { city: string | null; country: string | null } | null;
}

/**
 * Variante de Shopify, con los campos que necesita la sincronización.
 *
 * `sku` y `barcode` son campos DISTINTOS y ambos importan: en catálogos que
 * vienen de un ERP peruano es frecuente que el código EAN esté en `barcode` y
 * el `sku` esté vacío, o al revés. Emparejar por el campo equivocado no da
 * error: simplemente no encuentra nada.
 */
export interface ShopifyVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  inventoryItemId: string | null;
  productId: string | null;
  productTitle: string | null;
  title: string | null;
}

export const DEFAULT_API_VERSION = '2026-07';

const SHOP_QUERY = /* GraphQL */ `
  query ConnectionTest {
    shop {
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
      plan {
        displayName
      }
    }
  }
`;

const LOCATIONS_QUERY = /* GraphQL */ `
  query Locations($first: Int!) {
    locations(first: $first) {
      nodes {
        id
        name
        isActive
        address {
          city
          country
        }
      }
    }
  }
`;

const VARIANTS_QUERY = /* GraphQL */ `
  query Variantes($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sku
        barcode
        price
        inventoryQuantity
        inventoryItem {
          id
        }
        title
        product {
          id
          title
        }
      }
    }
  }
`;

export class ShopifyClient {
  private readonly shopDomain: string;
  private readonly accessToken: AccessTokenSource;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private lastThrottle: ThrottleStatus | null = null;

  constructor(opts: ShopifyClientOptions) {
    if (!opts.shopDomain) {
      throw new IntegrationError('Falta el dominio de la tienda Shopify.', {
        provider: 'SHOPIFY',
        retryable: false,
      });
    }
    if (!opts.accessToken) {
      throw new IntegrationError('Falta el Admin API access token de Shopify.', {
        provider: 'SHOPIFY',
        retryable: false,
      });
    }
    this.shopDomain = opts.shopDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get endpoint(): string {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  /**
   * Resuelve el token justo antes de cada petición.
   *
   * Con un proveedor de client credentials esto importa: el token caduca cada
   * ~24 h y el proveedor decide si devuelve el de la caché o pide uno nuevo. Si
   * se resolviera una sola vez en el constructor, el cliente se quedaría con un
   * token muerto y empezaría a recibir 401 al día siguiente.
   */
  private async resolverToken(): Promise<string> {
    return typeof this.accessToken === 'function' ? this.accessToken() : this.accessToken;
  }

  /** Última lectura del bucket de coste. Útil para mostrarlo en el panel. */
  get throttleStatus(): ThrottleStatus | null {
    return this.lastThrottle;
  }

  // ── API pública ────────────────────────────────────────────────────────────

  /**
   * Prueba de conexión: consulta el objeto `shop`.
   * Coste mínimo, sólo lectura, y devuelve moneda y zona horaria — datos que la
   * app necesita después para formatear montos y fechas de emisión.
   */
  async testConnection(): Promise<{ ok: true; shop: ShopInfo; apiVersion: string }> {
    const data = await this.query<{ shop: ShopInfo }>(SHOP_QUERY);
    return { ok: true, shop: data.shop, apiVersion: this.apiVersion };
  }

  async listLocations(first = 20): Promise<ShopifyLocation[]> {
    const data = await this.query<{ locations: { nodes: ShopifyLocation[] } }>(LOCATIONS_QUERY, {
      first,
    });
    return data.locations.nodes;
  }

  /**
   * Recorre todas las variantes de la tienda.
   *
   * GraphQL pagina por cursor, no por offset: se pide `first` y se sigue con el
   * `endCursor` de la página anterior mientras `hasNextPage` sea cierto. Usar
   * offset aquí no es una opción — la API no lo ofrece.
   *
   * `first` es 100 porque es el máximo que admite Shopify por página. Si el
   * coste de la consulta hiciera saltar el throttling, el propio cliente espera
   * lo que el bucket indica y reintenta.
   */
  async *listarVariantes(maxItems = 100_000): AsyncGenerator<ShopifyVariant, void, undefined> {
    let after: string | null = null;
    let vistos = 0;

    for (;;) {
      const data: {
        productVariants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            sku: string | null;
            barcode: string | null;
            price: string | null;
            inventoryQuantity: number | null;
            inventoryItem: { id: string } | null;
            title: string | null;
            product: { id: string; title: string } | null;
          }>;
        };
      } = await this.query(VARIANTS_QUERY, { first: 100, after });

      for (const n of data.productVariants.nodes) {
        yield {
          id: n.id,
          sku: n.sku,
          barcode: n.barcode,
          price: n.price,
          inventoryQuantity: n.inventoryQuantity,
          inventoryItemId: n.inventoryItem?.id ?? null,
          productId: n.product?.id ?? null,
          productTitle: n.product?.title ?? null,
          title: n.title,
        };
        vistos++;
        if (vistos >= maxItems) return;
      }

      if (!data.productVariants.pageInfo.hasNextPage) return;
      after = data.productVariants.pageInfo.endCursor;
      // Sin cursor no se puede continuar; salir es mejor que repetir la página.
      if (!after) return;
    }
  }

  // ── Transporte ─────────────────────────────────────────────────────────────

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: IntegrationError | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.queryOnce<T>(query, variables);
      } catch (error) {
        const err = error as IntegrationError;
        lastError = err;
        if (!err.retryable || attempt === this.maxRetries) throw err;
        await this.sleep(this.retryDelayMs(attempt, err));
      }
    }
    throw lastError ?? new IntegrationError('Fallo desconocido en Shopify.', { provider: 'SHOPIFY' });
  }

  /**
   * Si el fallo fue por throttling, esperamos lo que el propio bucket nos dice
   * que tardará en recuperarse, en vez de un backoff a ciegas.
   */
  private retryDelayMs(attempt: number, err: IntegrationError): number {
    if (err.code === 'THROTTLED' && this.lastThrottle) {
      const { maximumAvailable, currentlyAvailable, restoreRate } = this.lastThrottle;
      if (restoreRate > 0) {
        const deficit = Math.max(0, maximumAvailable / 2 - currentlyAvailable);
        return Math.min(10_000, Math.ceil((deficit / restoreRate) * 1000) + 250);
      }
    }
    return backoffDelayMs(attempt);
  }

  private async queryOnce<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Se resuelve una sola vez por petición: se usa para la cabecera y también
    // para redactarlo si hay que construir un mensaje de error.
    const token = await this.resolverToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (cause) {
      const isAbort = (cause as Error)?.name === 'AbortError';
      throw new IntegrationError(
        isAbort ? `Shopify no respondió en ${this.timeoutMs} ms.` : 'No se pudo conectar con Shopify.',
        { provider: 'SHOPIFY', retryable: true, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();

    if (!response.ok) {
      throw new IntegrationError(this.describeHttpError(response.status), {
        provider: 'SHOPIFY',
        status: response.status,
        ...(response.status === 429 ? { code: 'THROTTLED' } : {}),
      });
    }

    let payload: GraphQLResponse<T>;
    try {
      payload = JSON.parse(raw) as GraphQLResponse<T>;
    } catch (cause) {
      throw new IntegrationError('Shopify devolvió una respuesta que no es JSON válido.', {
        provider: 'SHOPIFY',
        status: response.status,
        retryable: false,
        cause,
      });
    }

    if (payload.extensions?.cost?.throttleStatus) {
      this.lastThrottle = payload.extensions.cost.throttleStatus;
    }

    // Shopify puede responder 200 con errores de GraphQL en el cuerpo.
    if (payload.errors?.length) {
      const code = payload.errors[0]?.extensions?.code;
      const message = payload.errors.map((e) => e.message).join(' | ');
      throw new IntegrationError(
        scrubMessage(`Shopify devolvió errores de GraphQL: ${message}`, [token]),
        {
          provider: 'SHOPIFY',
          status: response.status,
          ...(code ? { code } : {}),
          // THROTTLED es transitorio; el resto de errores GraphQL son del query.
          retryable: code === 'THROTTLED',
          detail: payload.errors,
        },
      );
    }

    if (!payload.data) {
      throw new IntegrationError('Shopify respondió sin datos ni errores.', {
        provider: 'SHOPIFY',
        status: response.status,
        retryable: false,
      });
    }

    return payload.data;
  }

  private describeHttpError(status: number): string {
    switch (status) {
      case 401:
        return 'Shopify rechazó el token (401). Verifica el Admin API access token de la Custom App.';
      case 402:
        return 'La tienda Shopify está en pausa o con pago pendiente (402).';
      case 403:
        return 'Token válido pero sin permisos suficientes (403). Revisa los scopes de la Custom App.';
      case 404:
        return 'Endpoint no encontrado (404). Verifica el dominio de la tienda y la versión de API.';
      case 423:
        return 'La tienda está bloqueada (423).';
      case 429:
        return 'Shopify está limitando las peticiones (429). Se reintentará respetando el bucket de coste.';
      default:
        return status >= 500
          ? `Error interno de Shopify (${status}). Se reintentará.`
          : `Shopify respondió con estado ${status}.`;
    }
  }
}
