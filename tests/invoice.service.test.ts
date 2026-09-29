/**
 * Pruebas de la construcción del comprobante.
 *
 * Aquí se prueba sobre todo lo que **debe impedir** emitir: un total que no
 * cuadra, una línea sin SKU, un RUC inválido. Emitir de más se corrige con una
 * anulación ante SUNAT; no emitir se corrige pulsando otra vez.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  planificarComprobante,
  emitirComprobante,
  claveIdempotencia,
  fechaEmision,
  correoDelCliente,
  planificarNotaCredito,
  emitirNotaCredito,
  type ConfigComprobante,
  type ConfigNotaCredito,
} from '../src/services/invoice.service.js';
import type { PedidoShopify } from '../src/integrations/shopify/client.js';
import type { DocumentoConDetalle } from '../src/integrations/bsale/client.js';
import type { EmisionOriginal } from '../src/db/invoice.store.js';

const RUC = '20131312955';

const CONFIG: ConfigComprobante = {
  officeId: 1,
  priceListId: 4,
  doctypeBoletaId: 1,
  doctypeFacturaId: 50,
  taxIdIgv: 1,
  tasaIgv: 0.18,
  descontarStock: false,
  enviarCorreo: true,
};

/** Un pedido de S/ 118,00: S/ 100 netos + 18 % de IGV. */
function pedido(over: Partial<PedidoShopify> = {}): PedidoShopify {
  return {
    id: 'gid://shopify/Order/1',
    legacyId: '5544332211',
    nombre: '#1058',
    creadoEl: '2026-08-18T23:30:00Z',
    estadoPago: 'PAID',
    estadoEnvio: 'UNFULFILLED',
    impuestosIncluidos: true,
    moneda: 'PEN',
    email: 'cliente@ejemplo.pe',
    cliente: { id: 'gid://c/1', nombre: 'Ana Quispe', email: 'cliente@ejemplo.pe' },
    empresa: null,
    direccion: {
      linea1: 'Av. Siempre Viva 123',
      linea2: null,
      ciudad: 'Lima',
      provincia: 'Lima',
      pais: 'PE',
      telefono: null,
    },
    total: 118,
    envio: 0,
    impuestos: 18,
    lineas: [
      {
        id: 'gid://li/1',
        titulo: 'BRIT CARE SALMON 3KG',
        cantidad: 1,
        sku: '74352029961567',
        precioOriginal: 118,
        precioConDescuento: 118,
      },
    ],
    ...over,
  };
}

