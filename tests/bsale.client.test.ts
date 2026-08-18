import { describe, expect, it, vi } from 'vitest';
import { BsaleClient } from '../src/integrations/bsale/client.js';
import { IntegrationError } from '../src/lib/errors.js';

const TOKEN = 'bsale-token-de-prueba-1234567890';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const officesPage = {
  href: 'https://api.bsale.io/v1/offices.json',
  count: 2,
  limit: 50,
  offset: 0,
  items: [
    { href: '...', id: 1, name: 'Tienda Principal', isVirtual: 0 },
    { href: '...', id: 2, name: 'Almacén Web', isVirtual: 1 },
  ],
};

/** Cliente con reintentos instantáneos: los tests no deben esperar backoff real. */
function makeClient(fetchImpl: typeof fetch, maxRetries = 3) {
  return new BsaleClient({
    accessToken: TOKEN,
    baseUrl: 'https://api.bsale.io/v1',
    fetchImpl,
    maxRetries,
    sleep: async () => {},
  });
}

describe('BsaleClient · autenticación', () => {
  it('envía el token en el header access_token, como exige la documentación oficial', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(officesPage));
    await makeClient(fetchMock as unknown as typeof fetch).testConnection();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['access_token']).toBe(TOKEN);
  });

  it('nunca pone el token en la URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(officesPage));
    await makeClient(fetchMock as unknown as typeof fetch).testConnection();

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain(TOKEN);
  });

  it('rechaza construirse sin token', () => {
    expect(() => new BsaleClient({ accessToken: '' })).toThrow(IntegrationError);
  });
});

describe('BsaleClient · testConnection', () => {
  it('llama a GET /offices.json y devuelve las sucursales', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(officesPage));
    const result = await makeClient(fetchMock as unknown as typeof fetch).testConnection();

    expect(fetchMock.mock.calls[0]![0]).toContain('/offices.json');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('GET');
    expect(result.ok).toBe(true);
    expect(result.officeCount).toBe(2);
    expect(result.offices[0]!.name).toBe('Tienda Principal');
  });

  it('respeta el límite de paginación documentado de 50', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(officesPage));
    await makeClient(fetchMock as unknown as typeof fetch).testConnection();
    expect(fetchMock.mock.calls[0]![0]).toContain('limit=50');
  });
});

describe('BsaleClient · errores', () => {
  it('marca el 401 como NO reintentable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Invalid token' }, 401));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.testConnection()).rejects.toMatchObject({
      provider: 'BSALE',
      status: 401,
      retryable: false,
    });
    // No reintentable ⇒ una sola llamada.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reintenta ante 500 y termina lanzando si persiste', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const client = makeClient(fetchMock as unknown as typeof fetch, 3);

    await expect(client.testConnection()).rejects.toMatchObject({ retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reintenta ante 429 y se recupera si el segundo intento funciona', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return n === 1 ? jsonResponse({ error: 'rate limit' }, 429) : jsonResponse(officesPage);
    });
    const result = await makeClient(fetchMock as unknown as typeof fetch).testConnection();
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('nunca filtra el token en el mensaje de error', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: `token inválido: ${TOKEN}` }, 401),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.testConnection()).rejects.toSatisfy((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
      return true;
    });
  });

  it('trata un cuerpo no-JSON como error no reintentable', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>error</html>', { status: 200 }),
    );
    await expect(
      makeClient(fetchMock as unknown as typeof fetch).testConnection(),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('convierte un fallo de red en un error reintentable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      makeClient(fetchMock as unknown as typeof fetch, 1).testConnection(),
    ).rejects.toMatchObject({ provider: 'BSALE', retryable: true });
  });
});

describe('BsaleClient · descubrimiento de configuración', () => {
  it('consulta los endpoints correctos para tipos de documento, impuestos y listas de precio', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('document_types')) {
        return jsonResponse({
          count: 2,
          items: [
            { id: 1, name: 'Boleta Electrónica', isElectronicService: 1, isSalesNote: 0 },
            { id: 2, name: 'Factura Electrónica', isElectronicService: 1, isSalesNote: 0 },
          ],
        });
      }
      if (url.includes('taxes')) {
        return jsonResponse({ count: 1, items: [{ id: 1, name: 'IGV', percentage: 18 }] });
      }
      return jsonResponse({ count: 1, items: [{ id: 3, name: 'Lista General' }] });
    });

    const client = makeClient(fetchMock as unknown as typeof fetch);
    const tipos = await client.listDocumentTypes();
    const impuestos = await client.listTaxes();
    const listas = await client.listPriceLists();

    expect(tipos.items).toHaveLength(2);
    expect(impuestos.items[0]!.name).toBe('IGV');
    expect(listas.items[0]!.id).toBe(3);
  });
});
