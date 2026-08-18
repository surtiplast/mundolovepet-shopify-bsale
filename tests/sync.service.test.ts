/**
 * Pruebas de la sincronización Bsale → Shopify.
 *
 * Este es el primer código del proyecto que modifica la tienda del cliente, así
 * que lo que más se prueba no es que escriba: es que **no escriba cuando no
 * debe**.
 *
 *  - Planificar nunca toca la tienda.
 *  - Un precio de cero jamás se publica: sería un producto gratis.
 *  - El límite se respeta, para poder probar con diez antes de lanzar tres mil.
 *  - Se guarda el valor anterior de cada cambio, o no habría forma de revertir.
 *  - Un lote que falla no se cuenta como aplicado.
 */
import { describe, expect, it, vi } from 'vitest';
import { planificar, aplicarStock, aplicarPrecios } from '../src/services/sync.service.js';
import type { Emparejado } from '../src/services/matching.service.js';

function emp(over: Partial<Emparejado> = {}): Emparejado {
  return {
    codigo: 'A1',
    bsaleVariantId: 1,
    shopifyVariantId: 'gid://var/1',
    shopifyInventoryItemId: 'gid://inv/1',
    nombreShopify: 'Producto',
    precioBsale: 10,
    precioShopify: 10,
    stockBsale: 5,
    stockShopify: 5,
    difierePrecio: false,
    difiereStock: false,
    ...over,
  };
}

describe('planificar', () => {
  it('sólo incluye lo que difiere', () => {
    const plan = planificar(
      [
        emp({ codigo: 'IGUAL' }),
        emp({ codigo: 'DIFIERE', stockBsale: 0, stockShopify: 15, difiereStock: true }),
      ],
      'STOCK',
    );

    expect(plan.cambios).toHaveLength(1);
    expect(plan.cambios[0]!.codigo).toBe('DIFIERE');
  });

  it('guarda el valor anterior para poder revertir', () => {
    const plan = planificar(
      [emp({ stockBsale: 0, stockShopify: 15, difiereStock: true })],
      'STOCK',
    );

    expect(plan.cambios[0]).toMatchObject({ valorAnterior: 15, valorNuevo: 0 });
  });

  it('cuenta cuántos se agotan y cuántos se reponen', () => {
    const plan = planificar(
      [
        emp({ codigo: 'A', stockBsale: 0, stockShopify: 15, difiereStock: true }),
        emp({ codigo: 'B', stockBsale: 0, stockShopify: 3, difiereStock: true }),
        emp({ codigo: 'C', stockBsale: 7, stockShopify: 0, difiereStock: true }),
      ],
      'STOCK',
    );

    expect(plan.resumen.seAgotan).toBe(2);
    expect(plan.resumen.seReponen).toBe(1);
  });

  it('señala el mayor salto, que delata un error de configuración', () => {
    const plan = planificar(
      [
        emp({ codigo: 'PEQUEÑO', precioBsale: 11, precioShopify: 10, difierePrecio: true }),
        emp({ codigo: 'ENORME', precioBsale: 273, precioShopify: 90, difierePrecio: true }),
      ],
      'PRECIO',
    );

    expect(plan.resumen.mayorSalto?.codigo).toBe('ENORME');
  });

  it('respeta el límite para poder probar con pocos primero', () => {
    const muchos = Array.from({ length: 50 }, (_, i) =>
      emp({ codigo: `C${i}`, stockBsale: 0, stockShopify: 15, difiereStock: true }),
    );

    expect(planificar(muchos, 'STOCK', 10).cambios).toHaveLength(10);
    expect(planificar(muchos, 'STOCK').cambios).toHaveLength(50);
  });

  describe('omisiones', () => {
    it('NUNCA publica un precio de cero: sería un producto gratis', () => {
      const plan = planificar(
        [emp({ codigo: 'GRATIS', precioBsale: 0, precioShopify: 25, difierePrecio: true })],
        'PRECIO',
      );

      expect(plan.cambios).toHaveLength(0);
      expect(plan.omitidos[0]).toMatchObject({ codigo: 'GRATIS' });
      expect(plan.omitidos[0]!.motivo).toMatch(/cero/i);
    });

    it('omite las variantes que no gestionan inventario', () => {
      const plan = planificar(
        [emp({ stockBsale: 0, stockShopify: 15, difiereStock: true, shopifyInventoryItemId: null })],
        'STOCK',
      );

      expect(plan.cambios).toHaveLength(0);
      expect(plan.omitidos[0]!.motivo).toMatch(/inventario/i);
    });

    it('omite lo que no tiene dato en Bsale en vez de escribir un cero inventado', () => {
      const plan = planificar(
        [emp({ codigo: 'X', stockBsale: null, stockShopify: 15, difiereStock: true })],
        'STOCK',
      );

      expect(plan.cambios).toHaveLength(0);
      expect(plan.omitidos).toHaveLength(1);
    });
  });

  it('un stock de cero SÍ se escribe: es el caso que más importa corregir', () => {
    const plan = planificar(
      [emp({ stockBsale: 0, stockShopify: 15, difiereStock: true })],
      'STOCK',
    );

    expect(plan.cambios).toHaveLength(1);
    expect(plan.cambios[0]!.valorNuevo).toBe(0);
  });
});

