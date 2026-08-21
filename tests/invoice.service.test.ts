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
  type ConfigComprobante,
} from '../src/services/invoice.service.js';
import type { PedidoShopify } from '../src/integrations/shopify/client.js';

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
