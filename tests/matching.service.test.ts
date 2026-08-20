/**
 * Pruebas del emparejamiento Bsale ↔ Shopify.
 *
 * El caso que de verdad importa: **el código puede estar en `sku` o en
 * `barcode`**. Si la sincronización busca en el campo equivocado no da error,
 * simplemente no actualiza nada — y eso se descubre tarde. Aquí se fija que el
 * informe detecte cuál de los dos empareja.
 */
import { describe, expect, it } from 'vitest';
import { compararCatalogos, type CodigoBsale } from '../src/services/matching.service.js';
import type { ShopifyVariant } from '../src/integrations/shopify/client.js';

function b(sku: string, precio: number | null = 10, stock: number | null = 5): CodigoBsale {
  return { sku, bsaleVariantId: Number(sku.replace(/\D/g, '')) || 1, nombre: sku, precio, stock };
}

function s(
  id: string,
  campos: Partial<ShopifyVariant> = {},
): ShopifyVariant {
  return {
    id,
    sku: null,
    barcode: null,
    price: '10.00',
    inventoryQuantity: 5,
    inventoryItemId: `${id}-inv`,
    productId: `${id}-prod`,
    productTitle: 'Producto',
    title: 'Default',
    ...campos,
  };
}

describe('compararCatalogos', () => {
  describe('elección del campo', () => {
    it('recomienda sku cuando el código está en sku', () => {
      const informe = compararCatalogos(
        [b('74352029339543'), b('74352029347677')],
        [s('gid://1', { sku: '74352029339543' }), s('gid://2', { sku: '74352029347677' })],
      );

      expect(informe.campoRecomendado).toBe('sku');
      expect(informe.coincidenciasPorSku).toBe(2);
      expect(informe.coincidenciasPorBarcode).toBe(0);
      expect(informe.emparejados).toHaveLength(2);
    });

    it('recomienda barcode cuando el código está en barcode y el sku está vacío', () => {
      const informe = compararCatalogos(
        [b('74352029339543'), b('74352029347677')],
        [
          s('gid://1', { sku: null, barcode: '74352029339543' }),
          s('gid://2', { sku: '', barcode: '74352029347677' }),
        ],
      );

      expect(informe.campoRecomendado).toBe('barcode');
      expect(informe.coincidenciasPorBarcode).toBe(2);
      expect(informe.emparejados).toHaveLength(2);
      expect(informe.advertencias.join(' ')).toMatch(/código de barras/i);
    });

    it('elige el campo con más coincidencias cuando ambos tienen algo', () => {
      const informe = compararCatalogos(
        [b('A1'), b('A2'), b('A3')],
        [
          s('gid://1', { sku: 'A1', barcode: 'X' }),
          s('gid://2', { sku: 'OTRO', barcode: 'A2' }),
          s('gid://3', { sku: 'OTRO2', barcode: 'A3' }),
        ],
      );

      expect(informe.coincidenciasPorSku).toBe(1);
      expect(informe.coincidenciasPorBarcode).toBe(2);
      expect(informe.campoRecomendado).toBe('barcode');
    });

    it('avisa claramente cuando no empareja nada por ningún campo', () => {
      const informe = compararCatalogos(
        [b('A1'), b('A2')],
        [s('gid://1', { sku: 'ZZZ', barcode: 'YYY' })],
      );

      expect(informe.emparejados).toHaveLength(0);
      expect(informe.advertencias.join(' ')).toMatch(/Ningún código de Bsale coincide/i);
    });
  });

  describe('comparación de valores', () => {
    it('detecta diferencia de precio y de stock', () => {
      const informe = compararCatalogos(
        [b('A1', 25.5, 3)],
        [s('gid://1', { sku: 'A1', price: '20.00', inventoryQuantity: 7 })],
      );

      const e = informe.emparejados[0]!;
      expect(e.difierePrecio).toBe(true);
      expect(e.difiereStock).toBe(true);
      expect(informe.conDiferencias).toBe(1);
    });

    it('18 y 18.00 no son una diferencia de precio', () => {
      const informe = compararCatalogos(
        [b('A1', 18, 5)],
        [s('gid://1', { sku: 'A1', price: '18.00', inventoryQuantity: 5 })],
      );

      expect(informe.emparejados[0]!.difierePrecio).toBe(false);
      expect(informe.conDiferencias).toBe(0);
    });

    it('un dato ausente en Bsale no cuenta como diferencia', () => {
      const informe = compararCatalogos(
        [b('A1', null, null)],
        [s('gid://1', { sku: 'A1', price: '18.00', inventoryQuantity: 5 })],
      );

      const e = informe.emparejados[0]!;
      expect(e.difierePrecio).toBe(false);
      expect(e.difiereStock).toBe(false);
    });

    it('un stock de cero sí es una diferencia frente a uno de siete', () => {
      const informe = compararCatalogos(
        [b('A1', 10, 0)],
        [s('gid://1', { sku: 'A1', price: '10.00', inventoryQuantity: 7 })],
      );

      expect(informe.emparejados[0]!.difiereStock).toBe(true);
    });
  });

  describe('huérfanos', () => {
    it('separa los que sólo están en Bsale de los que sólo están en Shopify', () => {
      const informe = compararCatalogos(
        [b('A1'), b('SOLO-BSALE')],
        [s('gid://1', { sku: 'A1' }), s('gid://2', { sku: 'SOLO-SHOPIFY' })],
      );

      expect(informe.soloEnBsale).toEqual(['SOLO-BSALE']);
      expect(informe.soloEnShopify).toEqual(['solo-shopify']);
      expect(informe.advertencias.join(' ')).toMatch(/no aparecen en Shopify/i);
    });

    it('cuenta las variantes de Shopify sin código y avisa', () => {
      const informe = compararCatalogos(
        [b('A1')],
        [s('gid://1', { sku: 'A1' }), s('gid://2', { sku: null }), s('gid://3', { sku: '  ' })],
      );

      expect(informe.shopifySinCodigo).toBe(2);
      expect(informe.advertencias.join(' ')).toMatch(/no tienen SKU/i);
    });
  });

  describe('robustez', () => {
    it('empareja ignorando mayúsculas y espacios', () => {
      const informe = compararCatalogos([b(' ABC-1 ')], [s('gid://1', { sku: 'abc-1' })]);
      expect(informe.emparejados).toHaveLength(1);
    });

    it('si un código está repetido en Shopify se queda con la primera variante', () => {
      const informe = compararCatalogos(
        [b('A1')],
        [s('gid://1', { sku: 'A1' }), s('gid://2', { sku: 'A1' })],
      );

      expect(informe.emparejados).toHaveLength(1);
      expect(informe.emparejados[0]!.shopifyVariantId).toBe('gid://1');
    });

    it('las variantes de Bsale sin código no entran en el informe', () => {
      const informe = compararCatalogos(
        [b('A1'), { ...b('x'), sku: '' }],
        [s('gid://1', { sku: 'A1' })],
      );

      expect(informe.totalBsale).toBe(1);
      expect(informe.soloEnBsale).toHaveLength(0);
    });

    it('lleva el identificador de inventario, que es lo que la Fase 3 necesita para el stock', () => {
      const informe = compararCatalogos(
        [b('A1')],
        [s('gid://1', { sku: 'A1', inventoryItemId: 'gid://inv/99' })],
      );

      expect(informe.emparejados[0]!.shopifyInventoryItemId).toBe('gid://inv/99');
    });
  });
});