describe('aplicarStock', () => {
  function clienteFalso(ok = true) {
    return {
      fijarInventario: vi.fn(async () => ({ ok, errores: ok ? [] : ['Algo falló'] })),
      actualizarPrecios: vi.fn(async () => ({ ok: true, errores: [] })),
    };
  }

  it('planificar no llama a la tienda; sólo aplicar lo hace', async () => {
    const client = clienteFalso();
    const plan = planificar(
      [emp({ stockBsale: 0, stockShopify: 15, difiereStock: true })],
      'STOCK',
    );

    expect(client.fijarInventario).not.toHaveBeenCalled();

    await aplicarStock(client as never, plan, 'gid://loc/1');
    expect(client.fijarInventario).toHaveBeenCalledTimes(1);
  });

  it('parte en lotes para no superar el coste máximo de consulta', async () => {
    const client = clienteFalso();
    const muchos = Array.from({ length: 250 }, (_, i) =>
      emp({
        codigo: `C${i}`,
        shopifyInventoryItemId: `gid://inv/${i}`,
        stockBsale: 0,
        stockShopify: 15,
        difiereStock: true,
      }),
    );
    const plan = planificar(muchos, 'STOCK');

    const r = await aplicarStock(client as never, plan, 'gid://loc/1', 100);

    expect(client.fijarInventario).toHaveBeenCalledTimes(3);
    expect(r.aplicados).toBe(250);
  });

  it('manda la sucursal y la cantidad correctas', async () => {
    const client = clienteFalso();
    const plan = planificar(
      [emp({ shopifyInventoryItemId: 'gid://inv/7', stockBsale: 3, stockShopify: 15, difiereStock: true })],
      'STOCK',
    );

    await aplicarStock(client as never, plan, 'gid://loc/99');

    // `desde` es obligatorio: la API 2026-07 lo exige como changeFromQuantity
    // para detectar que alguien vendió el producto mientras sincronizábamos.
    expect(client.fijarInventario).toHaveBeenCalledWith([
      { inventoryItemId: 'gid://inv/7', locationId: 'gid://loc/99', cantidad: 3, desde: 15 },
    ]);
  });

  it('un lote rechazado no se cuenta como aplicado', async () => {
    const client = clienteFalso(false);
    const plan = planificar(
      [emp({ stockBsale: 0, stockShopify: 15, difiereStock: true })],
      'STOCK',
    );

    const r = await aplicarStock(client as never, plan, 'gid://loc/1');

    expect(r.aplicados).toBe(0);
    expect(r.fallidos).toBe(1);
    expect(r.errores).toHaveLength(1);
  });

  it('un fallo de red no interrumpe el resto de lotes', async () => {
    let llamada = 0;
    const client = {
      fijarInventario: vi.fn(async () => {
        llamada++;
        if (llamada === 1) throw new Error('Timeout');
        return { ok: true, errores: [] };
      }),
    };
    const muchos = Array.from({ length: 20 }, (_, i) =>
      emp({
        codigo: `C${i}`,
        shopifyInventoryItemId: `gid://inv/${i}`,
        stockBsale: 0,
        stockShopify: 15,
        difiereStock: true,
      }),
    );
    const plan = planificar(muchos, 'STOCK');

    const r = await aplicarStock(client as never, plan, 'gid://loc/1', 10);

    expect(r.fallidos).toBe(10);
    expect(r.aplicados).toBe(10);
  });

  it('rechaza un plan que no es de stock', async () => {
    const plan = planificar([emp({ precioBsale: 20, precioShopify: 10, difierePrecio: true })], 'PRECIO');
    await expect(aplicarStock(clienteFalso() as never, plan, 'gid://loc/1')).rejects.toThrow();
  });
});

describe('aplicarPrecios', () => {
  it('agrupa por producto, como exige la mutación de Shopify', async () => {
    const client = { actualizarPrecios: vi.fn(async () => ({ ok: true, errores: [] })) };
    const plan = planificar(
      [
        emp({ codigo: 'A', shopifyVariantId: 'v1', precioBsale: 20, precioShopify: 10, difierePrecio: true }),
        emp({ codigo: 'B', shopifyVariantId: 'v2', precioBsale: 30, precioShopify: 10, difierePrecio: true }),
        emp({ codigo: 'C', shopifyVariantId: 'v3', precioBsale: 40, precioShopify: 10, difierePrecio: true }),
      ],
      'PRECIO',
    );

    // v1 y v2 son del mismo producto; v3 de otro.
    const mapa = new Map([['v1', 'p1'], ['v2', 'p1'], ['v3', 'p2']]);
    const r = await aplicarPrecios(client as never, plan, mapa);

    expect(client.actualizarPrecios).toHaveBeenCalledTimes(2);
    expect(r.aplicados).toBe(3);
  });

  it('manda el precio como cadena con dos decimales', async () => {
    const client = { actualizarPrecios: vi.fn(async () => ({ ok: true, errores: [] })) };
    const plan = planificar(
      [emp({ shopifyVariantId: 'v1', precioBsale: 18, precioShopify: 10, difierePrecio: true })],
      'PRECIO',
    );

    await aplicarPrecios(client as never, plan, new Map([['v1', 'p1']]));

    expect(client.actualizarPrecios).toHaveBeenCalledWith('p1', [
      { variantId: 'v1', precio: '18.00' },
    ]);
  });

  it('no escribe si no se conoce el producto de la variante', async () => {
    const client = { actualizarPrecios: vi.fn(async () => ({ ok: true, errores: [] })) };
    const plan = planificar(
      [emp({ shopifyVariantId: 'huerfana', precioBsale: 20, precioShopify: 10, difierePrecio: true })],
      'PRECIO',
    );

    const r = await aplicarPrecios(client as never, plan, new Map());

    expect(client.actualizarPrecios).not.toHaveBeenCalled();
    expect(r.fallidos).toBe(1);
  });
});
