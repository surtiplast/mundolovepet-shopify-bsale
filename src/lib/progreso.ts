/**
 * Estado de una sincronización manual en curso, para la barra de progreso del
 * panel — Fase 8.
 *
 * ── Por qué en memoria y no en base de datos ─────────────────────────────────
 *
 * Es un solo proceso Express; una sincronización manual sólo puede estar en
 * curso en ese mismo proceso, nunca en otro (el cron es un proceso aparte, y
 * de todas formas no tiene a nadie mirando una barra de progreso). Guardarlo
 * en Postgres sería una ida y vuelta de red en cada lote, para un dato que
 * nadie necesita que sobreviva a un reinicio.
 *
 * ── Por qué un solo estado global y no uno por operación ─────────────────────
 *
 * `conCandado()` en routes/sync.ts ya impide que dos escrituras corran a la
 * vez en este proceso. Con ese candado, nunca hay más de una operación de la
 * que informar, así que un único valor basta.
 */

export type CallbackProgreso = (procesados: number, total: number) => void;

export interface EstadoProgreso {
  operacion: string;
  procesados: number;
  total: number;
}

let actual: EstadoProgreso | null = null;

/**
 * Marca el comienzo de una operación y devuelve la función que hay que pasar
 * como `onProgreso` a `aplicarStock`/`aplicarPrecios`/`aplicarReparacion`/
 * `crearProductos`.
 */
export function iniciarProgreso(operacion: string, total: number): CallbackProgreso {
  actual = { operacion, procesados: 0, total };
  return (procesados, totalActualizado) => {
    // La comprobación de identidad evita que una operación vieja, todavía
    // terminando de resolver sus promesas pendientes, pise el progreso de la
    // que empezó después de ella.
    if (actual && actual.operacion === operacion) {
      actual.procesados = procesados;
      actual.total = totalActualizado;
    }
  };
}

/** Se llama siempre en un `finally`, haya terminado bien o mal. */
export function terminarProgreso(operacion: string): void {
  if (actual && actual.operacion === operacion) actual = null;
}

export function leerProgreso(): EstadoProgreso | null {
  return actual ? { ...actual } : null;
}
