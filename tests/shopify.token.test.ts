/**
 * Pruebas del flujo de client credentials.
 *
 * Lo que se fija aquí, y por qué importa cada cosa:
 *
 *  - El secreto viaja en el CUERPO, nunca en la URL. Las URL acaban en logs de
 *    proxies y servidores intermedios; el cuerpo no.
 *  - El token se cachea. Sin caché, cada consulta a Shopify costaría dos
 *    peticiones en vez de una.
 *  - Se renueva ANTES de caducar. Esperar al 401 hace que una petición de un
 *    comprador pague el reintento.
 *  - Varias llamadas simultáneas provocan UNA renovación, no N.
 *  - Ni el secreto ni el client_id aparecen en los mensajes de error.
 */
import { describe, expect, it, vi } from 'vitest';
import { ShopifyTokenProvider } from '../src/integrations/shopify/token.js';
import { IntegrationError } from '../src/lib/errors.js';

const SHOP = 'mundo-love-pet.myshopify.com';
const CLIENT_ID = 'b57e09114aba48b018cbdc6434df270f';
const CLIENT_SECRET = 'shpss_secretomuysecreto1234567890';

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OK = { access_token: 'shpat_generado_por_shopify', scope: 'read_products', expires_in: 86399 };

function make(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new ShopifyTokenProvider({
    shopDomain: SHOP,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl,
    ...extra,
  });
}