describe('planificarComprobante', () => {
  it('sin identificación emite boleta', () => {
    const plan = planificarComprobante(pedido(), CONFIG);

    expect(plan.decision.comprobante).toBe('BOLETA');
    expect(plan.documento?.documentTypeId).toBe(CONFIG.doctypeBoletaId);
    expect(plan.motivos).toEqual([]);
  });

  it('con RUC válido en el campo Empresa emite factura', () => {
    const plan = planificarComprobante(pedido({ empresa: `${RUC} MUNDO LOVE PET SAC` }), CONFIG);

    expect(plan.decision.comprobante).toBe('FACTURA');
    expect(plan.documento?.documentTypeId).toBe(CONFIG.doctypeFacturaId);
  });

  describe('el IGV', () => {
    it('quita el 18 % del precio cuando la tienda lo incluye', () => {
      const plan = planificarComprobante(pedido(), CONFIG);

      // 118 / 1,18 = 100
      expect(plan.documento?.details[0]!.netUnitValue).toBeCloseTo(100, 6);
      expect(plan.resumen.neto).toBe(100);
      expect(plan.resumen.igv).toBe(18);
      expect(plan.resumen.total).toBe(118);
    });

    it('no lo quita si la tienda no incluye impuestos, y avisa', () => {
      const plan = planificarComprobante(
        pedido({ impuestosIncluidos: false, total: 118, lineas: [
          { id: 'l', titulo: 'X', cantidad: 1, sku: 'A', precioOriginal: 100, precioConDescuento: 100 },
        ] }),
        CONFIG,
      );

      expect(plan.documento?.details[0]!.netUnitValue).toBe(100);
      expect(plan.avisos.join(' ')).toMatch(/no incluyen impuestos/i);
    });

    it('manda el id del impuesto entre corchetes, como pide Bsale', () => {
      const plan = planificarComprobante(pedido(), CONFIG);
      expect(plan.documento?.details[0]!.taxId).toBe('[1]');
    });
  });

  it('el envío va como una línea más, sin SKU', () => {
    const plan = planificarComprobante(
      pedido({ envio: 11.8, total: 129.8 }),
      CONFIG,
    );

    const envio = plan.documento!.details.find((d) => d.comment === 'Envío');
    expect(envio).toBeDefined();
    expect(envio!.code).toBeUndefined();
    expect(envio!.netUnitValue).toBeCloseTo(10, 6);
    expect(plan.motivos).toEqual([]);
  });

  it('usa el precio ya rebajado, sin descuento por porcentaje', () => {
    const plan = planificarComprobante(
      pedido({
        total: 59,
        lineas: [
          {
            id: 'l',
            titulo: 'X',
            cantidad: 1,
            sku: 'A',
            precioOriginal: 118,
            precioConDescuento: 59,
          },
        ],
      }),
      CONFIG,
    );

    expect(plan.documento?.details[0]!.netUnitValue).toBeCloseTo(50, 6);
    expect(plan.documento?.details[0]!.discount).toBeUndefined();
  });

  /**
   * El bloque que justifica el servicio. Todo lo de aquí sale del panel como
   * «revisar», y ninguno llega a Bsale.
   */
  describe('cuando NO se emite', () => {
    it('el total no cuadra con lo que cobró Shopify', () => {
      // Shopify cobró 200 pero las líneas suman 118: falta algo por entender.
      const plan = planificarComprobante(pedido({ total: 200 }), CONFIG);

      expect(plan.documento).toBeNull();
      expect(plan.motivos.join(' ')).toMatch(/no cuadra/i);
    });

    it('una línea sin SKU', () => {
      const plan = planificarComprobante(
        pedido({ lineas: [{ id: 'l', titulo: 'Sin código', cantidad: 1, sku: null, precioOriginal: 118, precioConDescuento: 118 }] }),
        CONFIG,
      );

      expect(plan.documento).toBeNull();
      expect(plan.motivos.join(' ')).toMatch(/no tiene SKU/i);
    });

    it('un RUC inválido: no se degrada a boleta', () => {
      const plan = planificarComprobante(pedido({ empresa: '20131312954' }), CONFIG);

      expect(plan.documento).toBeNull();
      expect(plan.decision.comprobante).toBeNull();
    });

    it('un pedido sin líneas', () => {
      const plan = planificarComprobante(pedido({ lineas: [], total: 0 }), CONFIG);

      expect(plan.documento).toBeNull();
      expect(plan.motivos.join(' ')).toMatch(/ninguna línea/i);
    });

    it('tolera dos céntimos de redondeo, no más', () => {
      expect(planificarComprobante(pedido({ total: 118.02 }), CONFIG).documento).not.toBeNull();
      expect(planificarComprobante(pedido({ total: 118.05 }), CONFIG).documento).toBeNull();
    });

    it('nunca lanza, por raro que sea el pedido', () => {
      expect(() =>
        planificarComprobante(
          pedido({ lineas: [{ id: 'l', titulo: '', cantidad: 0, sku: '', precioOriginal: 0, precioConDescuento: 0 }], total: 0 }),
          CONFIG,
        ),
      ).not.toThrow();
    });
  });
});

describe('claveIdempotencia', () => {
  it('es la misma para el mismo pedido: es lo que impide el duplicado', () => {
    expect(claveIdempotencia(pedido())).toBe('shopify-order-5544332211');
    expect(claveIdempotencia(pedido())).toBe(claveIdempotencia(pedido()));
  });

  it('cambia con el pedido', () => {
    expect(claveIdempotencia(pedido({ legacyId: '999' }))).not.toBe(claveIdempotencia(pedido()));
  });

  it('viaja en el documento', () => {
    expect(planificarComprobante(pedido(), CONFIG).documento?.salesId).toBe(
      'shopify-order-5544332211',
    );
  });
});

describe('fechaEmision', () => {
  /**
   * Bsale avisa de que a este campo no se le aplica zona horaria. Un pedido de
   * las 23:30 en Lima no debe emitirse con la fecha del día siguiente: eso
   * descuadra la declaración mensual.
   */
  it('se queda en la fecha, sin arrastrar la hora', () => {
    const segundos = fechaEmision(new Date('2026-08-18T23:30:00Z'));
    const vuelta = new Date(segundos * 1000);

    expect(vuelta.getUTCHours()).toBe(0);
    expect(vuelta.getUTCDate()).toBe(18);
    expect(vuelta.getUTCMonth()).toBe(7);
  });
});

