/**
 * Reparación de productos ya creados con datos incorrectos.
 *
 * ── Qué arregla y por qué existe ─────────────────────────────────────────────
 *
 * Una versión anterior del alta de productos copiaba el SKU en el campo «código
 * de barras» de Shopify, dando por hecho que en Bsale había un único código. No
 * lo hay: la variante tiene `code` (SKU interno) y `barCode` (el EAN del
 * fabricante), y son distintos. Además nunca se mandaba el costo, así que todos
 * los productos creados quedaron con «Costo por artículo» vacío.
 *
 * El alta ya está corregida, pero los productos creados antes siguen mal en la
 * tienda. Esto los arregla sin volver a crearlos.
 *
 * ── La regla conservadora ────────────────────────────────────────────────────
 *
 * El código de barras SÓLO se toca cuando en Shopify vale exactamente lo mismo
 * que el SKU. Esa igualdad es la huella del fallo, y ningún comerciante escribe
 * a mano un código de barras idéntico al SKU.
 *
 * La alternativa —«si difiere de Bsale, píselo»— sería mucho más destructiva:
 * en esta tienda hay 3.041 productos anteriores a la app cuyos códigos puso
 * alguien a mano, y una reparación demasiado ambiciosa los machacaría todos.
 * Ante la duda, no se toca: un dato dudoso que se conserva se puede revisar
 * después, uno que se sobrescribe se ha perdido.
 *
 * El costo sigue el mismo criterio: sólo se rellena si en Shopify falta o es
 * cero. Un costo que alguien puso a mano se respeta.
 */
import type { ShopifyClient, ShopifyVariant } from '../integrations/shopify/client.js';
import type { ProductoGuardado } from '../db/catalog.store.js';
import { normalizarSku } from './catalog.service.js';
import { logger } from '../lib/logger.js';
import type { CallbackProgreso } from '../lib/progreso.js';

export interface Reparacion {
  sku: string;
  variantId: string;
  productId: string;
  bsaleVariantId: number | null;
  /** El código de barras correcto. `undefined` si este campo no hay que tocarlo. */
  barcode?: string;
  /** El valor que había, para poder explicarlo en el informe. */
  barcodeAnterior?: string | null;
  /** El costo correcto. `undefined` si no hay que tocarlo o si Bsale no lo tiene. */
  costo?: number;
}

/**
 * Qué campos se van a reparar en esta pasada.
 *
 * Existen por separado porque cuestan cosas muy distintas. El código de barras
 * sale del catálogo que ya está en la base de datos: planificarlo es
 * instantáneo. El costo hay que pedírselo a Bsale variante por variante, y eso
 * son decenas de segundos aunque al final no haya nada que cambiar.
 *
 * Juntarlos en un solo botón obligaba a pagar siempre el precio del costo,
 * incluso cuando lo único que se quería arreglar era el código de barras.
 */
export interface CamposReparacion {
  barcode: boolean;
  costo: boolean;
}

export const TODOS_LOS_CAMPOS: CamposReparacion = { barcode: true, costo: true };

export interface PlanReparacion {
  campos: CamposReparacion;
  reparaciones: Reparacion[];
  resumen: {
    total: number;
    codigoDeBarras: number;
    costo: number;
    revisados: number;
    /**
     * Variantes con la huella del fallo —código de barras igual al SKU— que aun
     * así no se pueden arreglar, porque en el catálogo leído de Bsale esa
     * variante no tiene `barCode`.
     *
     * Este contador existe porque su ausencia costaba confianza: el panel decía
     * «reparados 218» sobre 3.282 revisados y no explicaba los otros 3.000. No
     * estaban fallando; es que Bsale no tiene el dato. Verlo escrito evita
     * pulsar el botón una y otra vez esperando un número distinto.
     */
    sinCodigoEnBsale: number;
  };
}

export interface ResultadoReparacion {
  reparados: number;
  fallidos: number;
  errores: Array<{ sku: string; mensaje: string }>;
  /** Las reparaciones que de verdad se escribieron, para el registro de cambios. */
  reparacionesAplicadas: Reparacion[];
}

/**
 * Decide qué hay que arreglar. **No escribe nada y no llama a Bsale.**
 *
 * El costo se rellena después con `anadirCostosReparacion`, por el mismo motivo
 * que en el alta: Bsale sólo lo da variante por variante.
 */
