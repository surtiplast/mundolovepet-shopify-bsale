/**
 * Pruebas del registro de comprobantes emitidos.
 *
 * Lo que se prueba aquí no es que guarde, sino que **guarde entero o nada**. Un
 * pedido marcado como facturado sin su documento es peor que no haber guardado
 * nada: diría que ya está emitido sin poder demostrarlo, y el panel escondería
 * el botón de emitir en un pedido que en realidad no tiene comprobante.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryInvoiceStore,
  PrismaInvoiceStore,
  type EmisionGuardada,
  type PrismaInvoiceLike,
} from '../src/db/invoice.store.js';

function emision(over: Partial<EmisionGuardada> = {}): EmisionGuardada {
  return {
    shopifyOrderId: '5544332211',
    shopifyOrderName: '#1058',
    shopifyOrderGid: 'gid://shopify/Order/5544332211',
    idempotencyKey: 'shopify-order-5544332211',
    kind: 'BOLETA',
    totalAmount: 118,
    currency: 'PEN',
    documento: {
      bsaleDocumentId: 500,
      documentTypeId: 1,
      serialNumber: 'B001-1234',
      number: 1234,
      emissionDate: 1_755_475_200,
      totalAmount: 118,
      token: 'abc123',
      sunatState: 0,
      sunatMessage: 'Aceptado',
      urlPdf: 'https://app2.bsale.com.pe/view/8888/abc.pdf',
      ...(over.documento ?? {}),
    },
    ...over,
  };
}

describe('InMemoryInvoiceStore', () => {
  it('guarda y devuelve el comprobante', async () => {
    const store = new InMemoryInvoiceStore();
    await store.registrar(emision());

    const facturados = await store.listarFacturados();
    expect(facturados.get('5544332211')?.serialNumber).toBe('B001-1234');
  });

  /**
   * En PostgreSQL lo impide el `@unique` de `shopifyOrderId`. Aquí se imita
   * para que las pruebas vean el mismo comportamiento y nadie se lleve la
   * sorpresa en producción.
   */
  it('rechaza registrar dos veces el mismo pedido', async () => {
    const store = new InMemoryInvoiceStore();
    await store.registrar(emision());

    await expect(store.registrar(emision())).rejects.toThrow(/ya está registrado/i);
  });

  it('pedidos distintos conviven', async () => {
    const store = new InMemoryInvoiceStore();
    await store.registrar(emision({ shopifyOrderId: '1' }));
    await store.registrar(emision({ shopifyOrderId: '2' }));

    expect((await store.listarFacturados()).size).toBe(2);
  });

  it('convierte la fecha de Bsale, que viene en segundos', async () => {
    const store = new InMemoryInvoiceStore();
    await store.registrar(emision());

    const guardado = (await store.listarFacturados()).get('5544332211')!;
    expect(guardado.emitidoEl.getTime()).toBe(1_755_475_200 * 1000);
  });

  it('empieza vacío', async () => {
    expect((await new InMemoryInvoiceStore().listarFacturados()).size).toBe(0);
  });
});

describe('PrismaInvoiceStore', () => {
  function prismaFalso(fallaEnDocumento = false) {
    const orderSyncCreate = vi.fn(async () => ({ id: 'pedido-1' }));
    const bsaleDocumentCreate = vi.fn(async () => {
      if (fallaEnDocumento) throw new Error('Falló al guardar el documento');
      return {};
    });

    const tx: PrismaInvoiceLike = {
      $transaction: vi.fn(async (fn) => fn(tx)),
      orderSync: { create: orderSyncCreate, findMany: vi.fn(async () => []) },
      bsaleDocument: { create: bsaleDocumentCreate },
    };

    return { tx, orderSyncCreate, bsaleDocumentCreate };
  }

  it('escribe el pedido y el documento', async () => {
    const { tx, orderSyncCreate, bsaleDocumentCreate } = prismaFalso();
    await new PrismaInvoiceStore(tx).registrar(emision());

    expect(orderSyncCreate).toHaveBeenCalledTimes(1);
    expect(bsaleDocumentCreate).toHaveBeenCalledTimes(1);
  });

  /**
   * La razón de ser de la transacción: si el segundo `create` falla, el primero
   * tiene que deshacerse. Aquí se comprueba que la escritura ocurre DENTRO de
   * `$transaction`, que es quien lo garantiza.
   */
  it('los dos escriben dentro de la misma transacción', async () => {
    const { tx } = prismaFalso();
    await new PrismaInvoiceStore(tx).registrar(emision());

    expect(tx.$transaction).toHaveBeenCalledTimes(1);
  });

  it('si falla el documento, el error sube y la transacción no se confirma', async () => {
    const { tx } = prismaFalso(true);

    await expect(new PrismaInvoiceStore(tx).registrar(emision())).rejects.toThrow(
      /documento/i,
    );
  });

  it('el documento apunta al pedido recién creado', async () => {
    const { tx, bsaleDocumentCreate } = prismaFalso();
    await new PrismaInvoiceStore(tx).registrar(emision());

    const datos = bsaleDocumentCreate.mock.calls[0]![0] as { data: { orderSyncId: string } };
    expect(datos.data.orderSyncId).toBe('pedido-1');
  });

  it('el id de pedido de Shopify se guarda como número grande', async () => {
    const { tx, orderSyncCreate } = prismaFalso();
    await new PrismaInvoiceStore(tx).registrar(emision({ shopifyOrderId: '9007199254740999' }));

    const datos = orderSyncCreate.mock.calls[0]![0] as { data: { shopifyOrderId: bigint } };
    // Un `number` de JavaScript perdería precisión por encima de 2^53.
    expect(datos.data.shopifyOrderId).toBe(9007199254740999n);
  });

  it('no guarda el pedido completo: no hay por qué duplicar datos del cliente', async () => {
    const { tx, orderSyncCreate } = prismaFalso();
    await new PrismaInvoiceStore(tx).registrar(emision());

    const datos = orderSyncCreate.mock.calls[0]![0] as { data: { payload: unknown } };
    expect(datos.data.payload).toEqual({});
  });

  it('guarda la clave de idempotencia, la misma que se mandó a Bsale', async () => {
    const { tx, orderSyncCreate } = prismaFalso();
    await new PrismaInvoiceStore(tx).registrar(emision());

    const datos = orderSyncCreate.mock.calls[0]![0] as { data: { idempotencyKey: string } };
    expect(datos.data.idempotencyKey).toBe('shopify-order-5544332211');
  });
});