describe('emitirComprobante', () => {
  function clienteFalso(over: Record<string, unknown> = {}) {
    return {
      buscarCliente: vi.fn(async () => null),
      crearCliente: vi.fn(async () => ({ id: 77 })),
      emitirDocumento: vi.fn(async () => ({
        id: 500,
        number: 1234,
        serialNumber: 'B001-1234',
        emissionDate: 1755475200,
        totalAmount: 118,
        token: 'abc123',
        informed: 0,
        salesId: 'shopify-order-5544332211',
      })),
      ...over,
    };
  }

  it('no emite si el plan no tiene documento', async () => {
    const client = clienteFalso();
    const plan = planificarComprobante(pedido({ total: 200 }), CONFIG);

    const r = await emitirComprobante(client as never, plan);

    expect(r.ok).toBe(false);
    expect(client.emitirDocumento).not.toHaveBeenCalled();
  });

  it('reutiliza el cliente que ya existe en Bsale, no lo duplica', async () => {
    const client = clienteFalso({ buscarCliente: vi.fn(async () => ({ id: 42, code: RUC })) });
    const plan = planificarComprobante(pedido({ empresa: `${RUC} MI EMPRESA SAC` }), CONFIG);

    await emitirComprobante(client as never, plan);

    expect(client.crearCliente).not.toHaveBeenCalled();
    expect(client.emitirDocumento).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 42 }),
    );
  });

  it('crea el cliente sólo si no existe', async () => {
    const client = clienteFalso();
    const plan = planificarComprobante(pedido({ empresa: `${RUC} MI EMPRESA SAC` }), CONFIG);

    await emitirComprobante(client as never, plan);

    expect(client.buscarCliente).toHaveBeenCalledWith(RUC);
    expect(client.crearCliente).toHaveBeenCalledWith(
      expect.objectContaining({ code: RUC, companyOrPerson: 1, company: 'MI EMPRESA SAC' }),
    );
  });

  it('la boleta a consumidor final no crea ningún cliente', async () => {
    const client = clienteFalso();
    const plan = planificarComprobante(pedido(), CONFIG);

    await emitirComprobante(client as never, plan);

    expect(client.buscarCliente).not.toHaveBeenCalled();
    expect(client.crearCliente).not.toHaveBeenCalled();
  });

  it('un DNI crea el cliente como persona, no como empresa', async () => {
    const client = clienteFalso();
    const plan = planificarComprobante(pedido({ empresa: 'DNI 45678912' }), CONFIG);

    await emitirComprobante(client as never, plan);

    expect(client.crearCliente).toHaveBeenCalledWith(
      expect.objectContaining({ companyOrPerson: 0, firstName: 'Ana', lastName: 'Quispe' }),
    );
  });

  it('devuelve el comprobante emitido', async () => {
    const client = clienteFalso();
    const r = await emitirComprobante(client as never, planificarComprobante(pedido(), CONFIG));

    expect(r.ok).toBe(true);
    expect(r.documento?.serialNumber).toBe('B001-1234');
  });

  it('un fallo de Bsale se devuelve como error, no como excepción', async () => {
    const client = clienteFalso({
      emitirDocumento: vi.fn(async () => {
        throw new Error('Tipo de documento no habilitado');
      }),
    });

    const r = await emitirComprobante(client as never, planificarComprobante(pedido(), CONFIG));

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no habilitado/);
  });
});

/**
 * El comprobante lo manda Bsale, no esta app: su API acepta `sendEmail` y usa
 * su plantilla y su remitente. Montar un envío propio exigiría contratar un
 * servicio de correo y competiría con el suyo.
 */
describe('el correo al cliente', () => {
  it('se pide a Bsale que lo envíe', () => {
    const plan = planificarComprobante(pedido(), CONFIG);
    expect(plan.documento?.sendEmail).toBe(1);
  });

  it('no se pide si está desactivado', () => {
    const plan = planificarComprobante(pedido(), { ...CONFIG, enviarCorreo: false });
    expect(plan.documento?.sendEmail).toBeUndefined();
  });

  /**
   * Pedir el envío sin destinatario no manda nada, pero deja en Bsale un rastro
   * de correos que nunca salieron. Mejor no pedirlo.
   */
  it('no se pide si el pedido no tiene correo', () => {
    const plan = planificarComprobante(
      pedido({ email: null, cliente: { id: 'c', nombre: 'Ana', email: null } }),
      CONFIG,
    );
    expect(plan.documento?.sendEmail).toBeUndefined();
  });

  describe('de dónde sale el correo', () => {
    it('prefiere el de la ficha del cliente', () => {
      const p = pedido({
        email: 'del-pedido@ejemplo.pe',
        cliente: { id: 'c', nombre: 'Ana', email: 'de-la-ficha@ejemplo.pe' },
      });
      expect(correoDelCliente(p)).toBe('de-la-ficha@ejemplo.pe');
    });

    it('si la ficha no tiene, usa el del pedido', () => {
      const p = pedido({
        email: 'del-pedido@ejemplo.pe',
        cliente: { id: 'c', nombre: 'Ana', email: null },
      });
      expect(correoDelCliente(p)).toBe('del-pedido@ejemplo.pe');
    });

    it('un pedido sin ningún correo devuelve null', () => {
      const p = pedido({ email: null, cliente: null });
      expect(correoDelCliente(p)).toBeNull();
    });

    it('algo que no parece un correo se descarta', () => {
      const p = pedido({ email: 'esto-no-es-un-correo', cliente: null });
      expect(correoDelCliente(p)).toBeNull();
    });
  });
});