export function planificarReparacion(
  catalogo: ProductoGuardado[],
  variantes: ShopifyVariant[],
  limite?: number,
  campos: CamposReparacion = TODOS_LOS_CAMPOS,
): PlanReparacion {
  const porSku = new Map<string, ProductoGuardado>();
  for (const p of catalogo) {
    const clave = normalizarSku(p.sku);
    if (clave) porSku.set(clave, p);
  }

  const reparaciones: Reparacion[] = [];
  let revisados = 0;
  let sinCodigoEnBsale = 0;

  for (const v of variantes) {
    if (limite !== undefined && reparaciones.length >= limite) break;

    const clave = normalizarSku(v.sku);
    if (!clave) continue;

    const bsale = porSku.get(clave);
    if (!bsale) continue;
    revisados++;

    const reparacion: Reparacion = {
      sku: v.sku ?? clave,
      variantId: v.id,
      productId: v.productId ?? '',
      bsaleVariantId: bsale.bsaleVariantId,
    };

    // ── Código de barras ────────────────────────────────────────────────────
    const barcodeBsale = bsale.barcode?.trim() || null;
    const barcodeShopify = v.barcode?.trim() || null;
    const esLaHuellaDelFallo =
      barcodeShopify !== null && normalizarSku(barcodeShopify) === clave;

    if (esLaHuellaDelFallo) {
      if (barcodeBsale && normalizarSku(barcodeBsale) !== clave) {
        if (campos.barcode) {
          reparacion.barcode = barcodeBsale;
          reparacion.barcodeAnterior = barcodeShopify;
        }
      } else {
        // Lleva la huella del fallo pero Bsale no tiene un EAN distinto que
        // poner. No se toca: se deja el SKU antes que dejar el campo vacío o
        // inventar un código, que un lector daría por bueno.
        sinCodigoEnBsale++;
      }
    }

    // ── Costo ───────────────────────────────────────────────────────────────
    // Se marca el hueco; el valor lo pone `anadirCostosReparacion`. Marcarlo
    // aquí evita preguntar a Bsale por los que ya tienen costo.
    const faltaElCosto = campos.costo && (v.costo === null || v.costo === 0);

    // Sin producto no se puede llamar a la mutación: exige el id del producto.
    if (!reparacion.productId) continue;

    if (reparacion.barcode !== undefined || faltaElCosto) {
      // `costo: 0` es la marca de «hay que consultarlo». Se limpia si Bsale no
      // lo tiene, y ninguna reparación llega a Shopify con un costo de cero.
      if (faltaElCosto) reparacion.costo = 0;
      reparaciones.push(reparacion);
    }
  }

  return {
    campos,
    reparaciones,
    resumen: {
      total: reparaciones.length,
      codigoDeBarras: reparaciones.filter((r) => r.barcode !== undefined).length,
      costo: reparaciones.filter((r) => r.costo !== undefined).length,
      revisados,
      sinCodigoEnBsale,
    },
  };
}

/**
 * Consulta en Bsale el costo de las reparaciones que lo necesitan.
 *
 * Las que se quedan sin costo pierden el campo: nunca se manda un cero, que
 * Shopify interpretaría como «este producto no cuesta nada» y falsearía el
 * margen de toda la tienda.
 */
export async function anadirCostosReparacion(
  plan: PlanReparacion,
  obtenerCosto: (variantId: number) => Promise<number | null>,
): Promise<{ conCosto: number; sinCosto: number; erroresCosto: number }> {
  let conCosto = 0;
  let sinCosto = 0;
  let erroresCosto = 0;

  for (const r of plan.reparaciones) {
    if (r.costo === undefined) continue;

    if (r.bsaleVariantId === null || r.bsaleVariantId <= 0) {
      delete r.costo;
      sinCosto++;
      continue;
    }

    // `obtenerCosto` sólo devuelve `null` para un 404 real; otros fallos
    // (Bsale caído, timeout) se capturan aquí y se cuentan aparte de
    // `sinCosto`, para no confundir «no tiene costo» con «no se pudo saber».
    try {
      const costo = await obtenerCosto(r.bsaleVariantId);
      if (costo === null || costo <= 0) {
        delete r.costo;
        sinCosto++;
      } else {
        r.costo = costo;
        conCosto++;
      }
    } catch (error) {
      delete r.costo;
      erroresCosto++;
      logger.warn(
        { bsaleVariantId: r.bsaleVariantId, err: (error as Error).message },
        'No se pudo consultar el costo en Bsale; se deja sin reparar',
      );
    }
  }

  // Las que se quedaron sin nada que arreglar salen del plan.
  plan.reparaciones = plan.reparaciones.filter(
    (r) => r.barcode !== undefined || r.costo !== undefined,
  );
  plan.resumen.total = plan.reparaciones.length;
  plan.resumen.costo = plan.reparaciones.filter((r) => r.costo !== undefined).length;

  return { conCosto, sinCosto, erroresCosto };
}

/**
 * Aplica las correcciones. **Esto sí escribe en la tienda.**
 *
 * Agrupadas por producto porque `productVariantsBulkUpdate` exige que todas las
 * variantes de una llamada pertenezcan al mismo producto.
 */
export async function aplicarReparacion(
  client: ShopifyClient,
  plan: PlanReparacion,
  onProgreso?: CallbackProgreso,
): Promise<ResultadoReparacion> {
  const resultado: ResultadoReparacion = { reparados: 0, fallidos: 0, errores: [], reparacionesAplicadas: [] };

  const porProducto = new Map<string, Reparacion[]>();
  for (const r of plan.reparaciones) {
    const lista = porProducto.get(r.productId) ?? [];
    lista.push(r);
    porProducto.set(r.productId, lista);
  }

  let procesados = 0;
  for (const [productId, grupo] of porProducto) {
    try {
      const r = await client.repararVariantes(
        productId,
        grupo.map((g) => ({
          variantId: g.variantId,
          ...(g.barcode === undefined ? {} : { barcode: g.barcode }),
          ...(g.costo === undefined ? {} : { costo: g.costo }),
        })),
      );

      if (r.ok) {
        resultado.reparados += grupo.length;
        resultado.reparacionesAplicadas.push(...grupo);
      } else {
        resultado.fallidos += grupo.length;
        for (const g of grupo) {
          resultado.errores.push({ sku: g.sku, mensaje: r.errores.join(' | ') });
        }
      }
    } catch (error) {
      // Un producto que falla no arrastra a los demás.
      resultado.fallidos += grupo.length;
      for (const g of grupo) {
        resultado.errores.push({ sku: g.sku, mensaje: (error as Error).message });
      }
    }

    procesados += grupo.length;
    onProgreso?.(procesados, plan.reparaciones.length);
  }

  return resultado;
}
