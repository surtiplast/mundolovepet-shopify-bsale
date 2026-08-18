import { describe, expect, it, vi } from 'vitest';
import { ShopifyClient, DEFAULT_API_VERSION } from '../src/integrations/shopify/client.js';
import { IntegrationError } from '../src/lib/errors.js';

const TOKEN = 'shpat_0123456789abcdef0123456789abcdef';
const SHOP = 'mundolovepet.myshopify.com';

function gqlResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const shopPayload = {
  data: {
    shop: {
      name: 'Mundo Love Pet',
      myshopifyDomain: SHOP,
      currencyCode: 'PEN',
      ianaTimezone: 'America/Lima',
      plan: { displayName: 'Basic' },
    },
  },
  extensions: {
    cost: {
      requestedQueryCost: 3,
      actualQueryCost: 3,
      throttleStatus: { maximumAvailable: 100, currentlyAvailable: 97, restoreRate: 50 },
    },
  },
};

function makeClient(fetchImpl: typeof fetch, maxRetries = 3) {
  return new ShopifyClient({
    shopDomain: SHOP,
    accessToken: TOKEN,
    fetchImpl,
    maxRetries,
    sleep: async () => {},
  });
}

describe('ShopifyClient · endpoint y autenticación', () => {
  it('construye la URL de GraphQL con la versión de API', () => {
    const client = makeClient(vi.fn() as unknown as typeof fetch);
    expect(client.endpoint).toBe(
      `https://${SHOP}/admin/api/${DEFAULT_API_VERSION}/graphql.json`,
    );
  });

  it('usa 2026-07 como versión por defecto', () => {
    expect(DEFAULT_API_VERSION).toBe('2026-07');
  });

  it('envía el token en X-Shopify-Access-Token y usa POST', async () => {
    const fetchMock = vi.fn(async () => gqlResponse(shopPayload));
    await makeClient(fetchMock as unknown as typeof fetch).testConnection();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(TOKEN);
  });

  it('nunca pone el token en la URL', async () => {
    const fetchMock = vi.fn(async () => gqlResponse(shopPayload));
    await makeClient(fetchMock as unknown as typeof fetch).testConnection();
    expect(fetchMock.mock.calls[0]![0] as string).not.toContain(TOKEN);
  });

  it('normaliza un dominio con esquema o barra final', () => {
    const c = new ShopifyClient({ shopDomain: `https://${SHOP}/`, accessToken: TOKEN });
    expect(c.endpoint).toContain(`https://${SHOP}/admin`);
  });

  it('rechaza construirse sin token o sin dominio', () => {
    expect(() => new ShopifyClient({ shopDomain: SHOP, accessToken: '' })).toThrow(IntegrationError);
    expect(() => new ShopifyClient({ shopDomain: '', accessToken: TOKEN })).toThrow(IntegrationError);
  });
});

describe('ShopifyClient · testConnection', () => {
  it('devuelve los datos de la tienda', async () => {
    const fetchMock = vi.fn(async () => gqlResponse(shopPayload));
    const result = await makeClient(fetchMock as unknown as typeof fetch).testConnection();

    expect(result.ok).toBe(true);
    expect(result.shop.name).toBe('Mundo Love Pet');
    expect(result.shop.currencyCode).toBe('PEN');
    expect(result.apiVersion).toBe(DEFAULT_API_VERSION);
  });

  it('registra el estado del bucket de coste para autorregularse', async () => {
    const fetchMock = vi.fn(async () => gqlResponse(shopPayload));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await client.testConnection();

    expect(client.throttleStatus).toEqual({
      maximumAvailable: 100,
      currentlyAvailable: 97,
      restoreRate: 50,
    });
  });
});

describe('ShopifyClient · errores', () => {
  it('detecta errores de GraphQL devueltos con HTTP 200', async () => {
    const fetchMock = vi.fn(async () =>
      gqlResponse({ errors: [{ message: 'Field does not exist' }] }, 200),
    );
    await expect(
      makeClient(fetchMock as unknown as typeof fetch).testConnection(),
    ).rejects.toMatchObject({ provider: 'SHOPIFY', retryable: false });
  });

  it('trata THROTTLED como reintentable aunque llegue con HTTP 200', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return n === 1
        ? gqlResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] })
        : gqlResponse(shopPayload);
    });
    const result = await makeClient(fetchMock as unknown as typeof fetch).testConnection();
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marca el 401 como NO reintentable y con mensaje accionable', async () => {
    const fetchMock = vi.fn(async () => gqlResponse({}, 401));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.testConnection()).rejects.toMatchObject({ status: 401, retryable: false });
    await expect(client.testConnection()).rejects.toThrow(/Custom App/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // una por cada testConnection, sin reintentos
  });

  it('explica el 403 como problema de scopes', async () => {
    const fetchMock = vi.fn(async () => gqlResponse({}, 403));
    await expect(
      makeClient(fetchMock as unknown as typeof fetch).testConnection(),
    ).rejects.toThrow(/scopes/i);
  });

  it('reintenta ante 500', async () => {
    const fetchMock = vi.fn(async () => gqlResponse({}, 500));
    await expect(
      makeClient(fetchMock as unknown as typeof fetch, 3).testConnection(),
    ).rejects.toMatchObject({ retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('nunca filtra el token en el mensaje de error', async () => {
    const fetchMock = vi.fn(async () =>
      gqlResponse({ errors: [{ message: `token ${TOKEN} rechazado` }] }),
    );
    await expect(
      makeClient(fetchMock as unknown as typeof fetch).testConnection(),
    ).rejects.toSatisfy((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).toContain('[REDACTADO]');
      return true;
    });
  });

  it('falla si la respuesta no trae ni data ni errors', async () => {
    const fetchMock = vi.fn(async () => gqlResponse({}));
    await expect(
      makeClient(fetchMock as unknown as typeof fetch).testConnection(),
    ).rejects.toMatchObject({ retryable: false });
  });
});
