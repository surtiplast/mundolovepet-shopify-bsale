/**
 * Pruebas del informe de duplicados.
 *
 * Este informe no borra nada, así que el riesgo no es destruir: es **acusar en
 * falso**. Si marca como duplicado algo que no lo es, el comerciante borra un
 * producto legítimo fiándose de la app. Por eso la mayoría de estas pruebas
 * comprueban lo que NO debe aparecer en el informe.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buscarDuplicados,
  planificarBorradoDuplicados,
  borrarDuplicados,
} from '../src/services/duplicates.service.js';
import type { ShopifyVariant } from '../src/integrations/shopify/client.js';

function v(id: string, campos: Partial<ShopifyVariant> = {}): ShopifyVariant {
  return {
    id,
    sku: null,
    barcode: null,
    price: '10.00',
    inventoryQuantity: 5,
    inventoryItemId: `${id}-inv`,
    costo: null,
    productId: `${id}-prod`,
    productTitle: 'Producto',
    title: 'Default',
    estado: 'ACTIVE',
    tieneImagen: true,
    variantesDelProducto: 1,
    ...campos,
  };
}

/** Una variante con la pinta exacta de las que crea la app: borrador, sin foto. */
function creadaPorLaApp(id: string, campos: Partial<ShopifyVariant> = {}): ShopifyVariant {
  return v(id, { estado: 'DRAFT', tieneImagen: false, ...campos });
}

