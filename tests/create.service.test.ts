/**
 * Pruebas del alta de productos en Shopify.
 *
 * Igual que en la sincronización, lo que más importa probar es lo que NO debe
 * pasar: que no se cree un producto sin nombre, ni uno gratis, ni uno publicado
 * sin que nadie lo revise.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  planificarCreacion,
  anadirCostos,
  crearProductos,
} from '../src/services/create.service.js';
import type { ProductoGuardado } from '../src/db/catalog.store.js';

function prod(over: Partial<ProductoGuardado> = {}): ProductoGuardado {
  return {
    sku: 'A-1',
    barcode: '8595602559152',
    bsaleVariantId: 1,
    bsaleProductId: 9,
    name: 'Producto de prueba',
    bsalePrice: 25.5,
    bsaleStock: 4,
    ...over,
  };
}

describe('planificarCreacion', () => {
  it('sólo propone los que faltan en Shopify', () => {
    const plan = planificarCreacion(
      [prod({ sku: 'FALTA' }), prod({ sku: 'YA-ESTA' })],
      ['FALTA'],
    );

    expect(plan.candidatos).toHaveLength(1);
    expect(plan.candidatos[0]!.sku).toBe('FALTA');
  });

  it('compara los códigos ignorando mayúsculas y espacios', () => {
    const plan = planificarCreacion([prod({ sku: 'ABC-1' })], [' abc-1 ']);
    expect(plan.candidatos).toHaveLength(1);
  });

  describe('lo que NO se crea', () => {
    it('un producto sin nombre: dejaría la tienda con títulos ilegibles', () => {
      const plan = planificarCreacion([prod({ sku: 'X', name: null })], ['X']);

      expect(plan.candidatos).toHaveLength(0);
      expect(plan.omitidos[0]!.motivo).toMatch(/nombre/i);
      expect(plan.resumen.sinNombre).toBe(1);
    });

    it('un producto con nombre en blanco tampoco', () => {
      const plan = planificarCreacion([prod({ sku: 'X', name: '   ' })], ['X']);
      expect(plan.candidatos).toHaveLength(0);
    });

    it('un producto sin precio: se publicaría gratis', () => {
      const plan = planificarCreacion([prod({ sku: 'X', bsalePrice: null })], ['X']);

      expect(plan.candidatos).toHaveLength(0);
      expect(plan.omitidos[0]!.motivo).toMatch(/precio/i);
    });

    it('un producto a precio cero tampoco', () => {
      const plan = planificarCreacion([prod({ sku: 'X', bsalePrice: 0 })], ['X']);
      expect(plan.candidatos).toHaveLength(0);
      expect(plan.resumen.sinPrecio).toBe(1);
    });
  });

  it('un stock nulo se convierte en cero: el producto nace agotado', () => {
    const plan = planificarCreacion([prod({ sku: 'X', bsaleStock: null })], ['X']);
    expect(plan.candidatos[0]!.stock).toBe(0);
  });

  it('respeta el límite, para probar con cinco antes de crear doscientos', () => {
    const muchos = Array.from({ length: 50 }, (_, i) => prod({ sku: `C${i}` }));
    const faltan = muchos.map((p) => p.sku);

    expect(planificarCreacion(muchos, faltan, 5).candidatos).toHaveLength(5);
    expect(planificarCreacion(muchos, faltan).candidatos).toHaveLength(50);
  });
});

describe('crearProductos', () => {
  function clienteFalso(ok = true) {
    return {
      crearProductoBorrador: vi.fn(async () => ({
        ok,
        productId: ok ? 'gid://shopify/Product/1' : null,
        errores: ok ? [] : ['Rechazado'],
      })),
    };
  }

  it('planificar no llama a la tienda; sólo crear lo hace', async () => {
    const client = clienteFalso();
    const plan = planificarCreacion([prod({ sku: 'X' })], ['X']);

    expect(client.crearProductoBorrador).not.toHaveBeenCalled();

    await crearProductos(client as never, plan, 'gid://loc/1');
    expect(client.crearProductoBorrador).toHaveBeenCalledTimes(1);
  });

  it('manda título, código, precio y stock', async () => {
    const client = clienteFalso();
    const plan = planificarCreacion(
      [prod({ sku: 'A-9', name: 'Collar rojo', bsalePrice: 19.9, bsaleStock: 3 })],
      ['A-9'],
    );

    await crearProductos(client as never, plan, 'gid://loc/7');

    expect(client.crearProductoBorrador).toHaveBeenCalledWith({
      titulo: 'Collar rojo',
      sku: 'A-9',
      barcode: '8595602559152',
      precio: 19.9,
      // `null` porque nadie ha llamado a `anadirCostos`: planificar no toca Bsale.
      costo: null,
      stock: 3,
      locationId: 'gid://loc/7',
    });
  });

  /**
   * El costo llega de una consulta aparte porque Bsale sólo lo da variante por
   * variante. Sin él el producto se crea igual: un costo ausente es un dato
   * informativo que falta, no un producto mal creado.
   */
  describe('costo', () => {
    it('manda el costo consultado en Bsale', async () => {
      const client = clienteFalso();
      const plan = planificarCreacion([prod({ sku: 'X', bsaleVariantId: 77 })], ['X']);
      await anadirCostos(plan, async () => 63.4);

      await crearProductos(client as never, plan, 'gid://loc/1');

      const enviado = client.crearProductoBorrador.mock.calls[0]![0] as { costo: number | null };
      expect(enviado.costo).toBe(63.4);
    });

    it('pide el costo por el id de variante de Bsale', async () => {
      const obtener = vi.fn(async () => 10);
      const plan = planificarCreacion([prod({ sku: 'X', bsaleVariantId: 4242 })], ['X']);

      await anadirCostos(plan, obtener);

      expect(obtener).toHaveBeenCalledWith(4242);
    });

    it('un producto sin costo en Bsale se crea igualmente, sin costo', async () => {
      const client = clienteFalso();
      const plan = planificarCreacion([prod({ sku: 'X' })], ['X']);
      const r = await anadirCostos(plan, async () => null);

      await crearProductos(client as never, plan, 'gid://loc/1');

      expect(r.sinCosto).toBe(1);
      const enviado = client.crearProductoBorrador.mock.calls[0]![0] as { costo: number | null };
      expect(enviado.costo).toBeNull();
    });

    it('planificar no consulta el costo: la simulación debe ser instantánea', () => {
      const plan = planificarCreacion([prod({ sku: 'X' })], ['X']);
      expect(plan.candidatos[0]!.costo).toBeNull();
    });
  });

  /**
   * El fallo que motivó estas pruebas: la versión anterior mandaba
   * `barcode: sku`. En Bsale son dos campos distintos —SKU 74352029961567 y
   * EAN 8595602559152— y copiar uno sobre otro borraba el EAN del fabricante.
   */
  describe('el código de barras nunca es el SKU', () => {
    it('manda el código de barras de Bsale, no el SKU', async () => {
      const client = clienteFalso();
      const plan = planificarCreacion(
        [prod({ sku: '74352029961567', barcode: '8595602559152' })],
        ['74352029961567'],
      );

      await crearProductos(client as never, plan, 'gid://loc/1');

      const enviado = client.crearProductoBorrador.mock.calls[0]![0] as {
        sku: string;
        barcode: string | null;
      };
      expect(enviado.sku).toBe('74352029961567');
      expect(enviado.barcode).toBe('8595602559152');
      expect(enviado.barcode).not.toBe(enviado.sku);
    });

    it('si Bsale no tiene código de barras se manda vacío, no el SKU', async () => {
      const client = clienteFalso();
      const plan = planificarCreacion([prod({ sku: 'X-1', barcode: null })], ['X-1']);

      await crearProductos(client as never, plan, 'gid://loc/1');

      const enviado = client.crearProductoBorrador.mock.calls[0]![0] as { barcode: string | null };
      expect(enviado.barcode).toBeNull();
    });

    it('un código de barras en blanco cuenta como ausente', () => {
      const plan = planificarCreacion([prod({ sku: 'X-1', barcode: '   ' })], ['X-1']);
      expect(plan.candidatos[0]!.barcode).toBeNull();
    });
  });

  it('cuenta creados y fallidos por separado', async () => {
    const client = clienteFalso(false);
    const plan = planificarCreacion([prod({ sku: 'X' })], ['X']);

    const r = await crearProductos(client as never, plan, 'gid://loc/1');

    expect(r.creados).toBe(0);
    expect(r.fallidos).toBe(1);
    expect(r.errores[0]!.sku).toBe('X');
  });

  it('un producto que falla no interrumpe los siguientes', async () => {
    let n = 0;
    const client = {
      crearProductoBorrador: vi.fn(async () => {
        n++;
        if (n === 2) throw new Error('Timeout');
        return { ok: true, productId: `gid://p/${n}`, errores: [] };
      }),
    };
    const productos = [prod({ sku: 'A' }), prod({ sku: 'B' }), prod({ sku: 'C' })];
    const plan = planificarCreacion(productos, ['A', 'B', 'C']);

    const r = await crearProductos(client as never, plan, 'gid://loc/1');

    expect(r.creados).toBe(2);
    expect(r.fallidos).toBe(1);
    expect(r.errores[0]!.sku).toBe('B');
  });

  it('devuelve los identificadores de lo creado, para poder revisarlo después', async () => {
    const client = clienteFalso();
    const plan = planificarCreacion([prod({ sku: 'X' })], ['X']);

    const r = await crearProductos(client as never, plan, 'gid://loc/1');
    expect(r.ids).toEqual(['gid://shopify/Product/1']);
  });
});

