/**
 * Prueba de carga — Fase 9.
 *
 * El catálogo real de Mundo Love Pet tiene unas 3.300 variantes. Todas las
 * demás pruebas usan catálogos pequeños a propósito, para que el fallo que
 * señalan se vea de un vistazo — pero eso deja sin probar que el camino
 * completo (comparar catálogos → planificar → aplicar) siga siendo correcto
 * y razonablemente rápido a ese tamaño real, no sólo con diez productos.
 *
 * Lo que esto haría notar que las pruebas pequeñas no notarían: un
 * `.find()` o un bucle anidado que conviertan la comparación en O(n²) —
 * correcto con 10 productos, perceptiblemente lento con 3.300.
 */
import { describe, expect, it, vi } from 'vitest';
import { compararCatalogos, type CodigoBsale } from '../src/services/matching.service.js';
import { planificar, aplicarStock, aplicarPrecios } from '../src/services/sync.service.js';
import type { ShopifyVariant } from '../src/integrations/shopify/client.js';

const TOTAL = 3300;

/** La mitad de las variantes difiere en stock; la otra mitad no. Así el plan
 * resultante también es grande, no sólo el catálogo de entrada. */
function catalogoDePrueba() {
  const bsale: CodigoBsale[] = [];
  const shopify: ShopifyVariant[] = [];

  for (let i = 0; i < TOTAL; i++) {
    const sku = `SKU-${i}`;
    const difiere = i % 2 === 0;
    bsale.push({ sku, bsaleVariantId: i + 1, nombre: `Producto ${i}`, precio: 10, stock: difiere ? 3 : 5 });
    shopify.push({
      id: `gid://shopify/ProductVariant/${i}`,
      sku,
      barcode: null,
      price: '10.00',
      inventoryQuantity: 5,
      inventoryItemId: `gid://inv/${i}`,
      productId: `gid://prod/${Math.floor(i / 20)}`, // 20 variantes por producto, como en la tienda real
      productTitle: `Producto ${i}`,
      title: 'Default',
    });
  }

  return { bsale, shopify };
}

describe('carga: catálogo a escala real (~3.300 variantes)', () => {
  it('compararCatalogos empareja las 3.300 sin perder ninguna, en menos de dos segundos', () => {
    const { bsale, shopify } = catalogoDePrueba();

    const inicio = Date.now();
    const informe = compararCatalogos(bsale, shopify);
    const segundos = (Date.now() - inicio) / 1000;

    expect(informe.emparejados).toHaveLength(TOTAL);
    expect(informe.soloEnBsale).toHaveLength(0);
    expect(informe.soloEnShopify).toHaveLength(0);
    expect(informe.conDiferencias).toBe(TOTAL / 2);
    // No es un benchmark preciso —la máquina que corre esto varía—, es una
    // red de seguridad contra un O(n²) que convertiría dos segundos en dos
    // minutos. Ver el comentario de arriba del archivo.
    expect(segundos).toBeLessThan(2);
  });

  it('planificar + aplicarStock procesan el plan completo en lotes, sin perder ni duplicar ninguno', async () => {
    const { bsale, shopify } = catalogoDePrueba();
    const { emparejados } = compararCatalogos(bsale, shopify);
    const plan = planificar(emparejados, 'STOCK');

    expect(plan.cambios).toHaveLength(TOTAL / 2);

    const client = { fijarInventario: vi.fn(async () => ({ ok: true, errores: [] })) };
    const r = await aplicarStock(client as never, plan, 'gid://loc/1');

    expect(r.aplicados).toBe(TOTAL / 2);
    expect(r.fallidos).toBe(0);
    // 100 por lote (el tamaño por defecto): con 1.650 cambios, 17 lotes.
    expect(client.fijarInventario).toHaveBeenCalledTimes(17);
  });

  it('planificar + aplicarPrecios agrupan por producto sin perder variantes', async () => {
    const { bsale, shopify } = catalogoDePrueba();
    // Para precios hace falta que también difiera el precio, no sólo el stock.
    const bsaleConPrecio = bsale.map((b, i) => ({ ...b, precio: i % 2 === 0 ? 15 : 10 }));
    const { emparejados } = compararCatalogos(bsaleConPrecio, shopify);
    const plan = planificar(emparejados, 'PRECIO');

    expect(plan.cambios).toHaveLength(TOTAL / 2);

    const productoPorVariante = new Map(
      shopify.map((v) => [v.id, v.productId]),
    );
    const client = { actualizarPrecios: vi.fn(async () => ({ ok: true, errores: [] })) };
    const r = await aplicarPrecios(client as never, plan, productoPorVariante as never);

    expect(r.aplicados).toBe(TOTAL / 2);
    expect(r.fallidos).toBe(0);
  });
});
