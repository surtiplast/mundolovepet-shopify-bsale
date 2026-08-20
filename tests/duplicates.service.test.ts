/**
 * Pruebas del informe de duplicados.
 *
 * Este informe no borra nada, así que el riesgo no es destruir: es **acusar en
 * falso**. Si marca como duplicado algo que no lo es, el comerciante borra un
 * producto legítimo fiándose de la app. Por eso la mayoría de estas pruebas
 * comprueban lo que NO debe aparecer en el informe.
 */
import { describe, expect, it } from 'vitest';
import { buscarDuplicados } from '../src/services/duplicates.service.js';
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
    ...campos,
  };
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
