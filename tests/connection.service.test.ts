import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ConnectionService } from '../src/services/connection.service.js';
import { InMemoryConnectionStore } from '../src/db/connection.store.js';
import { IntegrationError } from '../src/lib/errors.js';
import type { BsaleClient } from '../src/integrations/bsale/client.js';
import type { ShopifyClient } from '../src/integrations/shopify/client.js';

const KEY = randomBytes(32);
const BSALE_TOKEN = 'bsale-token-secreto-abcdef123456';
const SHOPIFY_TOKEN = 'shpat_0123456789abcdef0123456789abWXYZ';

const okBsale = {
  testConnection: async () => ({
    ok: true as const,
    officeCount: 1,
    offices: [{ href: '', id: 1, name: 'Tienda Principal', isVirtual: 0 }],
  }),
};

const okShopify = {
  testConnection: async () => ({
    ok: true as const,
    apiVersion: '2026-07',
    shop: {
      name: 'Mundo Love Pet',
      myshopifyDomain: 'mundolovepet.myshopify.com',
      currencyCode: 'PEN',
      ianaTimezone: 'America/Lima',
      plan: { displayName: 'Basic' },
    },
  }),
};

function makeService(overrides: {
  bsale?: Partial<BsaleClient>;
  shopify?: Partial<ShopifyClient>;
} = {}) {
  const store = new InMemoryConnectionStore();
  const service = new ConnectionService({
    store,
    encryptionKey: KEY,
    makeBsaleClient: () => ({ ...okBsale, ...overrides.bsale }) as unknown as BsaleClient,
    makeShopifyClient: () => ({ ...okShopify, ...overrides.shopify }) as unknown as ShopifyClient,
  });
  return { store, service };
}

describe('ConnectionService · guardado de credenciales', () => {
  it('cifra el token: el texto plano no queda en el almacén', async () => {
    const { store, service } = makeService();
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const record = await store.get('BSALE');
    expect(record).not.toBeNull();
    expect(record!.encryptedToken.toString('utf8')).not.toContain(BSALE_TOKEN);
    expect(record!.encryptedToken.toString('latin1')).not.toContain('secreto');
  });

  it('sólo expone los últimos 4 caracteres del token', async () => {
    const { service } = makeService();
    const view = await service.saveCredential('SHOPIFY', SHOPIFY_TOKEN);

    expect(view.maskedToken).toBe('••••WXYZ');
    expect(JSON.stringify(view)).not.toContain(SHOPIFY_TOKEN);
  });

  it('rechaza un token vacío o sólo espacios', async () => {
    const { service } = makeService();
    await expect(service.saveCredential('BSALE', '   ')).rejects.toThrow(IntegrationError);
  });

  it('descarta de metadata cualquier clave con pinta de secreto', async () => {
    const { service } = makeService();
    const view = await service.saveCredential('BSALE', BSALE_TOKEN, {
      baseUrl: 'https://api.bsale.io/v1',
      apiKey: 'no-debe-quedar',
      webhookSecret: 'tampoco',
    });

    expect(view.metadata['baseUrl']).toBe('https://api.bsale.io/v1');
    expect(view.metadata).not.toHaveProperty('apiKey');
    expect(view.metadata).not.toHaveProperty('webhookSecret');
  });
});

describe('ConnectionService · estado para el panel', () => {
  it('lista ambos proveedores aunque no estén configurados', async () => {
    const { service } = makeService();
    const conexiones = await service.listConnections();

    expect(conexiones.map((c) => c.provider).sort()).toEqual(['BSALE', 'SHOPIFY']);
    expect(conexiones.every((c) => !c.connected)).toBe(true);
  });

  it('ninguna vista contiene tokens completos', async () => {
    const { service } = makeService();
    await service.saveCredential('BSALE', BSALE_TOKEN);
    await service.saveCredential('SHOPIFY', SHOPIFY_TOKEN);

    const json = JSON.stringify(await service.listConnections());
    expect(json).not.toContain(BSALE_TOKEN);
    expect(json).not.toContain(SHOPIFY_TOKEN);
  });

  it('arranca en "Sin verificar" hasta que se pruebe la conexión', async () => {
    const { service } = makeService();
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const bsale = (await service.listConnections()).find((c) => c.provider === 'BSALE')!;
    expect(bsale.connected).toBe(false);
    expect(bsale.status).toBe('Sin verificar');
  });
});

