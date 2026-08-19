/**
 * Pruebas de la lectura de catálogo y el diagnóstico de SKU.
 *
 * Lo que se fija aquí:
 *
 *  - La paginación recorre TODAS las páginas. Es el fallo que en pruebas no se
 *    ve —el catálogo de prueba cabe en una página— y en producción sincroniza
 *    sólo los 50 primeros productos sin dar error.
 *  - Los SKU se comparan sin distinguir mayúsculas ni espacios sobrantes.
 *  - Se usa el stock DISPONIBLE, no el total: publicar el reservado provoca
 *    sobreventa.
 *  - Una variante sin precio o sin stock se marca, no se descarta en silencio.
 */
import { describe, expect, it, vi } from 'vitest';
import { BsaleClient, BSALE_MAX_LIMIT } from '../src/integrations/bsale/client.js';
import { leerCatalogo, normalizarSku } from '../src/services/catalog.service.js';

const TOKEN = 'token-de-prueba';

function pagina(items: unknown[], count: number, offset = 0) {
  return new Response(
    JSON.stringify({ href: '', count, limit: BSALE_MAX_LIMIT, offset, items }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function variante(id: number, code: string | null, descripcion = `Variante ${id}`) {
  return { href: '', id, code, description: descripcion, product: { id: 900 + id } };
}

/** Variante sin descripción propia, con el nombre en el producto. Es el caso
 *  mayoritario en el catálogo real de Bsale. */
function varianteSinDescripcion(id: number, code: string, nombreProducto: string) {
  return { href: '', id, code, description: '', product: { id: 900 + id, name: nombreProducto } };
}

/** fetch simulado que responde según la ruta y el offset pedidos. */
function fakeFetch(rutas: Record<string, unknown[]>) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const clave = Object.keys(rutas).find((r) => url.pathname.includes(r));
    const todos = clave ? rutas[clave]! : [];
    const trozo = todos.slice(offset, offset + BSALE_MAX_LIMIT);
    return pagina(trozo, todos.length, offset);
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return new BsaleClient({ accessToken: TOKEN, fetchImpl, sleep: async () => {} });
}

describe('normalizarSku', () => {
  it('ignora mayúsculas y espacios en los extremos', () => {
    expect(normalizarSku(' ABC-1 ')).toBe('abc-1');
    expect(normalizarSku('abc-1')).toBe(normalizarSku('ABC-1'));
  });

  it('devuelve cadena vacía para nulo o vacío', () => {
    expect(normalizarSku(null)).toBe('');
    expect(normalizarSku('   ')).toBe('');
  });

  it('NO unifica guiones: AB-01 y AB01 son distintos', () => {
    expect(normalizarSku('AB-01')).not.toBe(normalizarSku('AB01'));
  });
});

describe('leerCatalogo', () => {
  it('recorre todas las páginas, no sólo la primera', async () => {
    // 120 variantes = 3 páginas de 50, 50 y 20.
    const variantes = Array.from({ length: 120 }, (_, i) => variante(i + 1, `SKU-${i + 1}`));
    const fetchMock = fakeFetch({ '/variants.json': variantes });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const { items, resumen } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

    expect(items).toHaveLength(120);
    expect(resumen.total).toBe(120);
  });

  it('cruza precio y stock con cada variante', async () => {
    const fetchMock = fakeFetch({
      '/variants.json': [variante(1, 'A-1'), variante(2, 'A-2')],
      '/details.json': [
        { href: '', id: 10, variant: { id: 1 }, variantValue: 100, variantValueWithTaxes: 118 },
        { href: '', id: 11, variant: { id: 2 }, variantValue: 200, variantValueWithTaxes: 236 },
      ],
      '/stocks.json': [
        { href: '', id: 20, variant: { id: 1 }, quantity: 10, quantityAvailable: 7 },
        { href: '', id: 21, variant: { id: 2 }, quantity: 5, quantityAvailable: 5 },
      ],
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const { items } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

    // Precio CON impuestos: es el que se publica en Shopify.
    expect(items[0]).toMatchObject({ sku: 'A-1', precio: 118, stock: 7 });
    expect(items[1]).toMatchObject({ sku: 'A-2', precio: 236, stock: 5 });
  });

  it('usa el stock disponible, no el total, para no provocar sobreventa', async () => {
    const fetchMock = fakeFetch({
      '/variants.json': [variante(1, 'A-1')],
      '/stocks.json': [{ href: '', id: 20, variant: { id: 1 }, quantity: 100, quantityAvailable: 3 }],
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const { items } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });
    expect(items[0]!.stock).toBe(3);
  });

  it('resuelve el id de variante cuando sólo viene el href', async () => {
    const fetchMock = fakeFetch({
      '/variants.json': [variante(7, 'A-7')],
      '/details.json': [
        {
          href: '',
          id: 10,
          variant: { href: 'https://api.bsale.io/v1/variants/7.json' },
          variantValueWithTaxes: 59.9,
        },
      ],
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const { items } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });
    expect(items[0]!.precio).toBe(59.9);
  });

  describe('nombres', () => {
    it('usa el nombre del PRODUCTO cuando la variante no tiene descripción', async () => {
      const fetchMock = fakeFetch({
        '/variants.json': [
          varianteSinDescripcion(1, 'A-1', 'EQUILIBRIO GRAIN FREE PUPPIES SMALL BREEDS 1.5'),
        ],
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { items } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(items[0]!.nombre).toBe('EQUILIBRIO GRAIN FREE PUPPIES SMALL BREEDS 1.5');
    });

    it('prefiere la descripción de la variante cuando existe', async () => {
      const fetchMock = fakeFetch({
        '/variants.json': [
          { href: '', id: 1, code: 'A-1', description: 'Talla M', product: { id: 9, name: 'Collar' } },
        ],
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { items } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(items[0]!.nombre).toBe('Talla M');
    });

    it('pide el producto expandido, o el nombre nunca llegaría', async () => {
      const fetchMock = fakeFetch({ '/variants.json': [variante(1, 'A-1')] });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      const variantesUrl = urls.find((u) => u.includes('/variants.json'));
      expect(decodeURIComponent(variantesUrl ?? '')).toContain('expand=[product]');
    });
  });

  describe('diagnóstico', () => {
    it('marca las variantes sin SKU', async () => {
      const fetchMock = fakeFetch({
        '/variants.json': [variante(1, 'A-1'), variante(2, null), variante(3, '   ')],
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { items, resumen } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(resumen.sinSku).toBe(2);
      expect(items[1]!.problemas).toContain('SIN_SKU');
      expect(items[2]!.problemas).toContain('SIN_SKU');
      expect(items[0]!.problemas).not.toContain('SIN_SKU');
    });

    it('detecta SKU duplicados ignorando mayúsculas y espacios', async () => {
      const fetchMock = fakeFetch({
        '/variants.json': [variante(1, 'ABC-1'), variante(2, ' abc-1 '), variante(3, 'OTRO')],
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { items, resumen } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(resumen.skusDuplicados).toBe(1);
      expect(resumen.duplicados[0]).toEqual({ sku: 'abc-1', variantes: [1, 2] });
      expect(items[0]!.problemas).toContain('SKU_DUPLICADO');
      expect(items[1]!.problemas).toContain('SKU_DUPLICADO');
      expect(items[2]!.problemas).not.toContain('SKU_DUPLICADO');
    });

    it('una variante sin SKU no cuenta además como duplicada', async () => {
      const fetchMock = fakeFetch({
        '/variants.json': [variante(1, null), variante(2, null)],
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { items, resumen } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(resumen.skusDuplicados).toBe(0);
      expect(items[0]!.problemas).toEqual(expect.arrayContaining(['SIN_SKU']));
      expect(items[0]!.problemas).not.toContain('SKU_DUPLICADO');
    });

    it('marca las que no tienen precio ni stock en vez de descartarlas', async () => {
      const fetchMock = fakeFetch({
        '/variants.json': [variante(1, 'A-1')],
        // sin precios ni stock
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { items, resumen } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(items).toHaveLength(1);
      expect(items[0]!.problemas).toEqual(expect.arrayContaining(['SIN_PRECIO', 'SIN_STOCK']));
      expect(resumen.sinPrecio).toBe(1);
      expect(resumen.sinStock).toBe(1);
    });

    it('un stock de cero es un dato válido, no un problema', async () => {
      const fetchMock = fakeFetch({
        '/variants.json': [variante(1, 'A-1')],
        '/stocks.json': [{ href: '', id: 20, variant: { id: 1 }, quantityAvailable: 0 }],
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { items } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(items[0]!.stock).toBe(0);
      expect(items[0]!.problemas).not.toContain('SIN_STOCK');
    });

    it('el resumen cuenta las variantes con algún problema, no los problemas', async () => {
      const fetchMock = fakeFetch({
        // La 2 tiene tres problemas a la vez; debe contar como UNA variante.
        '/variants.json': [variante(1, 'A-1'), variante(2, null)],
        '/details.json': [{ href: '', id: 10, variant: { id: 1 }, variantValueWithTaxes: 10 }],
        '/stocks.json': [{ href: '', id: 20, variant: { id: 1 }, quantityAvailable: 1 }],
      });
      const client = makeClient(fetchMock as unknown as typeof fetch);

      const { resumen } = await leerCatalogo(client, { priceListId: 4, officeId: 1 });

      expect(resumen.total).toBe(2);
      expect(resumen.conProblemas).toBe(1);
    });
  });

  it('el stock se pide filtrado por sucursal', async () => {
    const fetchMock = fakeFetch({ '/variants.json': [variante(1, 'A-1')] });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await leerCatalogo(client, { priceListId: 4, officeId: 2 });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    const stockUrl = urls.find((u) => u.includes('/stocks.json'));
    expect(stockUrl).toContain('officeid=2');
  });

  it('maxItems corta la lectura sin recorrer el catálogo entero', async () => {
    const variantes = Array.from({ length: 500 }, (_, i) => variante(i + 1, `SKU-${i + 1}`));
    const fetchMock = fakeFetch({ '/variants.json': variantes });
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const { items } = await leerCatalogo(client, { priceListId: 4, officeId: 1, maxItems: 60 });

    expect(items).toHaveLength(60);
  });
});