/**
 * Una venta web no le avisa a Bsale por ningún otro camino: no hay webhook de
 * pedidos de Shopify, y el stock sólo viaja de Bsale hacia Shopify, nunca al
 * revés. `dispatch` en el documento es la única baja real que recibe Bsale —
 * sin ella, el próximo ciclo de sincronización deshace la baja que la propia
 * venta ya había hecho en Shopify.
 */
describe('el descuento de stock al emitir', () => {
  it('con descontarStock activado, pide a Bsale que despache y baje el stock', () => {
    const plan = planificarComprobante(pedido(), { ...CONFIG, descontarStock: true });
    expect(plan.documento?.dispatch).toBe(1);
  });

  it('con descontarStock desactivado, no lo pide', () => {
    const plan = planificarComprobante(pedido(), { ...CONFIG, descontarStock: false });
    expect(plan.documento?.dispatch).toBe(0);
  });
});

describe('planificarNotaCredito', () => {
  const CONFIG_NOTA: ConfigNotaCredito = {
    officeId: 1,
    doctypeNotaCreditoBoletaId: 9,
    doctypeNotaCreditoFacturaId: 43,
  };

  function emision(over: Partial<EmisionOriginal> = {}): EmisionOriginal {
    return {
      orderSyncId: 'cuid-orden-1',
      bsaleDocumentId: 500,
      documentTypeId: 1,
      kind: 'BOLETA',
      serialNumber: 'B001-1234',
      number: 1234,
      ...over,
    };
  }

  function documentoOriginal(over: Partial<DocumentoConDetalle> = {}): DocumentoConDetalle {
    return {
      id: 500,
      client: { code: '45678912', city: 'Lima' },
      details: { items: [{ id: 9001, quantity: 2, netUnitValue: 50 }] },
      ...over,
    };
  }

  it('arma la nota con el documentTypeId de boleta o factura según corresponda', () => {
    const planBoleta = planificarNotaCredito(emision({ kind: 'BOLETA' }), documentoOriginal(), 'Cliente arrepentido', CONFIG_NOTA);
    expect(planBoleta.nota?.documentTypeId).toBe(9);

    const planFactura = planificarNotaCredito(emision({ kind: 'FACTURA' }), documentoOriginal(), 'Cliente arrepentido', CONFIG_NOTA);
    expect(planFactura.nota?.documentTypeId).toBe(43);
  });

  it('referencia el documento original por su id, no por el salesId ni el pedido de Shopify', () => {
    const plan = planificarNotaCredito(emision({ bsaleDocumentId: 777 }), documentoOriginal({ id: 777 }), 'Reembolso', CONFIG_NOTA);
    expect(plan.nota?.referenceDocumentId).toBe(777);
  });

  it('siempre es type:0 (devolución de dinero) — el único caso que cubre esta app', () => {
    const plan = planificarNotaCredito(emision(), documentoOriginal(), 'Reembolso', CONFIG_NOTA);
    expect(plan.nota?.type).toBe(0);
    expect(plan.nota?.priceAdjustment).toBe(0);
    expect(plan.nota?.editTexts).toBe(0);
    expect(plan.nota?.declare).toBe(1);
  });

  it('copia las líneas del documento original por su documentDetailId, no por SKU', () => {
    const doc = documentoOriginal({
      details: { items: [{ id: 111, quantity: 1, netUnitValue: 10 }, { id: 222, quantity: 3, netUnitValue: 20 }] },
    });
    const plan = planificarNotaCredito(emision(), doc, 'Reembolso', CONFIG_NOTA);
    expect(plan.nota?.details).toEqual([
      { documentDetailId: 111, quantity: 1 },
      { documentDetailId: 222, quantity: 3 },
    ]);
  });

  it('sólo reenvía del cliente original los campos conocidos, no el objeto crudo de Bsale', () => {
    const doc = documentoOriginal({
      client: { id: 55, href: 'https://api.bsale.io/v1/clients/55.json', code: '45678912', city: 'Lima', algoInesperado: 'x' },
    });
    const plan = planificarNotaCredito(emision(), doc, 'Reembolso', CONFIG_NOTA);
    expect(plan.nota?.client).toEqual({ code: '45678912', city: 'Lima' });
  });

  it('sin cliente en el documento original (boleta a consumidor final), no manda client', () => {
    const doc = documentoOriginal({ client: null });
    const plan = planificarNotaCredito(emision(), doc, 'Reembolso', CONFIG_NOTA);
    expect(plan.nota?.client).toBeUndefined();
  });

  it('no arma nada si falta el doctype de nota de crédito para ese tipo', () => {
    const plan = planificarNotaCredito(emision({ kind: 'BOLETA' }), documentoOriginal(), 'Reembolso', {
      officeId: 1,
      doctypeNotaCreditoFacturaId: 43,
      // doctypeNotaCreditoBoletaId ausente a propósito.
    });
    expect(plan.nota).toBeNull();
    expect(plan.motivos.join(' ')).toMatch(/BSALE_DOCTYPE_NOTA_CREDITO_BOLETA_ID/);
  });

  it('no arma nada si el documento original no tiene líneas', () => {
    const plan = planificarNotaCredito(emision(), documentoOriginal({ details: { items: [] } }), 'Reembolso', CONFIG_NOTA);
    expect(plan.nota).toBeNull();
    expect(plan.motivos.join(' ')).toMatch(/no tiene líneas/);
  });

  it('no arma nada sin motivo', () => {
    const plan = planificarNotaCredito(emision(), documentoOriginal(), '   ', CONFIG_NOTA);
    expect(plan.nota).toBeNull();
    expect(plan.motivos.join(' ')).toMatch(/motivo/i);
  });
});