describe('ConnectionService · pruebas de conexión', () => {
  it('marca Bsale como conectado tras una prueba exitosa', async () => {
    const { service } = makeService();
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const result = await service.testBsale('https://api.bsale.io/v1');
    expect(result.ok).toBe(true);
    expect(result.details?.['sucursales']).toBe(1);

    const view = (await service.listConnections()).find((c) => c.provider === 'BSALE')!;
    expect(view.connected).toBe(true);
    expect(view.status).toBe('Conectado');
  });

  it('marca Shopify como conectado y guarda moneda y zona horaria', async () => {
    const { service } = makeService();
    await service.saveCredential('SHOPIFY', SHOPIFY_TOKEN);

    const result = await service.testShopify('mundolovepet.myshopify.com', '2026-07');
    expect(result.ok).toBe(true);
    expect(result.details?.['moneda']).toBe('PEN');
    expect(result.details?.['zonaHoraria']).toBe('America/Lima');
  });

  it('falla de forma limpia si no hay credencial guardada', async () => {
    const { service } = makeService();
    const result = await service.testBsale('https://api.bsale.io/v1');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/No hay credenciales/);
  });

  it('registra el error y deja la conexión en estado Error', async () => {
    const { service } = makeService({
      bsale: {
        testConnection: async () => {
          throw new IntegrationError('Bsale rechazó la credencial (401/403).', {
            provider: 'BSALE',
            status: 401,
            retryable: false,
          });
        },
      },
    });
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const result = await service.testBsale('https://api.bsale.io/v1');
    expect(result.ok).toBe(false);
    expect(result.error?.status).toBe(401);
    expect(result.error?.retryable).toBe(false);

    const view = (await service.listConnections()).find((c) => c.provider === 'BSALE')!;
    expect(view.status).toBe('Error');
    expect(view.lastError).toMatch(/401/);
  });

  it('nunca filtra el token aunque el error de la API lo contenga', async () => {
    const { service } = makeService({
      bsale: {
        testConnection: async () => {
          throw new IntegrationError(`fallo con token ${BSALE_TOKEN}`, { provider: 'BSALE' });
        },
      },
    });
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const result = await service.testBsale('https://api.bsale.io/v1');
    expect(JSON.stringify(result)).not.toContain(BSALE_TOKEN);
    expect(result.error?.message).toContain('[REDACTADO]');

    const view = (await service.listConnections()).find((c) => c.provider === 'BSALE')!;
    expect(view.lastError).not.toContain(BSALE_TOKEN);
  });

  it('convierte un error genérico en un resultado seguro sin stack', async () => {
    const { service } = makeService({
      bsale: {
        testConnection: async () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const result = await service.testBsale('https://api.bsale.io/v1');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('at Object');
  });
});

describe('ConnectionService · descubrimiento Bsale', () => {
  const discoveryClient = {
    listOffices: async () => ({ count: 1, items: [{ id: 1, name: 'Principal', isVirtual: 0 }] }),
    listDocumentTypes: async () => ({
      count: 4,
      items: [
        { id: 5, name: 'Nota de Venta', isElectronicService: 0, isSalesNote: 1 },
        { id: 1, name: 'Boleta Manual', isElectronicService: 0, isSalesNote: 0 },
        { id: 8, name: 'Boleta Electrónica', isElectronicService: 1, isSalesNote: 0 },
        { id: 9, name: 'Factura Electrónica', isElectronicService: 1, isSalesNote: 0 },
      ],
    }),
    listTaxes: async () => ({ count: 1, items: [{ id: 1, name: 'IGV', percentage: 18 }] }),
    listPriceLists: async () => ({ count: 1, items: [{ id: 3, name: 'Lista General' }] }),
  };

  it('prefiere el tipo de documento ELECTRÓNICO y descarta notas de venta', async () => {
    const { service } = makeService({ bsale: discoveryClient as unknown as Partial<BsaleClient> });
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const d = await service.discoverBsale('https://api.bsale.io/v1');
    expect(d.suggestions.boletaId).toBe(8); // no el 1 (manual), no el 5 (nota de venta)
    expect(d.suggestions.facturaId).toBe(9);
    expect(d.suggestions.igvTaxId).toBe(1);
  });

  it('advierte explícitamente que las sugerencias deben confirmarse', async () => {
    const { service } = makeService({ bsale: discoveryClient as unknown as Partial<BsaleClient> });
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const d = await service.discoverBsale('https://api.bsale.io/v1');
    expect(d.suggestions.note).toMatch(/Confírmalas/i);
  });

  it('devuelve null en las sugerencias si la cuenta no tiene esos tipos', async () => {
    const { service } = makeService({
      bsale: {
        ...discoveryClient,
        listDocumentTypes: async () => ({ count: 0, items: [] }),
        listTaxes: async () => ({ count: 0, items: [] }),
      } as unknown as Partial<BsaleClient>,
    });
    await service.saveCredential('BSALE', BSALE_TOKEN);

    const d = await service.discoverBsale('https://api.bsale.io/v1');
    expect(d.suggestions.boletaId).toBeNull();
    expect(d.suggestions.igvTaxId).toBeNull();
  });

  it('propaga el error si no hay credencial', async () => {
    const { service } = makeService();
    await expect(service.discoverBsale('https://api.bsale.io/v1')).rejects.toThrow(
      /No hay credenciales/,
    );
  });
});