/**
 * ── El fallo de los SKU duplicados ──────────────────────────────────────────
 *
 * `soloEnBsale` es lo que el alta de productos usa para decidir qué crear. Si
 * ahí aparece algo que en realidad ya está en Shopify, se crea otra vez y queda
 * el SKU duplicado en la tienda.
 *
 * Pasaba porque la comparación miraba UN solo campo —el recomendado— e ignoraba
 * el otro. Un producto con el código en `barcode` y el `sku` vacío se daba por
 * ausente y se duplicaba.
 */
describe('no dar por ausente lo que ya está en Shopify', () => {
  it('un producto que en Shopify sólo tiene el código en barcode NO se propone para crear', () => {
    const informe = compararCatalogos(
      [b('AAA-1'), b('AAA-2'), b('SOLO-EN-BSALE')],
      [
        // Estos dos hacen que gane el SKU como campo recomendado.
        s('gid://1', { sku: 'AAA-1', barcode: null }),
        s('gid://2', { sku: 'AAA-2', barcode: null }),
        // Éste tiene el código en el otro campo. Antes se duplicaba.
        s('gid://3', { sku: null, barcode: 'SOLO-EN-BSALE' }),
      ],
    );

    expect(informe.campoRecomendado).toBe('sku');
    expect(informe.soloEnBsale).toEqual([]);
    expect(informe.rescatadosPorElOtroCampo).toBe(1);
  });

  it('y al revés: si gana barcode, uno que sólo tiene sku tampoco se propone', () => {
    const informe = compararCatalogos(
      [b('BBB-1'), b('BBB-2'), b('POR-SKU')],
      [
        s('gid://1', { sku: null, barcode: 'BBB-1' }),
        s('gid://2', { sku: null, barcode: 'BBB-2' }),
        s('gid://3', { sku: 'POR-SKU', barcode: null }),
      ],
    );

    expect(informe.campoRecomendado).toBe('barcode');
    expect(informe.soloEnBsale).toEqual([]);
    expect(informe.rescatadosPorElOtroCampo).toBe(1);
  });

  it('lo que de verdad no está sigue apareciendo como ausente', () => {
    const informe = compararCatalogos(
      [b('EXISTE'), b('NO-EXISTE')],
      [s('gid://1', { sku: 'EXISTE', barcode: null })],
    );

    expect(informe.soloEnBsale).toEqual(['NO-EXISTE']);
  });

  it('avisa de cuántos duplicados se han evitado', () => {
    // Dos por SKU y dos por código de barras: empate, y en el empate gana `sku`.
    // Los dos que sólo tienen código de barras son los rescatados.
    const informe = compararCatalogos(
      [b('A'), b('B'), b('C'), b('D')],
      [
        s('gid://1', { sku: 'A', barcode: null }),
        s('gid://2', { sku: 'B', barcode: null }),
        s('gid://3', { sku: null, barcode: 'C' }),
        s('gid://4', { sku: null, barcode: 'D' }),
      ],
    );

    expect(informe.campoRecomendado).toBe('sku');
    expect(informe.rescatadosPorElOtroCampo).toBe(2);
    expect(informe.advertencias.join(' ')).toMatch(/duplicados/i);
  });

  it('el emparejado apunta a la variante correcta, la que tenía el código', () => {
    const informe = compararCatalogos(
      [b('X'), b('RESCATADO')],
      [
        s('gid://1', { sku: 'X', barcode: null }),
        s('gid://rescatada', { sku: null, barcode: 'RESCATADO' }),
      ],
    );

    const encontrado = informe.emparejados.find((e) => e.codigo === 'RESCATADO');
    expect(encontrado?.shopifyVariantId).toBe('gid://rescatada');
  });

  it('una variante sin ninguno de los dos códigos sí cuenta como sin código', () => {
    const informe = compararCatalogos(
      [b('A')],
      [s('gid://1', { sku: 'A', barcode: null }), s('gid://2', { sku: null, barcode: null })],
    );

    expect(informe.shopifySinCodigo).toBe(1);
  });

  it('no marca como huérfano lo que está en Bsale por el otro campo', () => {
    const informe = compararCatalogos(
      [b('A'), b('POR-BARCODE')],
      [
        s('gid://1', { sku: 'A', barcode: null }),
        s('gid://2', { sku: null, barcode: 'POR-BARCODE' }),
      ],
    );

    expect(informe.soloEnShopify).toEqual([]);
  });
});