describe('buscarDuplicados', () => {
  it('encuentra dos variantes con el mismo SKU', () => {
    const inf = buscarDuplicados([v('a', { sku: 'REPE' }), v('b', { sku: 'REPE' })]);

    expect(inf.grupos).toHaveLength(1);
    expect(inf.grupos[0]!.codigo).toBe('repe');
    expect(inf.grupos[0]!.variantes).toHaveLength(2);
    expect(inf.resumen.excedente).toBe(1);
  });

  it('también por código de barras', () => {
    const inf = buscarDuplicados([v('a', { barcode: 'EAN' }), v('b', { barcode: 'EAN' })]);

    expect(inf.grupos).toHaveLength(1);
    expect(inf.grupos[0]!.campo).toBe('barcode');
  });

  it('compara ignorando mayúsculas y espacios', () => {
    const inf = buscarDuplicados([v('a', { sku: ' Repe ' }), v('b', { sku: 'REPE' })]);
    expect(inf.grupos).toHaveLength(1);
  });

  describe('lo que NO debe señalar', () => {
    it('códigos distintos', () => {
      const inf = buscarDuplicados([v('a', { sku: 'UNO' }), v('b', { sku: 'DOS' })]);
      expect(inf.grupos).toEqual([]);
    });

    it('variantes sin ningún código', () => {
      const inf = buscarDuplicados([v('a'), v('b'), v('c')]);
      expect(inf.grupos).toEqual([]);
    });

    it('una sola variante con un código', () => {
      const inf = buscarDuplicados([v('a', { sku: 'SOLO' })]);
      expect(inf.grupos).toEqual([]);
    });

    /**
     * Los productos que la app creó antes del arreglo tienen el SKU copiado en
     * el código de barras. Eso NO es un duplicado: es una sola variante con el
     * mismo valor en dos campos.
     */
    it('una variante con el SKU repetido en su propio código de barras', () => {
      const inf = buscarDuplicados([v('a', { sku: 'X', barcode: 'X' })]);
      expect(inf.grupos).toEqual([]);
    });
  });

  /**
   * Antes, una variante con barcode===sku se excluía por completo de la
   * comparación por código de barras, pensando que evitaba un falso positivo
   * consigo misma. El efecto real era otro: si esa variante compartía su
   * código de barras con una OTRA variante de SKU distinto, esa colisión real
   * quedaba invisible. Es exactamente el patrón que deja el bug histórico que
   * este archivo documenta (SKU copiado al código de barras).
   */
  it('detecta un código de barras compartido aunque en una variante sea igual a su SKU', () => {
    const inf = buscarDuplicados([
      v('a', { sku: 'REPE', barcode: 'REPE' }),
      v('b', { sku: 'OTRO', barcode: 'REPE' }),
    ]);

    expect(inf.grupos).toHaveLength(1);
    expect(inf.grupos[0]!.codigo).toBe('repe');
    expect(inf.grupos[0]!.campo).toBe('barcode');
    expect(inf.grupos[0]!.variantes.map((x) => x.variantId).sort()).toEqual(['a', 'b']);
  });

  it('un choque por los dos campos sale UNA vez, marcado como «ambos»', () => {
    const inf = buscarDuplicados([
      v('a', { sku: 'CODIGO', barcode: 'OTRO' }),
      v('b', { sku: 'CODIGO', barcode: 'CODIGO' }),
    ]);

    const grupo = inf.grupos.find((g) => g.codigo === 'codigo');
    expect(grupo).toBeDefined();
    expect(grupo!.variantes).toHaveLength(2);
    // La misma variante no puede contarse dos veces dentro del grupo.
    expect(new Set(grupo!.variantes.map((x) => x.variantId)).size).toBe(2);
  });

  describe('la sospecha', () => {
    it('borrador y sin imagen puntúa 2: es lo que crea la app', () => {
      const inf = buscarDuplicados([
        v('original', { sku: 'X', estado: 'ACTIVE', tieneImagen: true }),
        v('creada', { sku: 'X', estado: 'DRAFT', tieneImagen: false }),
      ]);

      const creada = inf.grupos[0]!.variantes.find((x) => x.variantId === 'creada');
      const original = inf.grupos[0]!.variantes.find((x) => x.variantId === 'original');

      expect(creada!.sospecha).toBe(2);
      expect(original!.sospecha).toBe(0);
      expect(inf.resumen.sospechosas).toBe(1);
    });

    it('la más sospechosa aparece primero, para verla sin buscar', () => {
      const inf = buscarDuplicados([
        v('original', { sku: 'X', estado: 'ACTIVE', tieneImagen: true }),
        v('creada', { sku: 'X', estado: 'DRAFT', tieneImagen: false }),
      ]);

      expect(inf.grupos[0]!.variantes[0]!.variantId).toBe('creada');
    });

    it('un borrador con imagen puntúa 1: no está claro', () => {
      const inf = buscarDuplicados([
        v('a', { sku: 'X' }),
        v('b', { sku: 'X', estado: 'DRAFT', tieneImagen: true }),
      ]);

      const b = inf.grupos[0]!.variantes.find((x) => x.variantId === 'b');
      expect(b!.sospecha).toBe(1);
      // Y por tanto no se cuenta entre las que parecen creadas por la app.
      expect(inf.resumen.sospechosas).toBe(0);
    });
  });

  it('cuenta bien el excedente con tres repetidas', () => {
    const inf = buscarDuplicados([
      v('a', { sku: 'X' }),
      v('b', { sku: 'X' }),
      v('c', { sku: 'X' }),
    ]);

    expect(inf.resumen.codigosRepetidos).toBe(1);
    expect(inf.resumen.variantesImplicadas).toBe(3);
    // Una se queda; sobran dos.
    expect(inf.resumen.excedente).toBe(2);
  });

  it('los grupos peores salen primero', () => {
    const inf = buscarDuplicados([
      v('a', { sku: 'PAR' }),
      v('b', { sku: 'PAR' }),
      v('c', { sku: 'TRIO' }),
      v('d', { sku: 'TRIO' }),
      v('e', { sku: 'TRIO' }),
    ]);

    expect(inf.grupos[0]!.codigo).toBe('trio');
  });

  it('no lanza con un catálogo vacío', () => {
    expect(() => buscarDuplicados([])).not.toThrow();
    expect(buscarDuplicados([]).resumen.codigosRepetidos).toBe(0);
  });
});

/**
 * Pruebas del borrado.
 *
 * Aquí el riesgo cambia de naturaleza. El informe como mucho acusa en falso;
 * esto **borra productos de una tienda real y Shopify no tiene papelera**. Así
 * que casi todas las pruebas comprueban lo que NO se borra: un publicado, uno
 * con foto, uno que comparte producto con otra talla, y el último superviviente
 * de un código. Que borre lo que debe se comprueba una vez; que no borre lo que
 * no debe, muchas.
 */
