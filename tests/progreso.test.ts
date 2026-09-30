/**
 * Pruebas del estado de progreso — Fase 8.
 *
 * Lo que importa: una operación vieja que todavía está resolviendo sus
 * últimas promesas no puede pisar el progreso de la que empezó después de
 * ella, y `leerProgreso()` nunca devuelve la referencia interna (para que
 * quien la lee no pueda mutarla por accidente).
 */
import { describe, expect, it } from 'vitest';
import { iniciarProgreso, terminarProgreso, leerProgreso } from '../src/lib/progreso.js';

describe('progreso', () => {
  it('no hay nada en curso al principio', () => {
    expect(leerProgreso()).toBeNull();
  });

  it('iniciarProgreso pone el estado en 0 de total', () => {
    iniciarProgreso('stock', 500);
    expect(leerProgreso()).toEqual({ operacion: 'stock', procesados: 0, total: 500 });
    terminarProgreso('stock');
  });

  it('la función devuelta por iniciarProgreso actualiza procesados y total', () => {
    const avisar = iniciarProgreso('precio', 100);
    avisar(40, 100);
    expect(leerProgreso()).toEqual({ operacion: 'precio', procesados: 40, total: 100 });
    terminarProgreso('precio');
  });

  it('terminarProgreso limpia el estado', () => {
    iniciarProgreso('crear', 10);
    terminarProgreso('crear');
    expect(leerProgreso()).toBeNull();
  });

  it('terminarProgreso con un nombre que no es el actual no toca nada', () => {
    iniciarProgreso('reparar', 10);
    terminarProgreso('otra-operacion-vieja');
    expect(leerProgreso()).not.toBeNull();
    terminarProgreso('reparar');
  });

  /**
   * El caso real que motiva la comprobación de identidad: una operación A
   * termina y llama a `terminarProgreso('A')`, pero antes de que le toque el
   * turno ya empezó B y llamó a `iniciarProgreso('B', ...)`. Sin comprobar el
   * nombre, ese `terminarProgreso('A')` tardío borraría el progreso de B.
   */
  it('un terminarProgreso tardío de una operación vieja no borra el progreso de la nueva', () => {
    iniciarProgreso('A', 10);
    terminarProgreso('A');
    iniciarProgreso('B', 20);

    terminarProgreso('A'); // tardío, de una operación que ya no es la actual

    expect(leerProgreso()).toEqual({ operacion: 'B', procesados: 0, total: 20 });
    terminarProgreso('B');
  });

  it('una función de progreso vieja no puede pisar el estado de la operación nueva', () => {
    const avisarA = iniciarProgreso('A', 10);
    terminarProgreso('A');
    iniciarProgreso('B', 20);

    avisarA(5, 10); // tardío, de A

    expect(leerProgreso()).toEqual({ operacion: 'B', procesados: 0, total: 20 });
    terminarProgreso('B');
  });

  it('leerProgreso devuelve una copia, no la referencia interna', () => {
    iniciarProgreso('stock', 10);
    const leido = leerProgreso();
    leido!.procesados = 999;

    expect(leerProgreso()).toEqual({ operacion: 'stock', procesados: 0, total: 10 });
    terminarProgreso('stock');
  });
});
