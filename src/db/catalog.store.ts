/**
 * Almacén del catálogo leído de Bsale — Fase 2.
 *
 * Guarda en `ProductMap` lo que se ha leído: SKU, ids de Bsale, precio y stock.
 * Las columnas de Shopify (`shopifyVariantGid`, `shopifyPrice`, `shopifyStock`…)
 * **no se tocan**: las rellena la Fase 3 al emparejar y sincronizar. Un
 * `upsert` que las sobrescribiera con `null` borraría el emparejamiento cada
 * vez que alguien pulsara «Leer catálogo».
 *
 * Igual que `ConnectionStore`, el cliente de Prisma se recibe con un tipo
 * estructural mínimo en vez de importar `@prisma/client`. Así el typecheck
 * funciona antes de ejecutar `prisma generate` y las pruebas no necesitan el
 * paquete ni una base de datos.
 */

export interface ProductoGuardado {
  sku: string;
  /** Campo distinto del SKU. Ver el comentario en `ItemCatalogo`. */
  barcode: string | null;
  bsaleVariantId: number | null;
  bsaleProductId: number | null;
  name: string | null;
  bsalePrice: number | null;
  bsaleStock: number | null;
}

export interface CatalogStore {
  /** Inserta o actualiza. Devuelve cuántos registros se escribieron. */
  guardar(items: ProductoGuardado[]): Promise<number>;
  listar(): Promise<ProductoGuardado[]>;
  contar(): Promise<number>;
}

/** Para desarrollo sin base de datos y para las pruebas. */
export class InMemoryCatalogStore implements CatalogStore {
  private readonly filas = new Map<string, ProductoGuardado>();

  async guardar(items: ProductoGuardado[]): Promise<number> {
    for (const item of items) this.filas.set(item.sku, item);
    return items.length;
  }

  async listar(): Promise<ProductoGuardado[]> {
    return [...this.filas.values()];
  }

  async contar(): Promise<number> {
    return this.filas.size;
  }
}

interface ProductMapRow {
  sku: string;
  barcode: string | null;
  bsaleVariantId: number | null;
  bsaleProductId: number | null;
  name: string | null;
  bsalePrice: unknown;
  bsaleStock: number | null;
}

export interface PrismaCatalogLike {
  productMap: {
    upsert(args: {
      where: { sku: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
    findMany(args?: { orderBy?: { sku: 'asc' | 'desc' } }): Promise<ProductMapRow[]>;
    count(): Promise<number>;
  };
}

export class PrismaCatalogStore implements CatalogStore {
  constructor(private readonly prisma: PrismaCatalogLike) {}

  async guardar(items: ProductoGuardado[]): Promise<number> {
    let escritos = 0;
    // De uno en uno y en orden. `createMany` no permite actualizar, y lanzar
    // cientos de upserts en paralelo agota el pool de conexiones de Postgres —
    // el plan basic-256mb admite pocas simultáneas.
    for (const item of items) {
      // Las variantes sin SKU no se guardan: el SKU es la clave única de la
      // tabla y son justo las que el diagnóstico marca para corregir en Bsale.
      if (!item.sku.trim()) continue;

      const datos = {
        barcode: item.barcode,
        bsaleVariantId: item.bsaleVariantId,
        bsaleProductId: item.bsaleProductId,
        name: item.name,
        bsalePrice: item.bsalePrice,
        bsaleStock: item.bsaleStock,
      };

      await this.prisma.productMap.upsert({
        where: { sku: item.sku },
        create: { sku: item.sku, ...datos },
        // Sólo los campos de Bsale. Los de Shopify los mantiene la Fase 3.
        update: datos,
      });
      escritos++;
    }
    return escritos;
  }

  async listar(): Promise<ProductoGuardado[]> {
    const filas = await this.prisma.productMap.findMany({ orderBy: { sku: 'asc' } });
    return filas.map((f) => ({
      sku: f.sku,
      barcode: f.barcode,
      bsaleVariantId: f.bsaleVariantId,
      bsaleProductId: f.bsaleProductId,
      name: f.name,
      // Prisma devuelve Decimal; se normaliza a número para la API del panel.
      bsalePrice: f.bsalePrice == null ? null : Number(f.bsalePrice),
      bsaleStock: f.bsaleStock,
    }));
  }

  async contar(): Promise<number> {
    return this.prisma.productMap.count();
  }
}
