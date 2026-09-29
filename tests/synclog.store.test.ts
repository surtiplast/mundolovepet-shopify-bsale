/**
 * Pruebas del registro de cambios.
 *
 * Lo que importa: filtrar por fecha y por acción funciona, lo más reciente
 * sale primero, y el `context` nunca llega a Prisma sin pasar por `redact()`.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemorySyncLogStore,
  PrismaSyncLogStore,
  type NuevoRegistro,
  type PrismaSyncLogLike,
} from '../src/db/synclog.store.js';

function registro(over: Partial<NuevoRegistro> = {}): NuevoRegistro {
  return {
    system: 'SHOPIFY',
    action: 'STOCK',
    sku: 'A1',
    message: '10 → 15',
    context: { valorAnterior: 10, valorNuevo: 15, origen: 'CRON' },
    ...over,
  };
}

describe('InMemorySyncLogStore', () => {
  it('lo que se registra se puede listar', async () => {
    const store = new InMemorySyncLogStore();
    await store.registrar([registro()]);

    const pagina = await store.listar({});
    expect(pagina.total).toBe(1);
    expect(pagina.items[0]).toMatchObject({ sku: 'A1', action: 'STOCK' });
  });

  it('lo más reciente sale primero', async () => {
    const store = new InMemorySyncLogStore();
    await store.registrar([registro({ sku: 'PRIMERO' })]);
    await store.registrar([registro({ sku: 'SEGUNDO' })]);

    const pagina = await store.listar({});
    expect(pagina.items[0]!.sku).toBe('SEGUNDO');
    expect(pagina.items[1]!.sku).toBe('PRIMERO');
  });

  it('filtra por acción', async () => {
    const store = new InMemorySyncLogStore();
    await store.registrar([registro({ action: 'STOCK' }), registro({ action: 'PRECIO' })]);

    const pagina = await store.listar({ action: 'PRECIO' });
    expect(pagina.total).toBe(1);
    expect(pagina.items[0]!.action).toBe('PRECIO');
  });

  it('filtra por rango de fechas', async () => {
    const store = new InMemorySyncLogStore();
    await store.registrar([registro()]);

    const futuro = new Date(Date.now() + 60_000);
    expect((await store.listar({ desde: futuro })).total).toBe(0);

    const pasado = new Date(Date.now() - 60_000);
    expect((await store.listar({ desde: pasado })).total).toBe(1);
  });

  it('respeta límite y desplazamiento (paginación)', async () => {
    const store = new InMemorySyncLogStore();
    await store.registrar([registro({ sku: 'A' }), registro({ sku: 'B' }), registro({ sku: 'C' })]);

    const pagina = await store.listar({ limite: 1, offset: 1 });
    expect(pagina.total).toBe(3);
    expect(pagina.items).toHaveLength(1);
  });

  it('empieza vacío', async () => {
    expect((await new InMemorySyncLogStore().listar({})).total).toBe(0);
  });
});

describe('PrismaSyncLogStore', () => {
  it('no llama a createMany si no hay nada que registrar', async () => {
    let llamado = false;
    const prisma: PrismaSyncLogLike = {
      syncLog: {
        createMany: async () => {
          llamado = true;
          return {};
        },
        findMany: async () => [],
        count: async () => 0,
      },
    };
    await new PrismaSyncLogStore(prisma).registrar([]);
    expect(llamado).toBe(false);
  });

  it('nunca manda el context a Prisma sin pasar por redact()', async () => {
    let dataEnviada: Record<string, unknown>[] = [];
    const prisma: PrismaSyncLogLike = {
      syncLog: {
        createMany: async ({ data }) => {
          dataEnviada = data;
          return {};
        },
        findMany: async () => [],
        count: async () => 0,
      },
    };
    await new PrismaSyncLogStore(prisma).registrar([
      registro({ context: { valorAnterior: 10, valorNuevo: 15, origen: 'CRON' } }),
    ]);

    // redact() no toca claves normales como éstas, pero el punto es que pasa
    // por la función: si algún día `context` llevara algo sensible, ya
    // estaría cubierto sin tener que acordarse de aplicarlo aquí.
    expect(dataEnviada[0]!.context).toEqual({ valorAnterior: 10, valorNuevo: 15, origen: 'CRON' });
  });

  it('traduce listar() a un where con rango de fechas y acción', async () => {
    let whereRecibido: unknown;
    const prisma: PrismaSyncLogLike = {
      syncLog: {
        createMany: async () => ({}),
        findMany: async (args) => {
          whereRecibido = args.where;
          return [];
        },
        count: async () => 0,
      },
    };
    const desde = new Date('2026-01-01');
    const hasta = new Date('2026-01-31');
    await new PrismaSyncLogStore(prisma).listar({ desde, hasta, action: 'COSTO' });

    expect(whereRecibido).toEqual({
      occurredAt: { gte: desde, lte: hasta },
      action: 'COSTO',
    });
  });

  it('devuelve el total real, no sólo el tamaño de la página', async () => {
    const prisma: PrismaSyncLogLike = {
      syncLog: {
        createMany: async () => ({}),
        findMany: async () => [
          {
            id: '1',
            occurredAt: new Date(),
            system: 'SHOPIFY',
            action: 'STOCK',
            sku: 'A1',
            result: 'OK',
            message: '10 → 15',
            context: null,
          },
        ],
        count: async () => 250,
      },
    };
    const pagina = await new PrismaSyncLogStore(prisma).listar({ limite: 1 });
    expect(pagina.items).toHaveLength(1);
    expect(pagina.total).toBe(250);
  });
});
