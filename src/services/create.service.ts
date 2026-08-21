/**
 * Alta en Shopify de los productos que sólo existen en Bsale.
 *
 * ── Qué crea y qué no ────────────────────────────────────────────────────────
 *
 * Crea el producto **en borrador**, con título, SKU, código de barras, precio y
 * stock. No pone foto, ni descripción, ni colección: eso no existe en Bsale y
 * un producto publicado sin foto es peor que uno que no está.
 *
 * ── Por qué no se publica automáticamente ────────────────────────────────────
 *
 * En Bsale está todo lo que la empresa vende; en la tienda online sólo lo que
 * se quiere vender por internet. Publicar automáticamente los 197 productos que
 * faltan asume que todos deben estar, y eso no lo sabe la app: lo sabe el
 * comerciante. En borrador quedan preparados y él decide cuáles publica.
 */
import type { ShopifyClient, ProductoNuevo } from '../integrations/shopify/client.js';
import type { ProductoGuardado } from '../db/catalog.store.js';
import { normalizarSku } from './catalog.service.js';

export interface CandidatoCreacion {
  sku: string;
  /** El EAN de Bsale. Campo distinto del SKU; `null` si la variante no tiene. */
  barcode: string | null;
  /** La marca. Va al campo «Proveedor» de Shopify; `null` si Bsale no la tiene. */
  marca: string | null;
  titulo: string;
  precio: number;
  stock: number | null;
  /** Necesario para pedir el costo: Bsale sólo lo da por id de variante. */
  bsaleVariantId: number | null;
  /**
   * Costo promedio de Bsale. `null` mientras no se haya consultado, y también
   * cuando la variante no tiene costo registrado —producto que nunca entró por
   * una recepción—. En ambos casos el producto se crea igual, sin costo.
   */
  costo: number | null;
}

export interface PlanCreacion {
  candidatos: CandidatoCreacion[];
  omitidos: Array<{ sku: string; motivo: string }>;
  resumen: {
    total: number;
    sinNombre: number;
    sinPrecio: number;
    /** Ya existían en Shopify pese a venir marcados como ausentes. */
    yaExistian: number;
  };
}

export interface ResultadoCreacion {
  creados: number;
  fallidos: number;
  errores: Array<{ sku: string; mensaje: string }>;
  ids: string[];
}

/**
 * Decide qué productos se pueden crear. **No escribe nada.**
 *
 * `soloEnBsale` son los códigos que el informe de emparejamiento marcó como
 * ausentes en Shopify.
 */
export function planificarCreacion(
  catalogo: ProductoGuardado[],
  soloEnBsale: string[],
  limite?: number,
  /**
   * Todos los códigos que ya existen en Shopify, de SUS DOS campos —`sku` y
   * `barcode`— ya normalizados.
   *
   * ── Por qué esta comprobación existe si `soloEnBsale` ya debería bastar ────
   *
   * Porque una vez no bastó. El emparejamiento miraba un solo campo, y los
   * productos que en Shopify tenían el código en `barcode` con el `sku` vacío
   * se daban por ausentes y se creaban otra vez, duplicando el SKU en la
   * tienda.
   *
   * Aquello se arregló en `compararCatalogos`, pero esta segunda comprobación
   * se queda: crear un duplicado obliga a buscarlo y borrarlo a mano, mientras
   * que no crear algo se resuelve con otra pulsación. Cuando el coste de los
   * dos errores es tan distinto, conviene comprobar dos veces.
   */
  codigosEnShopify?: Set<string>,
): PlanCreacion {
  const faltantes = new Set(soloEnBsale.map((s) => normalizarSku(s)));

  const candidatos: CandidatoCreacion[] = [];
  const omitidos: Array<{ sku: string; motivo: string }> = [];

  for (const p of catalogo) {
    if (limite !== undefined && candidatos.length >= limite) break;

    const clave = normalizarSku(p.sku);
    if (!clave || !faltantes.has(clave)) continue;

    // La red de seguridad. Si el código ya está en la tienda por cualquiera de
    // los dos campos, no se crea nada aunque el informe dijera que falta.
    if (codigosEnShopify?.has(clave)) {
      omitidos.push({
        sku: p.sku,
        motivo: 'Ya existe en Shopify (por SKU o código de barras). No se crea para no duplicarlo.',
      });
      continue;
    }

    const titulo = p.name?.trim();
    if (!titulo) {
      // Shopify exige título, y crear productos llamados «74352029339543» deja
      // la tienda inservible. Mejor señalarlos para corregir el nombre en Bsale.
      omitidos.push({ sku: p.sku, motivo: 'Sin nombre en Bsale' });
      continue;
    }

    if (p.bsalePrice === null || p.bsalePrice <= 0) {
      // Un producto a cero se publicaría gratis. Nunca se crea así.
      omitidos.push({ sku: p.sku, motivo: 'Sin precio, o precio cero, en Bsale' });
      continue;
    }

    candidatos.push({
      sku: p.sku,
      barcode: p.barcode?.trim() || null,
      marca: p.brand?.trim() || null,
      titulo,
      precio: p.bsalePrice,
      bsaleVariantId: p.bsaleVariantId,
      // Se rellena después, con `anadirCostos`. Planificar no llama a Bsale.
      costo: null,
      // Un stock nulo se trata como cero: el producto nace agotado, que es lo
      // honesto cuando no sabemos cuántos hay.
      stock: p.bsaleStock ?? 0,
    });
  }

  return {
    candidatos,
    omitidos,
    resumen: {
      total: candidatos.length,
      sinNombre: omitidos.filter((o) => o.motivo.includes('nombre')).length,
      sinPrecio: omitidos.filter((o) => o.motivo.includes('precio')).length,
      yaExistian: omitidos.filter((o) => o.motivo.includes('Ya existe')).length,
    },
  };
}

