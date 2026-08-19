/**
 * Pruebas de la reparación de productos.
 *
 * Lo que hay que probar aquí no es que arregle, sino que **no estropee**. La
 * reparación escribe sobre productos que ya están en la tienda, muchos de ellos
 * anteriores a la app y con datos puestos a mano. Una regla demasiado ambiciosa
 * borraría códigos de barras correctos de miles de productos, y eso no se
 * deshace.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  planificarReparacion,
  anadirCostosReparacion,
  aplicarReparacion,
} from '../src/services/repair.service.js';
import type { ProductoGuardado } from '../src/db/catalog.store.js';
import type { ShopifyVariant } from '../src/integrations/shopify/client.js';

function bsale(over: Partial<ProductoGuardado> = {}): ProductoGuardado {
  return {
    sku: '74352029961567',
    barcode: '8595602559152',
    bsaleVariantId: 1,
    bsaleProductId: 9,
    name: 'BRIT CARE GRAIN FREE',
    bsalePrice: 101,
    bsaleStock: 9,
    ...over,
  };
}

function shopify(over: Partial<ShopifyVariant> = {}): ShopifyVariant {
  return {
    id: 'gid://shopify/ProductVariant/1',
    sku: '74352029961567',
    // El fallo: el SKU copiado en el código de barras.
    barcode: '74352029961567',
    price: '101.00',
    inventoryQuantity: 9,
    inventoryItemId: 'gid://shopify/InventoryItem/1',
    costo: null,
    productId: 'gid://shopify/Product/1',
    productTitle: 'SALMÓN SENIOR Y LIGHT 3KG',
    title: 'Default Title',
    ...over,
  };
}

describe('planificarReparacion', () => {
  it('detecta el código de barras que era una copia del SKU', () => {
    const plan = planificarReparacion([bsale()], [shopify()]);

    expect(plan.reparaciones).toHaveLength(1);
    expect(plan.reparaciones[0]!.barcode).toBe('8595602559152');
    expect(plan.reparaciones[0]!.barcodeAnterior).toBe('74352029961567');
  });

  describe('lo que NO toca', () => {
    /**
     * La prueba más importante del archivo. En esta tienda hay 3.041 productos
     * anteriores a la app; si la regla fuera «si difiere de Bsale, píselo», una
     * sola pulsación reescribiría todos sus códigos.
     */
    it('un código de barras distinto del SKU se respeta, aunque no coincida con Bsale', () => {
      const plan = planificarReparacion(
        [bsale({ barcode: '8595602559152' })],
        [shopify({ barcode: '7501234567890', costo: 55 })],
      );

      expect(plan.reparaciones).toHaveLength(0);
    });

    it('un código de barras puesto a mano no se sustituye ni estando vacío en Bsale', () => {
      const plan = planificarReparacion(
        [bsale({ barcode: null })],
        [shopify({ barcode: '7501234567890', costo: 55 })],
      );

      expect(plan.reparaciones).toHaveLength(0);
    });

    it('si Bsale no tiene código de barras, no se borra el de Shopify', () => {
      const plan = planificarReparacion([bsale({ barcode: null })], [shopify({ costo: 55 })]);

      expect(plan.reparaciones.some((r) => r.barcode !== undefined)).toBe(false);
    });

    it('un costo que ya existe se respeta', () => {
      const plan = planificarReparacion(
        [bsale({ barcode: null })],
        [shopify({ barcode: '7501234567890', costo: 42.5 })],
      );

      expect(plan.reparaciones).toHaveLength(0);
    });

    it('una variante de Shopify que no está en Bsale se ignora', () => {
      const plan = planificarReparacion([bsale()], [shopify({ sku: 'NO-EXISTE' })]);
      expect(plan.reparaciones).toHaveLength(0);
    });

    it('una variante sin SKU se ignora: no hay forma de saber cuál es', () => {
      const plan = planificarReparacion([bsale()], [shopify({ sku: null })]);
      expect(plan.reparaciones).toHaveLength(0);
    });

    it('una variante sin producto se ignora: la mutación exige el id del producto', () => {
      const plan = planificarReparacion([bsale()], [shopify({ productId: null })]);
      expect(plan.reparaciones).toHaveLength(0);
    });
  });

  it('marca el costo cuando falta o es cero', () => {
    const conNulo = planificarReparacion([bsale()], [shopify({ costo: null })]);
    const conCero = planificarReparacion([bsale()], [shopify({ costo: 0 })]);

    expect(conNulo.reparaciones[0]!.costo).toBeDefined();
    expect(conCero.reparaciones[0]!.costo).toBeDefined();
  });

  it('respeta el límite', () => {
    const muchos = Array.from({ length: 20 }, (_, i) => bsale({ sku: `S${i}` }));
    const enTienda = muchos.map((m, i) =>
      shopify({ id: `gid://v/${i}`, sku: m.sku, barcode: m.sku, productId: `gid://p/${i}` }),
    );

    expect(planificarReparacion(muchos, enTienda, 5).reparaciones).toHaveLength(5);
  });
});