describe('ShopifyTokenProvider', () => {
  describe('construcción', () => {
    it('exige dominio, client id y secreto', () => {
      const base = { shopDomain: SHOP, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
      expect(() => new ShopifyTokenProvider({ ...base, shopDomain: '' })).toThrow(IntegrationError);
      expect(() => new ShopifyTokenProvider({ ...base, clientId: '' })).toThrow(IntegrationError);
      expect(() => new ShopifyTokenProvider({ ...base, clientSecret: '' })).toThrow(IntegrationError);
    });

    it('normaliza el dominio con esquema o barra final', () => {
      const p = new ShopifyTokenProvider({
        shopDomain: `https://${SHOP}/`,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });
      expect(p.endpoint).toBe(`https://${SHOP}/admin/oauth/access_token`);
    });
  });

  describe('obtención', () => {
    it('pide el token al endpoint correcto', async () => {
      const fetchMock = vi.fn(async () => tokenResponse(OK));
      const token = await make(fetchMock as unknown as typeof fetch).getToken();

      expect(token).toBe(OK.access_token);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
      expect(init.method).toBe('POST');
    });

    it('manda las credenciales en el cuerpo y NUNCA en la URL', async () => {
      const fetchMock = vi.fn(async () => tokenResponse(OK));
      await make(fetchMock as unknown as typeof fetch).getToken();

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).not.toContain(CLIENT_SECRET);
      expect(url).not.toContain(CLIENT_ID);

      const body = JSON.parse(String(init.body)) as Record<string, string>;
      expect(body).toEqual({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'client_credentials',
      });
    });

    it('reutiliza el token cacheado en vez de pedir uno nuevo', async () => {
      const fetchMock = vi.fn(async () => tokenResponse(OK));
      const p = make(fetchMock as unknown as typeof fetch);

      await p.getToken();
      await p.getToken();
      await p.getToken();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('renueva antes de que caduque, no después', async () => {
      const fetchMock = vi.fn(async () => tokenResponse({ ...OK, expires_in: 3600 }));
      let ahora = 1_000_000;
      const p = make(fetchMock as unknown as typeof fetch, {
        now: () => ahora,
        safetyWindowMs: 5 * 60 * 1000,
      });

      await p.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Faltan 6 minutos para caducar: todavía sirve.
      ahora += (3600 - 360) * 1000;
      await p.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Faltan 4 minutos: dentro del margen, se renueva aunque aún sea válido.
      ahora += 120 * 1000;
      await p.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('asume 24 h si Shopify no manda expires_in', async () => {
      const fetchMock = vi.fn(async () => tokenResponse({ access_token: 'shpat_sin_caducidad' }));
      const p = make(fetchMock as unknown as typeof fetch, { now: () => 0 });

      await p.getToken();
      expect(p.expiraEnMs).toBe(86_399 * 1000);
    });

    it('lanza UNA sola petición aunque se pidan varios tokens a la vez', async () => {
      let resolver: (r: Response) => void = () => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((res) => {
            resolver = res;
          }),
      );
      const p = make(fetchMock as unknown as typeof fetch);

      const pendientes = Promise.all([p.getToken(), p.getToken(), p.getToken()]);
      resolver(tokenResponse(OK));
      const tokens = await pendientes;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tokens).toEqual([OK.access_token, OK.access_token, OK.access_token]);
    });

    it('invalidar() fuerza una renovación', async () => {
      const fetchMock = vi.fn(async () => tokenResponse(OK));
      const p = make(fetchMock as unknown as typeof fetch);

      await p.getToken();
      p.invalidar();
      await p.getToken();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('errores', () => {
    it('401 no es reintentable y explica qué revisar', async () => {
      const fetchMock = vi.fn(async () => tokenResponse({ error: 'invalid_client' }, 401));
      await expect(make(fetchMock as unknown as typeof fetch).getToken()).rejects.toMatchObject({
        retryable: false,
        status: 401,
      });
    });

    it('429 y 5xx sí son reintentables', async () => {
      for (const status of [429, 500, 502, 503]) {
        const fetchMock = vi.fn(async () => tokenResponse({ error: 'x' }, status));
        await expect(make(fetchMock as unknown as typeof fetch).getToken()).rejects.toMatchObject({
          retryable: true,
        });
      }
    });

    it('404 avisa de que la app no está instalada en esa tienda', async () => {
      const fetchMock = vi.fn(async () => tokenResponse({}, 404));
      await expect(make(fetchMock as unknown as typeof fetch).getToken()).rejects.toThrow(
        /no est[áa] instalada/i,
      );
    });

    it('el secreto y el client_id nunca aparecen en el mensaje de error', async () => {
      // Caso peor: Shopify devuelve las credenciales dentro del cuerpo del error.
      const fetchMock = vi.fn(async () =>
        tokenResponse({ error: `bad client_secret=${CLIENT_SECRET} client_id=${CLIENT_ID}` }, 401),
      );

      await expect(make(fetchMock as unknown as typeof fetch).getToken()).rejects.toSatisfy(
        (e: unknown) => {
          const msg = (e as Error).message;
          return !msg.includes(CLIENT_SECRET) && !msg.includes(CLIENT_ID);
        },
      );
    });

    it('falla con mensaje claro si no viene access_token', async () => {
      const fetchMock = vi.fn(async () => tokenResponse({ scope: 'read_products' }));
      await expect(make(fetchMock as unknown as typeof fetch).getToken()).rejects.toThrow(
        /no devolvió ningún access_token/i,
      );
    });

    it('una respuesta que no es JSON no revienta con SyntaxError', async () => {
      const fetchMock = vi.fn(
        async () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
      );
      await expect(make(fetchMock as unknown as typeof fetch).getToken()).rejects.toThrow(
        /no es JSON/i,
      );
    });

    it('el timeout se reporta como reintentable', async () => {
      const fetchMock = vi.fn(async () => {
        const err = new Error('abortado');
        err.name = 'AbortError';
        throw err;
      });
      await expect(
        make(fetchMock as unknown as typeof fetch, { timeoutMs: 10 }).getToken(),
      ).rejects.toMatchObject({ retryable: true });
    });

    it('un fallo no deja un token medio guardado', async () => {
      const fetchMock = vi.fn(async () => tokenResponse({ error: 'x' }, 500));
      const p = make(fetchMock as unknown as typeof fetch);

      await expect(p.getToken()).rejects.toThrow();
      // La siguiente llamada vuelve a intentarlo: no se quedó nada en caché.
      await expect(p.getToken()).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
