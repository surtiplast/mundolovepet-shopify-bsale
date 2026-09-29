/**
 * Pruebas del almacén de catálogo.
 *
 * Lo que importa aquí: `guardar()` (releer el catálogo de Bsale) nunca pisa
 * el caché de costo, y `actualizarCostos()` es lo único que lo toca.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryCatalogStore,
  PrismaCatalogStore,
  type ItemDeCatalogo,
  type PrismaCatalogLike,
} from '../src/db/catalog.store.js';

function item(over: Partial<ItemDeCatalogo> = {}): ItemDeCatalogo {
  return {
    sku: 'A1',
    barcode: null,
    brand: null,
    category: null,
    bsaleVariantId: 100,
    bsaleProductId: null,
    name: 'Producto',
    bsalePrice: 10,
    bsaleStock: 5,
    ...over,
  };
}

describe('InMemoryCatalogStore', () => {
  it('un SKU nuevo empieza sin costo en caché', async () => {
    const store = new InMemoryCatalogStore();
    await store.guardar([item()]);

    const [fila] = await store.listar();
    expect(fila!.bsaleCosto).toBeNull();
    expect(fila!.costoRevisadoEl).toBeNull();
  });

  it('actualizarCostos guarda el costo y la fecha de la consulta', async () => {
    const store = new InMemoryCatalogStore();
    await store.guardar([item()]);
    await store.actualizarCostos([{ sku: 'A1', bsaleCosto: 4.5 }]);

    const [fila] = await store.listar();
    expect(fila!.bsaleCosto).toBe(4.5);
    expect(fila!.costoRevisadoEl).toBeInstanceOf(Date);
  });

  it('releer el catálogo (guardar de nuevo) NO borra el costo ya cacheado', async () => {
    const store = new InMemoryCatalogStore();
    await store.guardar([item()]);
    await store.actualizarCostos([{ sku: 'A1', bsaleCosto: 4.5 }]);

    // Simula «Leer catálogo de Bsale» otra vez: mismo SKU, precio distinto.
    await store.guardar([item({ bsalePrice: 12 })]);

    const [fila] = await store.listar();
    expect(fila!.bsalePrice).toBe(12);
    expect(fila!.bsaleCosto).toBe(4.5);
    expect(fila!.costoRevisadoEl).toBeInstanceOf(Date);
  });

  it('actualizarCostos ignora un SKU que no existe en el catálogo', async () => {
    const store = new InMemoryCatalogStore();
    await expect(store.actualizarCostos([{ sku: 'NO-EXISTE', bsaleCosto: 1 }])).resolves.toBeUndefined();
  });
});

describe('PrismaCatalogStore', () => {
  it('guardar() no incluye bsaleCosto ni costoRevisadoEl en el upsert', async () => {
    const upsert = vi.fn(async () => ({}));
    const prisma: PrismaCatalogLike = {
      productMap: { upsert, findMany: async () => [], count: async () => 0, update: async () => ({}) },
    };
    await new PrismaCatalogStore(prisma).guardar([item()]);

    const datos = upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(datos.create).not.toHaveProperty('bsaleCosto');
    expect(datos.create).not.toHaveProperty('costoRevisadoEl');
  });

  it('actualizarCostos() traduce a update() por SKU, con la fecha de ahora', async () => {
    const update = vi.fn(async () => ({}));
    const prisma: PrismaCatalogLike = {
      productMap: { upsert: async () => ({}), findMany: async () => [], count: async () => 0, update },
    };
    await new PrismaCatalogStore(prisma).actualizarCostos([{ sku: 'A1', bsaleCosto: 4.5 }]);

    expect(update).toHaveBeenCalledWith({
      where: { sku: 'A1' },
      data: { bsaleCosto: 4.5, costoRevisadoEl: expect.any(Date) },
    });
  });

  it('listar() normaliza el Decimal de bsaleCosto a number', async () => {
    const prisma: PrismaCatalogLike = {
      productMap: {
        upsert: async () => ({}),
        count: async () => 0,
        update: async () => ({}),
        findMany: async () => [
          {
            sku: 'A1',
            barcode: null,
            brand: null,
            category: null,
            bsaleVariantId: 100,
            bsaleProductId: null,
            name: 'Producto',
            bsalePrice: '10.5',
            bsaleStock: 5,
            bsaleCosto: '4.5000',
            costoRevisadoEl: new Date('2026-09-29T00:00:00Z'),
          },
        ],
      },
    };
    const [fila] = await new PrismaCatalogStore(prisma).listar();
    expect(fila!.bsaleCosto).toBe(4.5);
    expect(typeof fila!.bsaleCosto).toBe('number');
  });
});