describe('emitirNotaCredito', () => {
  function bsaleFalso(over: Record<string, unknown> = {}) {
    return {
      emitirNotaCredito: vi.fn(async () => ({
        id: 900,
        number: 55,
        serialNumber: 'BC01-55',
        emissionDate: 1755475200,
        totalAmount: 118,
        token: 'xyz',
        informed: 0,
      })),
      ...over,
    };
  }

  const CONFIG_NOTA: ConfigNotaCredito = { officeId: 1, doctypeNotaCreditoBoletaId: 9 };

  it('no llama a Bsale si el plan no se pudo armar', async () => {
    const bsale = bsaleFalso();
    const plan = planificarNotaCredito(
      { orderSyncId: 'x', bsaleDocumentId: 1, documentTypeId: 1, kind: 'BOLETA', serialNumber: 'B1', number: 1 },
      { id: 1, details: { items: [] } },
      'Reembolso',
      CONFIG_NOTA,
    );
    const r = await emitirNotaCredito(bsale as never, plan);

    expect(r.ok).toBe(false);
    expect(bsale.emitirNotaCredito).not.toHaveBeenCalled();
  });

  it('devuelve la nota de crédito emitida', async () => {
    const bsale = bsaleFalso();
    const plan = planificarNotaCredito(
      { orderSyncId: 'x', bsaleDocumentId: 1, documentTypeId: 1, kind: 'BOLETA', serialNumber: 'B1', number: 1 },
      { id: 1, details: { items: [{ id: 1, quantity: 1, netUnitValue: 10 }] } },
      'Reembolso',
      CONFIG_NOTA,
    );
    const r = await emitirNotaCredito(bsale as never, plan);

    expect(r.ok).toBe(true);
    expect(r.documento?.serialNumber).toBe('BC01-55');
  });

  it('un fallo de Bsale se devuelve como error, no como excepción', async () => {
    const bsale = bsaleFalso({
      emitirNotaCredito: vi.fn(async () => {
        throw new Error('El documento ya fue anulado');
      }),
    });
    const plan = planificarNotaCredito(
      { orderSyncId: 'x', bsaleDocumentId: 1, documentTypeId: 1, kind: 'BOLETA', serialNumber: 'B1', number: 1 },
      { id: 1, details: { items: [{ id: 1, quantity: 1, netUnitValue: 10 }] } },
      'Reembolso',
      CONFIG_NOTA,
    );
    const r = await emitirNotaCredito(bsale as never, plan);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ya fue anulado/);
  });
});
