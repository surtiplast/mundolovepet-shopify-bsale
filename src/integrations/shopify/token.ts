/**
 * Obtención del token de acceso de Shopify por «client credentials».
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────
 *
 * Hasta finales de 2025, una integración como ésta usaba una «app personalizada»
 * creada desde el admin de la tienda, que entregaba un token estático `shpat_…`
 * que no caducaba nunca. Se pegaba en una variable de entorno y listo.
 *
 * **Desde el 1 de enero de 2026 Shopify ya no permite crear esas apps.** Las
 * nuevas se crean en el Dev Dashboard y no entregan ningún token para copiar:
 * dan un Client ID y un Client Secret, y la app tiene que pedir el token ella
 * misma con el flujo de client credentials. Ese token **caduca en unas 24 horas**
 * (`expires_in: 86399`), así que hay que renovarlo.
 *
 * Las apps creadas antes de 2026 siguen funcionando con su token estático, pero
 * no se pueden crear nuevas. Por eso este proyecto usa client credentials.
 *
 * Shopify limita este flujo a integraciones servidor a servidor de tu propia
 * organización, instaladas en tiendas que tú posees — que es exactamente este
 * caso.
 *
 * Documentación:
 *   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 *
 * ── Decisiones de diseño ─────────────────────────────────────────────────────
 *
 *  - **Se renueva antes de caducar, no cuando falla.** Esperar al 401 significa
 *    que una petición de usuario paga el reintento. Con un margen de seguridad,
 *    la renovación ocurre en una petición cualquiera y nadie la nota.
 *
 *  - **Una sola petición en vuelo.** Si diez llamadas coinciden con el token
 *    caducado, todas esperan a la misma renovación en vez de lanzar diez.
 *
 *  - **El secreto nunca sale de aquí.** Ni en logs, ni en mensajes de error, ni
 *    en la URL. Los mensajes pasan por `scrubMessage` con el secreto y el token
 *    como cadenas a redactar.
 */
import { IntegrationError, defaultRetryable } from '../../lib/errors.js';
import { scrubMessage } from '../../lib/mask.js';

export interface ShopifyTokenProviderOptions {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  /**
   * Margen para renovar antes de la caducidad real. Por defecto 5 minutos:
   * suficiente para que una petición larga no se quede a medias con un token
   * que expira mientras viaja.
   */
  safetyWindowMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
}

/** Si Shopify no dice cuánto dura, asumimos lo documentado: 24 horas. */
const CADUCIDAD_POR_DEFECTO_MS = 86_399 * 1000;

export class ShopifyTokenProvider {
  private readonly shopDomain: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly safetyWindowMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private token: string | null = null;
  private expiraEn = 0;
  /** Petición de renovación en curso, para no lanzar varias a la vez. */
  private enVuelo: Promise<string> | null = null;

  constructor(opts: ShopifyTokenProviderOptions) {
    const shop = (opts.shopDomain ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!shop) {
      throw new IntegrationError('Falta el dominio de la tienda de Shopify.', {
        provider: 'SHOPIFY',
        retryable: false,
      });
    }
    if (!opts.clientId?.trim()) {
      throw new IntegrationError('Falta SHOPIFY_CLIENT_ID.', {
        provider: 'SHOPIFY',
        retryable: false,
      });
    }
    if (!opts.clientSecret?.trim()) {
      throw new IntegrationError('Falta SHOPIFY_CLIENT_SECRET.', {
        provider: 'SHOPIFY',
        retryable: false,
      });
    }

    this.shopDomain = shop;
    this.clientId = opts.clientId.trim();
    this.clientSecret = opts.clientSecret.trim();
    this.safetyWindowMs = opts.safetyWindowMs ?? 5 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  get endpoint(): string {
    return `https://${this.shopDomain}/admin/oauth/access_token`;
  }

  /** Momento de caducidad del token en caché. Sólo para diagnóstico. */
  get expiraEnMs(): number {
    return this.expiraEn;
  }

  /**
   * Devuelve un token válido. Usa el de la caché si le queda vida; si no, lo
   * renueva. Es la única forma de obtener el token: no hay getter público.
   */
  async getToken(): Promise<string> {
    if (this.token && this.now() < this.expiraEn - this.safetyWindowMs) {
      return this.token;
    }
    // Si ya hay una renovación en marcha, nos colgamos de ella.
    this.enVuelo ??= this.renovar().finally(() => {
      this.enVuelo = null;
    });
    return this.enVuelo;
  }

  /**
   * Fuerza una renovación. Útil cuando Shopify devuelve 401 pese a que el token
   * parecía vigente — puede pasar si se revocan los permisos de la app.
   */
  invalidar(): void {
    this.token = null;
    this.expiraEn = 0;
  }

  private async renovar(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // El secreto va en el CUERPO, nunca en la URL: las URL acaban en logs
        // de proxies y de servidores intermedios.
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'client_credentials',
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      const esTimeout = (cause as Error)?.name === 'AbortError';
      throw new IntegrationError(
        esTimeout
          ? `Shopify no respondió en ${this.timeoutMs} ms al pedir el token.`
          : 'No se pudo conectar con Shopify para pedir el token.',
        { provider: 'SHOPIFY', retryable: true, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const crudo = await response.text();

    if (!response.ok) {
      throw new IntegrationError(this.describirError(response.status, crudo), {
        provider: 'SHOPIFY',
        status: response.status,
        retryable: defaultRetryable(response.status),
      });
    }

    let payload: TokenResponse;
    try {
      payload = JSON.parse(crudo) as TokenResponse;
    } catch (cause) {
      throw new IntegrationError('Shopify devolvió una respuesta que no es JSON al pedir el token.', {
        provider: 'SHOPIFY',
        status: response.status,
        retryable: false,
        cause,
      });
    }

    const token = payload.access_token?.trim();
    if (!token) {
      throw new IntegrationError('Shopify no devolvió ningún access_token.', {
        provider: 'SHOPIFY',
        status: response.status,
        retryable: false,
      });
    }

    // `expires_in` viene en segundos. Si falta, asumimos lo documentado.
    const duracionMs =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? payload.expires_in * 1000
        : CADUCIDAD_POR_DEFECTO_MS;

    this.token = token;
    this.expiraEn = this.now() + duracionMs;
    return token;
  }

  /**
   * Mensajes que dicen qué hacer, no sólo qué pasó.
   *
   * El cuerpo de la respuesta se limpia antes de incluirlo: si Shopify
   * devolviera el client_id o el secreto dentro del texto, no queremos que
   * acabe en un log.
   */
  private describirError(status: number, cuerpo: string): string {
    const limpio = scrubMessage(cuerpo, [this.clientSecret, this.clientId]).slice(0, 200);

    if (status === 401 || status === 403) {
      return (
        'Shopify rechazó las credenciales de la app (client_id o client_secret). ' +
        'Comprueba que sean los del Dev Dashboard y que la app esté instalada en esta tienda. ' +
        limpio
      );
    }
    if (status === 404) {
      return (
        `La tienda ${this.shopDomain} no existe o la app no está instalada en ella. ` +
        'El dominio debe tener el formato tienda.myshopify.com.'
      );
    }
    if (status === 429) {
      return 'Shopify limitó las peticiones de token. Se reintentará.';
    }
    return `Shopify respondió ${status} al pedir el token. ${limpio}`;
  }
}
