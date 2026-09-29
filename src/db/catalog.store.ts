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
  /** La marca de Bsale. Va al campo «Proveedor» de Shopify. */
  brand: string | null;
  bsaleVariantId: number | null;
  bsaleProductId: number | null;
  name: string | null;
  bsalePrice: number | null;
  bsaleStock: number | null;
  /**
   * Caché del costo de Bsale. `null` significa «se consultó y Bsale no
   * tiene», no «nunca se consultó» — eso lo distingue `costoRevisadoEl`.
   * Ver `services/costo-cache.service.ts`.
   */
  bsaleCosto: number | null;
  costoRevisadoEl: Date | null;
}

/** Lo que deja el caché de costos tras consultar Bsale, listo para guardar. */
export interface ActualizacionCosto {
  sku: string;
  bsaleCosto: number | null;
}

/**
 * Lo que trae un catálogo recién leído de Bsale. Sin `bsaleCosto` ni
 * `costoRevisadoEl` a propósito: `guardar()` nunca los toca —Bsale no da el
 * costo en la lectura masiva del catálogo—, así que no tiene sentido pedirle
 * a quien llama que invente un valor para ellos.
 */
export type ItemDeCatalogo = Omit<ProductoGuardado, 'bsaleCosto' | 'costoRevisadoEl'>;

export interface CatalogStore {
  /** Inserta o actualiza. Devuelve cuántos registros se escribieron. */
  guardar(items: ItemDeCatalogo[]): Promise<number>;
  listar(): Promise<ProductoGuardado[]>;
  contar(): Promise<number>;
  /** Guarda el resultado de haberle preguntado a Bsale por un costo, con la
   * fecha de ahora mismo — es lo que hace que el caché tenga vencimiento. */
  actualizarCostos(actualizaciones: ActualizacionCosto[]): Promise<void>;
}

/** Para desarrollo sin base de datos y para las pruebas. */
export class InMemoryCatalogStore implements CatalogStore {
  private readonly filas = new Map<string, ProductoGuardado>();

  async guardar(items: ItemDeCatalogo[]): Promise<number> {
    for (const item of items) {
      // guardar() nunca toca el caché de costo: lo llena y lo vence
      // actualizarCostos(), igual que las columnas de Shopify las llena la
      // Fase 3 y no un nuevo «Leer catálogo».
      const anterior = this.filas.get(item.sku);
      this.filas.set(item.sku, {
        ...item,
        bsaleCosto: anterior?.bsaleCosto ?? null,
        costoRevisadoEl: anterior?.costoRevisadoEl ?? null,
      });
    }
    return items.length;
  }

  async listar(): Promise<ProductoGuardado[]> {
    return [...this.filas.values()];
  }

  async contar(): Promise<number> {
    return this.filas.size;
  }

  async actualizarCostos(actualizaciones: ActualizacionCosto[]): Promise<void> {
    const ahora = new Date();
    for (const a of actualizaciones) {
      const fila = this.filas.get(a.sku);
      if (!fila) continue;
      this.filas.set(a.sku, { ...fila, bsaleCosto: a.bsaleCosto, costoRevisadoEl: ahora });
    }
  }
}

interface ProductMapRow {
  sku: string;
  barcode: string | null;
  brand: string | null;
  bsaleVariantId: number | null;
  bsaleProductId: number | null;
  name: string | null;
  bsalePrice: unknown;
  bsaleStock: number | null;
  bsaleCosto: unknown;
  costoRevisadoEl: Date | null;
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
    update(args: { where: { sku: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

export class PrismaCatalogStore implements CatalogStore {
  constructor(private readonly prisma: PrismaCatalogLike) {}

  async guardar(items: ItemDeCatalogo[]): Promise<number> {
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
        brand: item.brand,
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
      brand: f.brand,
      bsaleVariantId: f.bsaleVariantId,
      bsaleProductId: f.bsaleProductId,
      name: f.name,
      // Prisma devuelve Decimal; se normaliza a número para la API del panel.
      bsalePrice: f.bsalePrice == null ? null : Number(f.bsalePrice),
      bsaleStock: f.bsaleStock,
      bsaleCosto: f.bsaleCosto == null ? null : Number(f.bsaleCosto),
      costoRevisadoEl: f.costoRevisadoEl,
    }));
  }

  async contar(): Promise<number> {
    return this.prisma.productMap.count();
  }

  async actualizarCostos(actualizaciones: ActualizacionCosto[]): Promise<void> {
    // De uno en uno, igual que guardar(): el pool de conexiones del plan
    // básico no admite cientos de escrituras en paralelo.
    for (const a of actualizaciones) {
      await this.prisma.productMap.update({
        where: { sku: a.sku },
        data: { bsaleCosto: a.bsaleCosto, costoRevisadoEl: new Date() },
      });
    }
  }
}