/**
 * La red de seguridad. Aunque el informe diga que un producto falta, si su
 * código ya está en Shopify no se crea: un duplicado hay que buscarlo y
 * borrarlo a mano, mientras que no crear algo se arregla con otra pulsación.
 */
describe('nunca crear algo cuyo código ya está en Shopify', () => {
  it('lo omite aunque venga marcado como ausente', () => {
    const plan = planificarCreacion(
      [prod({ sku: 'YA-ESTA' })],
      ['YA-ESTA'],
      undefined,
      new Set(['ya-esta']),
    );

    expect(plan.candidatos).toHaveLength(0);
    expect(plan.omitidos[0]!.motivo).toMatch(/ya existe/i);
    expect(plan.resumen.yaExistian).toBe(1);
  });

  it('sirve tanto si el código está en el SKU como en el código de barras', () => {
    // El conjunto lleva los códigos de LOS DOS campos, ya normalizados.
    const plan = planificarCreacion(
      [prod({ sku: 'POR-BARCODE' })],
      ['POR-BARCODE'],
      undefined,
      new Set(['por-barcode']),
    );

    expect(plan.candidatos).toHaveLength(0);
  });

  it('los que de verdad faltan se siguen creando', () => {
    const plan = planificarCreacion(
      [prod({ sku: 'FALTA' }), prod({ sku: 'ESTA' })],
      ['FALTA', 'ESTA'],
      undefined,
      new Set(['esta']),
    );

    expect(plan.candidatos.map((c) => c.sku)).toEqual(['FALTA']);
  });

  it('sin el conjunto se comporta como antes: no rompe nada', () => {
    const plan = planificarCreacion([prod({ sku: 'X' })], ['X']);
    expect(plan.candidatos).toHaveLength(1);
  });
});