describe('planificarBorradoDuplicados', () => {
  it('borra el sobrante cuando uno está publicado y el otro lo creó la app', () => {
    const informe = buscarDuplicados([
      v('bueno', { sku: 'REPE' }),
      creadaPorLaApp('copia', { sku: 'REPE' }),
    ]);
    const plan = planificarBorradoDuplicados(informe);

    expect(plan.candidatos).toHaveLength(1);
    expect(plan.candidatos[0]!.variantId).toBe('copia');
    expect(plan.candidatos[0]!.sobrevive.productId).toBe('bueno-prod');
  });

  it('no borra un producto publicado, por mucho que el código esté repetido', () => {
    const informe = buscarDuplicados([
      v('uno', { sku: 'REPE' }),
      v('dos', { sku: 'REPE' }),
    ]);
    const plan = planificarBorradoDuplicados(informe);

    expect(plan.candidatos).toHaveLength(0);
    expect(plan.intocables).toHaveLength(1);
  });

  it('no borra un borrador que tiene imagen: alguien pasó por ahí', () => {
    const informe = buscarDuplicados([
      v('bueno', { sku: 'REPE' }),
      creadaPorLaApp('conFoto', { sku: 'REPE', tieneImagen: true }),
    ]);

    expect(planificarBorradoDuplicados(informe).candidatos).toHaveLength(0);
  });

  it('no borra un producto de varias variantes: se llevaría la talla buena', () => {
    const informe = buscarDuplicados([
      v('bueno', { sku: 'REPE' }),
      creadaPorLaApp('multi', { sku: 'REPE', variantesDelProducto: 3 }),
    ]);

    expect(planificarBorradoDuplicados(informe).candidatos).toHaveLength(0);
  });

  it('no borra cuando no se sabe cuántas variantes tiene el producto', () => {
    const informe = buscarDuplicados([
      v('bueno', { sku: 'REPE' }),
      creadaPorLaApp('desconocido', { sku: 'REPE', variantesDelProducto: null }),
    ]);

    expect(planificarBorradoDuplicados(informe).candidatos).toHaveLength(0);
  });

  it('deja uno vivo aunque las tres sean borradores sin imagen', () => {
    const informe = buscarDuplicados([
      creadaPorLaApp('a', { sku: 'REPE' }),
      creadaPorLaApp('b', { sku: 'REPE' }),
      creadaPorLaApp('c', { sku: 'REPE' }),
    ]);
    const plan = planificarBorradoDuplicados(informe);

    expect(plan.candidatos).toHaveLength(2);
    expect(plan.resumen.aBorrar).toBe(2);
  });

  it('respeta el límite', () => {
    const informe = buscarDuplicados([
      v('bueno1', { sku: 'A' }),
      creadaPorLaApp('copia1', { sku: 'A' }),
      v('bueno2', { sku: 'B' }),
      creadaPorLaApp('copia2', { sku: 'B' }),
    ]);

    expect(planificarBorradoDuplicados(informe, 1).candidatos).toHaveLength(1);
  });

  it('explica por qué no toca un grupo, en vez de callarse', () => {
    const informe = buscarDuplicados([v('uno', { sku: 'REPE' }), v('dos', { sku: 'REPE' })]);
    const plan = planificarBorradoDuplicados(informe);

    expect(plan.intocables[0]!.motivo).toMatch(/mano/);
    expect(plan.intocables[0]!.variantes).toBe(2);
  });
});

describe('borrarDuplicados', () => {
  it('no pide dos veces el mismo producto aunque choque por los dos campos', async () => {
    const eliminar = vi.fn().mockResolvedValue({ ok: true, errores: [] });
    const plan = {
      candidatos: [
        { productId: 'p1', variantId: 'v1', titulo: null, sku: null, barcode: null, codigo: 'a', sobrevive: { productId: 'p9', titulo: null } },
        { productId: 'p1', variantId: 'v1', titulo: null, sku: null, barcode: null, codigo: 'b', sobrevive: { productId: 'p9', titulo: null } },
      ],
      intocables: [],
      resumen: { gruposRevisados: 2, aBorrar: 2, gruposIntocables: 0 },
    };

    const r = await borrarDuplicados(eliminar, plan);

    expect(eliminar).toHaveBeenCalledTimes(1);
    expect(r.borrados).toBe(1);
  });

  it('un producto que falla no arrastra a los demás', async () => {
    const eliminar = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errores: ['no se puede'] })
      .mockResolvedValueOnce({ ok: true, errores: [] });
    const plan = {
      candidatos: [
        { productId: 'p1', variantId: 'v1', titulo: null, sku: null, barcode: null, codigo: 'a', sobrevive: { productId: 'p9', titulo: null } },
        { productId: 'p2', variantId: 'v2', titulo: null, sku: null, barcode: null, codigo: 'b', sobrevive: { productId: 'p9', titulo: null } },
      ],
      intocables: [],
      resumen: { gruposRevisados: 2, aBorrar: 2, gruposIntocables: 0 },
    };

    const r = await borrarDuplicados(eliminar, plan);

    expect(r.borrados).toBe(1);
    expect(r.fallidos).toBe(1);
    expect(r.errores[0]!.mensaje).toBe('no se puede');
  });
});
