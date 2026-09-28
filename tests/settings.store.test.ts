/**
 * Pruebas del almacén de interruptores del panel.
 *
 * Lo que importa probar: que el valor por defecto se respeta hasta que
 * alguien guarda algo, y que una vez guardado, ese valor gana — sin importar
 * qué diga la variable de entorno que se pase como «por defecto».
 */
import { describe, expect, it } from 'vitest';
import {
  InMemorySettingsStore,
  PrismaSettingsStore,
  leerInterruptor,
  CLAVE_SYNC_AUTO_PRECIOS,
  CLAVE_SYNC_AUTO_STOCK,
  type PrismaSettingsLike,
} from '../src/db/settings.store.js';

describe('leerInterruptor', () => {
  it('usa el valor por defecto si nunca se guardó nada', async () => {
    const store = new InMemorySettingsStore();
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_PRECIOS, true)).toBe(true);
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_PRECIOS, false)).toBe(false);
  });

  it('lo guardado gana sobre el valor por defecto', async () => {
    const store = new InMemorySettingsStore();
    await store.guardar(CLAVE_SYNC_AUTO_PRECIOS, 'true');
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_PRECIOS, false)).toBe(true);

    await store.guardar(CLAVE_SYNC_AUTO_PRECIOS, 'false');
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_PRECIOS, true)).toBe(false);
  });

  it('stock y precios son interruptores independientes, cada uno con su propio por defecto', async () => {
    const store = new InMemorySettingsStore();
    // Nadie tocó ninguno todavía: stock por defecto true, precios por defecto false.
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_STOCK, true)).toBe(true);
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_PRECIOS, false)).toBe(false);

    // Apagar precios no debe tocar stock.
    await store.guardar(CLAVE_SYNC_AUTO_PRECIOS, 'true');
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_STOCK, true)).toBe(true);
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_PRECIOS, false)).toBe(true);

    // Y apagar stock no debe tocar precios.
    await store.guardar(CLAVE_SYNC_AUTO_STOCK, 'false');
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_STOCK, true)).toBe(false);
    expect(await leerInterruptor(store, CLAVE_SYNC_AUTO_PRECIOS, false)).toBe(true);
  });
});

describe('InMemorySettingsStore', () => {
  it('devuelve null para una clave nunca guardada', async () => {
    const store = new InMemorySettingsStore();
    expect(await store.obtener('nunca-guardada')).toBeNull();
  });

  it('guardar dos veces la misma clave sobrescribe, no duplica', async () => {
    const store = new InMemorySettingsStore();
    await store.guardar('x', 'uno');
    await store.guardar('x', 'dos');
    expect(await store.obtener('x')).toBe('dos');
  });
});

describe('PrismaSettingsStore', () => {
  it('traduce obtener() a findUnique por la clave', async () => {
    const prisma: PrismaSettingsLike = {
      appSetting: {
        findUnique: async ({ where }) =>
          where.key === CLAVE_SYNC_AUTO_PRECIOS ? { value: 'true' } : null,
        upsert: async () => ({}),
      },
    };
    const store = new PrismaSettingsStore(prisma);
    expect(await store.obtener(CLAVE_SYNC_AUTO_PRECIOS)).toBe('true');
    expect(await store.obtener('otra-clave')).toBeNull();
  });

  it('guardar() hace upsert: crea si no existe, actualiza si existe', async () => {
    const llamadas: Array<{ where: unknown; create: unknown; update: unknown }> = [];
    const prisma: PrismaSettingsLike = {
      appSetting: {
        findUnique: async () => null,
        upsert: async (args) => {
          llamadas.push(args);
          return {};
        },
      },
    };
    const store = new PrismaSettingsStore(prisma);
    await store.guardar('clave', 'valor');

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toEqual({
      where: { key: 'clave' },
      create: { key: 'clave', value: 'valor' },
      update: { value: 'valor' },
    });
  });
});
