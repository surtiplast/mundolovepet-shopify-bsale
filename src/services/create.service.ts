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
  titulo: string;
  precio: number;
  stock: number | null;
}

export interface PlanCreacion {
  candidatos: CandidatoCreacion[];
  omitidos: Array<{ sku: string; motivo: string }>;
  resumen: {
    total: number;
    sinNombre: number;
    sinPrecio: number;
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
): PlanCreacion {
  const faltantes = new Set(soloEnBsale.map((s) => normalizarSku(s)));

  const candidatos: CandidatoCreacion[] = [];
  const omitidos: Array<{ sku: string; motivo: string }> = [];

  for (const p of catalogo) {
    if (limite !== undefined && candidatos.length >= limite) break;

    const clave = normalizarSku(p.sku);
    if (!clave || !faltantes.has(clave)) continue;

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
      titulo,
      precio: p.bsalePrice,
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
    },
  };
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
      precio: c.precio,
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
