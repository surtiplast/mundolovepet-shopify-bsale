/**
 * Caché del costo de Bsale, para no preguntarle lo mismo una y otra vez.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────
 *
 * Bsale no da el costo en la lectura masiva del catálogo, sólo variante por
 * variante (`GET /variants/{id}/costs.json`). En esta tienda, unas 800
 * variantes nunca entraron por una recepción y por eso no tienen costo
 * registrado — y esa respuesta no cambia sola. Sin caché, cada pasada de
 * reparar costo (el cron cada minuto, o un disparo por webhook) volvía a
 * preguntarle a Bsale por esas mismas 800+ variantes, alargando cada corrida
 * en decenas de segundos para una respuesta que ya se sabía.
 *
 * ── Por qué vence en vez de guardarse para siempre ───────────────────────────
 *
 * Una variante sin costo hoy puede tenerlo mañana, en cuanto entre por una
 * recepción de mercadería. Un caché sin vencimiento se quedaría diciendo
 * «sin costo» para siempre. `TTL_HORAS` acota cuánto puede tardar en
 * notarse un costo nuevo, a cambio de preguntar mucho menos que cada minuto.
 */
import type { ActualizacionCosto, CatalogStore, ProductoGuardado } from '../db/catalog.store.js';

const TTL_HORAS = 24;

function vigente(revisadoEl: Date | null): boolean {
  if (!revisadoEl) return false;
  return Date.now() - revisadoEl.getTime() < TTL_HORAS * 60 * 60 * 1000;
}

export interface CacheDeCostos {
  /**
   * Envuelve la función real que llama a Bsale: si hay un valor vigente en
   * caché para esa variante, lo devuelve sin llamar a Bsale; si no, llama y
   * anota el resultado para guardarlo con `guardar()`.
   */
  envolver(obtenerCostoReal: (variantId: number) => Promise<number | null>): (variantId: number) => Promise<number | null>;
  /** Persiste lo consultado en esta pasada. No hace nada si no se consultó nada nuevo. */
  guardar(catalogStore: CatalogStore): Promise<void>;
}

export function crearCacheDeCostos(catalogo: ProductoGuardado[]): CacheDeCostos {
  const porVariantId = new Map<number, ProductoGuardado>();
  for (const p of catalogo) {
    if (p.bsaleVariantId !== null) porVariantId.set(p.bsaleVariantId, p);
  }
  const pendientes: ActualizacionCosto[] = [];

  return {
    envolver(obtenerCostoReal) {
      return async (variantId: number): Promise<number | null> => {
        const fila = porVariantId.get(variantId);
        if (fila && vigente(fila.costoRevisadoEl)) return fila.bsaleCosto;

        const costo = await obtenerCostoReal(variantId);
        if (fila) pendientes.push({ sku: fila.sku, bsaleCosto: costo });
        return costo;
      };
    },

    async guardar(catalogStore) {
      if (pendientes.length > 0) await catalogStore.actualizarCostos(pendientes);
    },
  };
}
