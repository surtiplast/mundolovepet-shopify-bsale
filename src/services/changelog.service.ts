/**
 * Traduce el resultado de una escritura (stock, precio, costo, código de
 * barras, alta de producto) a entradas para el registro de cambios.
 *
 * Funciones puras a propósito: ni tocan la base de datos ni reciben el
 * `SyncLogStore`. Quien llama —la ruta manual o el cron— decide cuándo
 * guardarlas, y estas funciones se prueban sin nada de infraestructura.
 */
import type { CambioPlanificado, TipoSync } from './sync.service.js';
import type { Reparacion } from './repair.service.js';
import type { CandidatoCreacion } from './create.service.js';
import type { NuevoRegistro, OrigenLog } from '../db/synclog.store.js';

function textoValor(v: number | null): string {
  return v === null ? '—' : String(v);
}

/** Para `aplicarStock`/`aplicarPrecios`: un registro por SKU que de verdad cambió. */
export function registrosDeSync(
  cambiosAplicados: CambioPlanificado[],
  tipo: TipoSync,
  origen: OrigenLog,
): NuevoRegistro[] {
  return cambiosAplicados.map((c) => ({
    system: 'SHOPIFY',
    action: tipo,
    sku: c.codigo,
    message: `${textoValor(c.valorAnterior)} → ${c.valorNuevo}`,
    context: { valorAnterior: c.valorAnterior, valorNuevo: c.valorNuevo, origen },
  }));
}

/**
 * Para `aplicarReparacion`: una `Reparacion` puede tocar código de barras y
 * costo a la vez, y son cambios distintos — se registran por separado.
 */
export function registrosDeReparacion(
  reparacionesAplicadas: Reparacion[],
  origen: OrigenLog,
): NuevoRegistro[] {
  const registros: NuevoRegistro[] = [];
  for (const r of reparacionesAplicadas) {
    if (r.barcode !== undefined) {
      registros.push({
        system: 'SHOPIFY',
        action: 'CODIGO_BARRAS',
        sku: r.sku,
        message: `${r.barcodeAnterior || '—'} → ${r.barcode}`,
        context: { valorAnterior: r.barcodeAnterior ?? null, valorNuevo: r.barcode, origen },
      });
    }
    if (r.costo !== undefined) {
      // El costo, por la regla conservadora de repair.service.ts, sólo se
      // rellena cuando en Shopify faltaba o era cero — no hace falta guardar
      // «anterior» porque siempre es ese mismo valor vacío.
      registros.push({
        system: 'SHOPIFY',
        action: 'COSTO',
        sku: r.sku,
        message: `Costo asignado: ${r.costo}`,
        context: { valorAnterior: null, valorNuevo: r.costo, origen },
      });
    }
  }
  return registros;
}

/** Para `crearProductos`: un registro por producto nuevo (siempre en borrador). */
export function registrosDeCreacion(
  candidatosCreados: CandidatoCreacion[],
  origen: OrigenLog,
): NuevoRegistro[] {
  return candidatosCreados.map((c) => ({
    system: 'SHOPIFY',
    action: 'PRODUCTO_CREADO',
    sku: c.sku,
    message: `Creado en borrador — ${c.titulo}`,
    context: { valorAnterior: null, valorNuevo: c.precio, origen },
  }));
}
