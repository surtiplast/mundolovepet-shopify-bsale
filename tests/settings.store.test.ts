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
  leerSyncAutoPrecios,
  CLAVE_SYNC_AUTO_PRECIOS,
  type PrismaSettingsLike,
} from '../src/db/settings.store.js';

describe('leerSyncAutoPrecios', () => {
  it('usa el valor por defecto si nunca se guardó nada', async () => {
    const store = new InMemorySettingsStore();
    expect(await leerSyncAutoPrecios(store, true)).toBe(true);
    expect(await leerSyncAutoPrecios(store, false)).toBe(false);
  });

  it('lo guardado gana sobre el valor por defecto', async () => {
    const store = new InMemorySettingsStore();
    await store.guardar(CLAVE_SYNC_AUTO_PRECIOS, 'true');
    expect(await leerSyncAutoPrecios(store, false)).toBe(true);

    await store.guardar(CLAVE_SYNC_AUTO_PRECIOS, 'false');
    expect(await leerSyncAutoPrecios(store, true)).toBe(false);
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
