/**
 * Sincronización Bsale → Shopify — Fase 3.
 *
 * ── La regla que gobierna este archivo ───────────────────────────────────────
 *
 * **Simular es lo predeterminado. Escribir hay que pedirlo explícitamente.**
 *
 * Este es el primer código del proyecto que modifica la tienda del cliente. Un
 * error aquí no se arregla con un despliegue: habría que revertir a mano miles
 * de precios o de existencias. Por eso `planificar()` nunca escribe, y
 * `aplicar()` recibe el plan ya calculado y revisado.
 *
 * ── Por qué stock y precios van separados ────────────────────────────────────
 *
 * Tienen riesgos distintos. Corregir el stock es urgente y seguro: si Shopify
 * dice 15 y no tienes ninguno, cada venta es un pedido que no puedes despachar.
 * Cambiar precios es delicado: un decimal mal puesto se ve en la tienda al
 * instante y puede vender a pérdida.
 *
 * Mezclarlos obligaría a aceptar el riesgo del precio para arreglar el stock.
 */
import type {
  ShopifyClient,
  CambioInventario,
  ResultadoEscritura,
} from '../integrations/shopify/client.js';
import type { Emparejado } from './matching.service.js';

export type TipoSync = 'STOCK' | 'PRECIO';

export interface CambioPlanificado {
  codigo: string;
  shopifyVariantId: string;
  shopifyProductId: string | null;
  shopifyInventoryItemId: string | null;
  nombre: string | null;
  /** Lo que hay ahora en Shopify. Se guarda para poder revertir. */
  valorAnterior: number | null;
  /** Lo que dice Bsale y se va a escribir. */
  valorNuevo: number;
}

export interface PlanSync {
  tipo: TipoSync;
  cambios: CambioPlanificado[];
  /** Emparejados que no se pueden tocar, con el motivo. */
  omitidos: Array<{ codigo: string; motivo: string }>;
  resumen: {
    total: number;
    /** Sólo para stock: cuántos productos quedarían agotados. */
    seAgotan: number;
    /** Sólo para stock: cuántos vuelven a tener existencias. */
    seReponen: number;
    /** Sólo para precio: cuántos suben y cuántos bajan. */
    suben: number;
    bajan: number;
    /** El mayor salto, para detectar de un vistazo un error de configuración. */
    mayorSalto: CambioPlanificado | null;
  };
}

export interface ResultadoAplicacion {
  aplicados: number;
  fallidos: number;
  errores: Array<{ codigo: string; mensaje: string }>;
}

/**
 * Calcula qué cambiaría. **No escribe nada.**
 *
 * `limite` existe para la primera vez: aplicar 3.000 cambios de golpe sin haber
 * visto ninguno funcionar es una apuesta innecesaria. Con un límite bajo se
 * comprueban diez, se miran en la tienda, y luego se quita.
 */
export function planificar(
  emparejados: Emparejado[],
  tipo: TipoSync,
  limite?: number,
): PlanSync {
  const cambios: CambioPlanificado[] = [];
  const omitidos: Array<{ codigo: string; motivo: string }> = [];

  for (const e of emparejados) {
    if (limite !== undefined && cambios.length >= limite) break;

    if (tipo === 'STOCK') {
      if (!e.difiereStock) continue;
      if (e.stockBsale === null) {
        omitidos.push({ codigo: e.codigo, motivo: 'Sin stock en Bsale' });
        continue;
      }
      if (!e.shopifyInventoryItemId) {
        // Sin el identificador de inventario no hay dónde escribir. Pasa con
        // variantes que no tienen el inventario gestionado por Shopify.
        omitidos.push({ codigo: e.codigo, motivo: 'La variante no gestiona inventario' });
        continue;
      }
      cambios.push({
        codigo: e.codigo,
        shopifyVariantId: e.shopifyVariantId,
        shopifyProductId: null,
        shopifyInventoryItemId: e.shopifyInventoryItemId,
        nombre: e.nombreShopify,
        valorAnterior: e.stockShopify,
        valorNuevo: e.stockBsale,
      });
    } else {
      if (!e.difierePrecio) continue;
      if (e.precioBsale === null) {
        omitidos.push({ codigo: e.codigo, motivo: 'Sin precio en Bsale' });
        continue;
      }
      if (e.precioBsale <= 0) {
        // Un precio de cero publicado en Shopify es un producto gratis. Nunca
        // se escribe automáticamente: casi siempre es un dato sin cargar.
        omitidos.push({ codigo: e.codigo, motivo: 'Precio cero o negativo en Bsale' });
        continue;
      }
      cambios.push({
        codigo: e.codigo,
        shopifyVariantId: e.shopifyVariantId,
        shopifyProductId: null,
        shopifyInventoryItemId: null,
        nombre: e.nombreShopify,
        valorAnterior: e.precioShopify,
        valorNuevo: e.precioBsale,
      });
    }
  }

  const seAgotan = cambios.filter((c) => c.valorNuevo === 0 && (c.valorAnterior ?? 0) > 0).length;
  const seReponen = cambios.filter((c) => c.valorNuevo > 0 && (c.valorAnterior ?? 0) === 0).length;
  const suben = cambios.filter((c) => c.valorAnterior != null && c.valorNuevo > c.valorAnterior).length;
  const bajan = cambios.filter((c) => c.valorAnterior != null && c.valorNuevo < c.valorAnterior).length;

  const mayorSalto = cambios.reduce<CambioPlanificado | null>((peor, c) => {
    if (c.valorAnterior == null) return peor;
    const salto = Math.abs(c.valorNuevo - c.valorAnterior);
    const saltoPeor = peor?.valorAnterior == null ? -1 : Math.abs(peor.valorNuevo - peor.valorAnterior);
    return salto > saltoPeor ? c : peor;
  }, null);

  return {
    tipo,
    cambios,
    omitidos,
    resumen: { total: cambios.length, seAgotan, seReponen, suben, bajan, mayorSalto },
  };
}

