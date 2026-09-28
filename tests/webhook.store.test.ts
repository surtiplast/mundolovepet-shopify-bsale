/**
 * Pruebas del registro de webhooks.
 *
 * Lo único que de verdad importa aquí es la deduplicación: si Bsale reintenta
 * el mismo evento, `registrar` debe decirlo con `yaExistia: true` en vez de
 * fallar o duplicar la fila.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryWebhookStore,
  PrismaWebhookStore,
  type PrismaWebhookLike,
} from '../src/db/webhook.store.js';

describe('InMemoryWebhookStore', () => {
  it('la primera vez que se ve un evento, yaExistia es false', async () => {
    const store = new InMemoryWebhookStore();
    const r = await store.registrar({ source: 'BSALE', externalId: '3229', topic: 'stock', payload: {} });
    expect(r.yaExistia).toBe(false);
  });

  it('un reenvío del mismo evento (misma fuente + externalId) se detecta', async () => {
    const store = new InMemoryWebhookStore();
    await store.registrar({ source: 'BSALE', externalId: '3229', topic: 'stock', payload: { a: 1 } });
    const r = await store.registrar({ source: 'BSALE', externalId: '3229', topic: 'stock', payload: { a: 2 } });
    expect(r.yaExistia).toBe(true);
  });

  it('el mismo externalId en fuentes distintas NO se confunde', async () => {
    const store = new InMemoryWebhookStore();
    await store.registrar({ source: 'BSALE', externalId: '3229', topic: 'stock', payload: {} });
    const r = await store.registrar({ source: 'SHOPIFY', externalId: '3229', topic: 'orders/paid', payload: {} });
    expect(r.yaExistia).toBe(false);
  });
});

describe('PrismaWebhookStore', () => {
  it('yaExistia es false cuando create() funciona', async () => {
    const prisma: PrismaWebhookLike = { webhookEvent: { create: async () => ({}) } };
    const store = new PrismaWebhookStore(prisma);
    const r = await store.registrar({ source: 'BSALE', externalId: '1', topic: 'price', payload: {} });
    expect(r.yaExistia).toBe(false);
  });

  it('yaExistia es true cuando create() choca con el índice único (P2002)', async () => {
    const prisma: PrismaWebhookLike = {
      webhookEvent: {
        create: async () => {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        },
      },
    };
    const store = new PrismaWebhookStore(prisma);
    const r = await store.registrar({ source: 'BSALE', externalId: '1', topic: 'price', payload: {} });
    expect(r.yaExistia).toBe(true);
  });

  it('cualquier otro error de base de datos se propaga, no se confunde con un duplicado', async () => {
    const prisma: PrismaWebhookLike = {
      webhookEvent: {
        create: async () => {
          throw Object.assign(new Error('connection refused'), { code: 'P1001' });
        },
      },
    };
    const store = new PrismaWebhookStore(prisma);
    await expect(
      store.registrar({ source: 'BSALE', externalId: '1', topic: 'price', payload: {} }),
    ).rejects.toThrow('connection refused');
  });
});
