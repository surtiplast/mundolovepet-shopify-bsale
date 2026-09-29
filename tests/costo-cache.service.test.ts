/**
 * Pruebas del caché de costos.
 *
 * Lo que importa: una variante consultada hace poco no vuelve a llamar a
 * Bsale, una vencida sí, y sólo lo que de verdad se consultó de nuevo se
 * guarda al final.
 */
import { describe, expect, it, vi } from 'vitest';
import { crearCacheDeCostos } from '../src/services/costo-cache.service.js';
import type { ProductoGuardado } from '../src/db/catalog.store.js';

function producto(over: Partial<ProductoGuardado> = {}): ProductoGuardado {
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
    bsaleCosto: null,
    costoRevisadoEl: null,
    ...over,
  };
}

describe('crearCacheDeCostos', () => {
  it('sin nada en caché, llama a la función real y devuelve lo que responde', async () => {
    const real = vi.fn(async () => 4.5);
    const cache = crearCacheDeCostos([producto()]);
    const envuelta = cache.envolver(real);

    await expect(envuelta(100)).resolves.toBe(4.5);
    expect(real).toHaveBeenCalledWith(100);
  });

  it('con un valor vigente en caché, NO llama a Bsale', async () => {
    const real = vi.fn(async () => 999);
    const recien = new Date();
    const cache = crearCacheDeCostos([producto({ bsaleCosto: 4.5, costoRevisadoEl: recien })]);
    const envuelta = cache.envolver(real);

    await expect(envuelta(100)).resolves.toBe(4.5);
    expect(real).not.toHaveBeenCalled();
  });

  it('con un valor vigente en caché que es null (Bsale confirmó que no tiene), tampoco llama', async () => {
    const real = vi.fn(async () => 999);
    const recien = new Date();
    const cache = crearCacheDeCostos([producto({ bsaleCosto: null, costoRevisadoEl: recien })]);
    const envuelta = cache.envolver(real);

    await expect(envuelta(100)).resolves.toBeNull();
    expect(real).not.toHaveBeenCalled();
  });

  it('con un valor vencido (más de 24h), vuelve a llamar a Bsale', async () => {
    const real = vi.fn(async () => 7.2);
    const haceDosDias = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const cache = crearCacheDeCostos([producto({ bsaleCosto: null, costoRevisadoEl: haceDosDias })]);
    const envuelta = cache.envolver(real);

    await expect(envuelta(100)).resolves.toBe(7.2);
    expect(real).toHaveBeenCalledWith(100);
  });

  it('una variante que no está en el catálogo (candidato nuevo) igual funciona, sin caché posible', async () => {
    const real = vi.fn(async () => 3);
    const cache = crearCacheDeCostos([]);
    const envuelta = cache.envolver(real);

    await expect(envuelta(999)).resolves.toBe(3);
    expect(real).toHaveBeenCalledWith(999);
  });

  describe('guardar', () => {
    it('sin haber consultado nada nuevo, no escribe', async () => {
      const recien = new Date();
      const cache = crearCacheDeCostos([producto({ bsaleCosto: 1, costoRevisadoEl: recien })]);
      await cache.envolver(async () => 999)(100); // usa el caché, no consulta

      const store = { actualizarCostos: vi.fn(async () => {}) };
      await cache.guardar(store as never);

      expect(store.actualizarCostos).not.toHaveBeenCalled();
    });

    it('guarda exactamente lo que se consultó de nuevo, por SKU', async () => {
      const cache = crearCacheDeCostos([producto({ sku: 'A1', bsaleVariantId: 100 })]);
      await cache.envolver(async () => 4.5)(100);

      const store = { actualizarCostos: vi.fn(async () => {}) };
      await cache.guardar(store as never);

      expect(store.actualizarCostos).toHaveBeenCalledWith([{ sku: 'A1', bsaleCosto: 4.5 }]);
    });

    it('un costo nulo (Bsale respondió que no tiene) también se guarda, no se descarta', async () => {
      const cache = crearCacheDeCostos([producto({ sku: 'A1', bsaleVariantId: 100 })]);
      await cache.envolver(async () => null)(100);

      const store = { actualizarCostos: vi.fn(async () => {}) };
      await cache.guardar(store as never);

      expect(store.actualizarCostos).toHaveBeenCalledWith([{ sku: 'A1', bsaleCosto: null }]);
    });

    it('una variante fuera del catálogo consultada no se intenta guardar (no hay SKU al que atribuirla)', async () => {
      const cache = crearCacheDeCostos([]);
      await cache.envolver(async () => 4.5)(999);

      const store = { actualizarCostos: vi.fn(async () => {}) };
      await cache.guardar(store as never);

      expect(store.actualizarCostos).not.toHaveBeenCalled();
    });
  });
});