describe('anadirCostosReparacion', () => {
  it('rellena el costo consultado en Bsale', async () => {
    const plan = planificarReparacion([bsale()], [shopify()]);

    await anadirCostosReparacion(plan, async () => 63.4);

    expect(plan.reparaciones[0]!.costo).toBe(63.4);
  });

  /**
   * Un cero en «Costo por artículo» no es «no lo sé»: Shopify lo lee como
   * «cuesta cero» y calcula un margen del 100 % sobre él.
   */
  it('nunca deja un costo de cero: si Bsale no lo tiene, quita el campo', async () => {
    const plan = planificarReparacion([bsale()], [shopify()]);

    await anadirCostosReparacion(plan, async () => null);

    expect(plan.reparaciones[0]!.costo).toBeUndefined();
  });

  it('descarta las reparaciones que se quedan sin nada que arreglar', async () => {
    // Código de barras correcto y sin costo en Bsale: no queda nada que hacer.
    const plan = planificarReparacion(
      [bsale({ barcode: null })],
      [shopify({ barcode: null, costo: null })],
    );
    expect(plan.reparaciones).toHaveLength(1);

    await anadirCostosReparacion(plan, async () => null);

    expect(plan.reparaciones).toHaveLength(0);
    expect(plan.resumen.total).toBe(0);
  });

  it('no pregunta por el costo de las que ya lo tienen', async () => {
    const obtener = vi.fn(async () => 10);
    const plan = planificarReparacion([bsale()], [shopify({ costo: 33 })]);

    await anadirCostosReparacion(plan, obtener);

    expect(obtener).not.toHaveBeenCalled();
  });
});

describe('aplicarReparacion', () => {
  function clienteFalso(ok = true) {
    return {
      repararVariantes: vi.fn(async () => ({ ok, errores: ok ? [] : ['Rechazado'] })),
    };
  }

  it('planificar no escribe; sólo aplicar lo hace', async () => {
    const client = clienteFalso();
    const plan = planificarReparacion([bsale()], [shopify()]);

    expect(client.repararVariantes).not.toHaveBeenCalled();

    await aplicarReparacion(client as never, plan);
    expect(client.repararVariantes).toHaveBeenCalledTimes(1);
  });

  it('manda el código de barras correcto, no el SKU', async () => {
    const client = clienteFalso();
    const plan = planificarReparacion([bsale()], [shopify()]);
    await anadirCostosReparacion(plan, async () => 63.4);

    await aplicarReparacion(client as never, plan);

    expect(client.repararVariantes).toHaveBeenCalledWith('gid://shopify/Product/1', [
      {
        variantId: 'gid://shopify/ProductVariant/1',
        barcode: '8595602559152',
        costo: 63.4,
      },
    ]);
  });

  it('agrupa por producto: la mutación no admite variantes de productos distintos', async () => {
    const client = clienteFalso();
    const catalogo = [bsale({ sku: 'A' }), bsale({ sku: 'B' }), bsale({ sku: 'C' })];
    const enTienda = [
      shopify({ id: 'gid://v/1', sku: 'A', barcode: 'A', productId: 'gid://p/1' }),
      shopify({ id: 'gid://v/2', sku: 'B', barcode: 'B', productId: 'gid://p/1' }),
      shopify({ id: 'gid://v/3', sku: 'C', barcode: 'C', productId: 'gid://p/2' }),
    ];
    const plan = planificarReparacion(catalogo, enTienda);

    await aplicarReparacion(client as never, plan);

    expect(client.repararVariantes).toHaveBeenCalledTimes(2);
  });

  it('un producto que falla no interrumpe los demás', async () => {
    let n = 0;
    const client = {
      repararVariantes: vi.fn(async () => {
        n++;
        if (n === 1) throw new Error('Timeout');
        return { ok: true, errores: [] };
      }),
    };
    const catalogo = [bsale({ sku: 'A' }), bsale({ sku: 'B' })];
    const enTienda = [
      shopify({ id: 'gid://v/1', sku: 'A', barcode: 'A', productId: 'gid://p/1' }),
      shopify({ id: 'gid://v/2', sku: 'B', barcode: 'B', productId: 'gid://p/2' }),
    ];
    const plan = planificarReparacion(catalogo, enTienda);

    const r = await aplicarReparacion(client as never, plan);

    expect(r.reparados).toBe(1);
    expect(r.fallidos).toBe(1);
  });

  it('cuenta los rechazos de Shopify como fallos', async () => {
    const client = clienteFalso(false);
    const plan = planificarReparacion([bsale()], [shopify()]);

    const r = await aplicarReparacion(client as never, plan);

    expect(r.reparados).toBe(0);
    expect(r.fallidos).toBe(1);
    expect(r.errores[0]!.mensaje).toContain('Rechazado');
  });
});
