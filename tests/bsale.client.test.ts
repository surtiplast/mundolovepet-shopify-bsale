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
            { id: 1, name: 'Boleta Electrónica', isElectronicDocument: 1, isSalesNote: 0 },
            { id: 2, name: 'Factura Electrónica', isElectronicDocument: 1, isSalesNote: 0 },
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

describe('BsaleClient · obtenerCosto', () => {
  it('devuelve null en un 404 real: la variante no tiene costo registrado', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'not found' }, 404));
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);

    await expect(client.obtenerCosto(123)).resolves.toBeNull();
  });

  it('NO confunde un 500 con «sin costo»: propaga el error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);

    await expect(client.obtenerCosto(123)).rejects.toMatchObject({ provider: 'BSALE', status: 500 });
  });

  it('NO confunde un fallo de red con «sin costo»: propaga el error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);

    await expect(client.obtenerCosto(123)).rejects.toMatchObject({ provider: 'BSALE' });
  });

  it('devuelve el costo cuando Bsale lo tiene', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ averageCost: '12.5' }));
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);

    await expect(client.obtenerCosto(123)).resolves.toBe(12.5);
  });
});

describe('BsaleClient · obtenerDocumento', () => {
  it('pide las líneas y el cliente con expand, no sólo el documento pelado', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 500, client: { code: '45678912' }, details: { items: [] } }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);
    await client.obtenerDocumento(500);

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/documents/500.json');
    expect(url).toContain('expand=');
    expect(decodeURIComponent(url)).toContain('[details,client]');
  });

  it('propaga un 404 en vez de devolver un documento vacío', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'not found' }, 404));
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);

    await expect(client.obtenerDocumento(999)).rejects.toMatchObject({ provider: 'BSALE', status: 404 });
  });
});

describe('BsaleClient · emitirNotaCredito', () => {
  const notaValida = {
    documentTypeId: 9,
    officeId: 1,
    emissionDate: 1755475200,
    expirationDate: 1755475200,
    referenceDocumentId: 500,
    motive: 'Pedido reembolsado',
    declare: 1 as const,
    type: 0 as const,
    priceAdjustment: 0 as const,
    editTexts: 0 as const,
    details: [{ documentDetailId: 111, quantity: 1 }],
  };

  it('anula contra /returns.json, NO contra /documents.json', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 900, number: 55, serialNumber: 'BC01-55' }));
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);
    await client.emitirNotaCredito(notaValida);

    const url = fetchMock.mock.calls[0]![0] as string;
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(url).toContain('/returns.json');
    expect(url).not.toContain('/documents.json');
    expect(init.method).toBe('POST');
  });

  it('rechaza anular sin líneas antes de llamar a Bsale', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 900 }));
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);

    await expect(client.emitirNotaCredito({ ...notaValida, details: [] })).rejects.toMatchObject({
      provider: 'BSALE',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un rechazo de Bsale (comprobante ya anulado) se propaga, no se traga', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'El documento ya fue anulado' }, 422));
    const client = makeClient(fetchMock as unknown as typeof fetch, 1);

    await expect(client.emitirNotaCredito(notaValida)).rejects.toMatchObject({ provider: 'BSALE', status: 422 });
  });
});