/**
 * Aplica un plan ya calculado. **Esto sí escribe en la tienda.**
 *
 * El plan se pasa entero en vez de recalcularlo dentro: así lo que se aplica es
 * exactamente lo que se revisó, y no una lectura nueva que pudo cambiar entre
 * medias.
 */
export async function aplicarStock(
  client: ShopifyClient,
  plan: PlanSync,
  locationId: string,
  tamanoLote = 100,
): Promise<ResultadoAplicacion> {
  if (plan.tipo !== 'STOCK') {
    throw new Error('aplicarStock recibió un plan que no es de stock.');
  }

  const resultado: ResultadoAplicacion = { aplicados: 0, fallidos: 0, errores: [] };

  // Por lotes: una sola llamada con miles de artículos supera el coste máximo
  // de consulta de Shopify y la rechaza entera.
  for (let i = 0; i < plan.cambios.length; i += tamanoLote) {
    const lote = plan.cambios.slice(i, i + tamanoLote);
    const cambios: CambioInventario[] = lote
      // Sin `valorAnterior` no se puede mandar `changeFromQuantity`, que la API
      // exige. Se descarta ese cambio en vez de inventarse un cero.
      .filter((c) => c.shopifyInventoryItemId && c.valorAnterior !== null)
      .map((c) => ({
        inventoryItemId: c.shopifyInventoryItemId!,
        locationId,
        cantidad: c.valorNuevo,
        desde: c.valorAnterior!,
      }));

    try {
      const r: ResultadoEscritura = await client.fijarInventario(cambios);
      if (r.ok) {
        resultado.aplicados += lote.length;
      } else {
        resultado.fallidos += lote.length;
        // El error es del lote entero: se anota una vez con su alcance, no una
        // por producto, para que la lista de errores siga siendo legible.
        resultado.errores.push({
          codigo: `lote ${i + 1}–${i + lote.length}`,
          mensaje: r.errores.join(' | '),
        });
      }
    } catch (error) {
      resultado.fallidos += lote.length;
      resultado.errores.push({
        codigo: `lote ${i + 1}–${i + lote.length}`,
        mensaje: (error as Error).message,
      });
    }
  }

  return resultado;
}

/**
 * Aplica los precios.
 *
 * Se agrupan por producto porque `productVariantsBulkUpdate` sólo admite
 * variantes de un mismo producto por llamada.
 */
export async function aplicarPrecios(
  client: ShopifyClient,
  plan: PlanSync,
  productIdPorVariante: Map<string, string>,
): Promise<ResultadoAplicacion> {
  if (plan.tipo !== 'PRECIO') {
    throw new Error('aplicarPrecios recibió un plan que no es de precios.');
  }

  const resultado: ResultadoAplicacion = { aplicados: 0, fallidos: 0, errores: [] };

  const porProducto = new Map<string, CambioPlanificado[]>();
  for (const c of plan.cambios) {
    const productId = c.shopifyProductId ?? productIdPorVariante.get(c.shopifyVariantId);
    if (!productId) {
      resultado.fallidos++;
      resultado.errores.push({ codigo: c.codigo, mensaje: 'No se conoce el producto de la variante.' });
      continue;
    }
    const lista = porProducto.get(productId) ?? [];
    lista.push(c);
    porProducto.set(productId, lista);
  }

  for (const [productId, cambios] of porProducto) {
    try {
      const r = await client.actualizarPrecios(
        productId,
        cambios.map((c) => ({
          variantId: c.shopifyVariantId,
          // Shopify espera el precio como cadena con dos decimales.
          precio: c.valorNuevo.toFixed(2),
        })),
      );
      if (r.ok) {
        resultado.aplicados += cambios.length;
      } else {
        resultado.fallidos += cambios.length;
        resultado.errores.push({ codigo: cambios[0]!.codigo, mensaje: r.errores.join(' | ') });
      }
    } catch (error) {
      resultado.fallidos += cambios.length;
      resultado.errores.push({ codigo: cambios[0]!.codigo, mensaje: (error as Error).message });
    }
  }

  return resultado;
}