/**
 * Consulta en Bsale el costo de cada candidato y lo añade al plan.
 *
 * ── Por qué es un paso aparte ────────────────────────────────────────────────
 *
 * Bsale sólo da el costo variante por variante: son tantas peticiones como
 * candidatos. Separarlo de `planificarCreacion` mantiene la planificación
 * instantánea y sin red, que es lo que permite simular sin esperas.
 *
 * Un costo que no se puede leer no detiene nada: el producto se crea sin él.
 * El costo es informativo para los márgenes; el precio, el stock y el código
 * son los que no pueden faltar.
 */
export async function anadirCostos(
  plan: PlanCreacion,
  obtenerCosto: (variantId: number) => Promise<number | null>,
): Promise<{ conCosto: number; sinCosto: number }> {
  let conCosto = 0;
  let sinCosto = 0;

  for (const c of plan.candidatos) {
    if (c.bsaleVariantId === null || c.bsaleVariantId <= 0) {
      sinCosto++;
      continue;
    }
    const costo = await obtenerCosto(c.bsaleVariantId);
    c.costo = costo;
    if (costo === null) sinCosto++;
    else conCosto++;
  }

  return { conCosto, sinCosto };
}

/**
 * Crea de verdad los productos. **Esto sí escribe en la tienda.**
 *
 * Uno por uno y en serie: `productSet` no admite lotes, y lanzarlos en paralelo
 * dispararía el control de caudal de Shopify. Con 197 productos son unos pocos
 * minutos, y a cambio un fallo suelto no arrastra a los demás.
 */
export async function crearProductos(
  client: ShopifyClient,
  plan: PlanCreacion,
  locationId: string,
): Promise<ResultadoCreacion> {
  const resultado: ResultadoCreacion = { creados: 0, fallidos: 0, errores: [], ids: [] };

  for (const c of plan.candidatos) {
    const producto: ProductoNuevo = {
      titulo: c.titulo,
      sku: c.sku,
      barcode: c.barcode,
      marca: c.marca,
      precio: c.precio,
      costo: c.costo,
      stock: c.stock,
      locationId,
    };

    try {
      const r = await client.crearProductoBorrador(producto);
      if (r.ok) {
        resultado.creados++;
        if (r.productId) resultado.ids.push(r.productId);
      } else {
        resultado.fallidos++;
        resultado.errores.push({ sku: c.sku, mensaje: r.errores.join(' | ') });
      }
    } catch (error) {
      resultado.fallidos++;
      resultado.errores.push({ sku: c.sku, mensaje: (error as Error).message });
    }
  }

  return resultado;
}
