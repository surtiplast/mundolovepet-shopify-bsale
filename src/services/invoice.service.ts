/**
 * Construcción del comprobante a partir de un pedido de Shopify.
 *
 * ── Qué hace y qué NO hace ───────────────────────────────────────────────────
 *
 * `planificarComprobante` es una función **pura**: recibe un pedido y devuelve
 * el JSON que habría que mandarle a Bsale, o el motivo por el que no se puede.
 * No llama a nadie. Eso permite simular el comprobante entero —importes,
 * impuestos, tipo de documento— sin emitir nada y sin tocar la red.
 *
 * Emitir es un paso aparte, `emitirComprobante`, y es el único que escribe.
 *
 * ── El cálculo del IGV ───────────────────────────────────────────────────────
 *
 * Es lo que más fácil se hace mal. En Perú los precios de la tienda llevan el
 * IGV dentro: si un producto vale S/ 101,00 en Shopify, esos 101 incluyen el
 * 18 %. Bsale quiere el valor **sin** impuesto, así que hay que dividir:
 *
 *     101,00 / 1,18 = 85,593220…
 *
 * Shopify dice en cada pedido si sus precios incluyen impuestos
 * (`taxesIncluded`). No se asume: si un día la tienda cambia esa configuración,
 * asumirlo emitiría todos los comprobantes con un 18 % de más o de menos.
 *
 * ── Por qué el descuento va incorporado y no como porcentaje ─────────────────
 *
 * Bsale admite un `discount` en porcentaje por línea. No se usa: se manda
 * directamente el precio ya rebajado. Un porcentaje obliga a redondear dos
 * veces —al calcular el porcentaje y al aplicarlo— y basta un céntimo de deriva
 * para que el documento no cuadre con el cobro de Shopify. Con el precio final
 * el total sale exacto por construcción.
 */
import type { PedidoShopify } from '../integrations/shopify/client.js';
import type {
  BsaleClient,
  DetalleDocumento,
  NuevoDocumento,
  DocumentoEmitido,
} from '../integrations/bsale/client.js';
import { decidirComprobante, type DecisionComprobante } from '../domain/documento.js';

/** Configuración que sale de las variables de entorno, ya validada. */
export interface ConfigComprobante {
  officeId: number;
  priceListId?: number;
  doctypeBoletaId: number;
  doctypeFacturaId: number;
  taxIdIgv: number;
  /** El IGV como fracción: 0,18. */
  tasaIgv: number;
  /** Si se descuenta stock en Bsale al emitir. */
  descontarStock: boolean;
  /**
   * Si Bsale manda el comprobante por correo al cliente.
   *
   * Lo envía Bsale, no esta app: su API acepta `sendEmail` al emitir y usa su
   * propia plantilla y su remitente ya configurado. Montar un envío propio
   * exigiría contratar un servicio de correo y pelear con la reputación del
   * dominio para no acabar en spam, y competiría con el suyo.
   */
  enviarCorreo: boolean;
}

export interface PlanComprobante {
  /** El pedido tal cual, para poder enseñarlo en el panel. */
  pedido: PedidoShopify;
  decision: DecisionComprobante;
  /** `null` cuando no se puede emitir. `motivos` explica por qué. */
  documento: NuevoDocumento | null;
  /** Lo que impide emitir. Vacío cuando todo está bien. */
  motivos: string[];
  /** Avisos que no impiden emitir, pero conviene leer. */
  avisos: string[];
  resumen: {
    neto: number;
    igv: number;
    total: number;
    /** El total que cobró Shopify. Debe cuadrar con `total`. */
    totalShopify: number;
    diferencia: number;
  };
}

/** Margen de cuadre, en soles. Dos céntimos absorben el redondeo, nada más. */
const TOLERANCIA = 0.02;

/** La clave anti-duplicado. Determinista: el mismo pedido da siempre la misma. */
export function claveIdempotencia(pedido: PedidoShopify): string {
  return `shopify-order-${pedido.legacyId}`;
}

/**
 * El correo al que mandar el comprobante.
 *
 * Se prefiere el del cliente registrado sobre el del pedido: son casi siempre
 * el mismo, pero si difieren, el de la ficha del cliente es el que él mantiene
 * al día.
 */
export function correoDelCliente(pedido: PedidoShopify): string | null {
  const correo = pedido.cliente?.email?.trim() || pedido.email?.trim() || null;
  // Una comprobación mínima. No se valida a fondo a propósito: Shopify ya exige
  // un correo válido en el checkout, y rechazar aquí por un formato raro
  // impediría emitir un comprobante que sí es correcto.
  return correo && correo.includes('@') ? correo : null;
}

function redondear(valor: number, decimales = 6): number {
  const f = 10 ** decimales;
  return Math.round(valor * f) / f;
}

function aDosDecimales(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * Fecha de emisión en segundos, a medianoche UTC.
 *
 * Bsale avisa de que a este campo **no se le aplica zona horaria**: sólo cuenta
 * la fecha. Mandar la hora local haría que un pedido de las 23:30 en Lima se
 * emitiera con la fecha del día siguiente, y eso descuadra la declaración
 * mensual.
 */
export function fechaEmision(fecha: Date): number {
  return Math.floor(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()) / 1000);
}

/**
 * Decide y arma el comprobante. **No llama a nadie.**
 *
 * Devuelve siempre un plan; si no se puede emitir, `documento` viene a `null` y
 * `motivos` dice por qué. Nunca lanza: un pedido problemático tiene que poder
 * mostrarse en el panel, no reventar la pantalla entera.
 */
export function planificarComprobante(
  pedido: PedidoShopify,
  config: ConfigComprobante,
): PlanComprobante {
  const motivos: string[] = [];
  const avisos: string[] = [];

  const decision = decidirComprobante(pedido.empresa);
  if (decision.requiereRevision) motivos.push(decision.motivo);

  const factor = pedido.impuestosIncluidos ? 1 + config.tasaIgv : 1;
  if (!pedido.impuestosIncluidos) {
    avisos.push(
      'Los precios de este pedido NO incluyen impuestos según Shopify. Se toman como valor neto. ' +
        'Si es un error de configuración de la tienda, el comprobante saldría con el IGV mal.',
    );
  }

  const details: DetalleDocumento[] = [];
  let neto = 0;

  for (const linea of pedido.lineas) {
    if (!linea.sku?.trim()) {
      motivos.push(`La línea «${linea.titulo}» no tiene SKU: Bsale no puede saber qué producto es.`);
      continue;
    }
    if (linea.cantidad <= 0) {
      avisos.push(`La línea «${linea.titulo}» tiene cantidad ${linea.cantidad}; se omite.`);
      continue;
    }

    const unitarioNeto = redondear(linea.precioConDescuento / factor);
    if (unitarioNeto < 0) {
      motivos.push(
        `La línea «${linea.titulo}» sale a un valor negativo. Bsale y SUNAT lo rechazan.`,
      );
      continue;
    }

    details.push({
      code: linea.sku.trim(),
      netUnitValue: unitarioNeto,
      quantity: linea.cantidad,
      taxId: `[${config.taxIdIgv}]`,
      comment: linea.titulo.slice(0, 100),
    });

    neto += unitarioNeto * linea.cantidad;
  }

  // ── El envío ──────────────────────────────────────────────────────────────
  // Va como una línea más, sin `code`: no es un producto del inventario, así que
  // no debe descontar stock ni buscarse en el catálogo de Bsale.
  if (pedido.envio > 0) {
    const envioNeto = redondear(pedido.envio / factor);
    details.push({
      netUnitValue: envioNeto,
      quantity: 1,
      taxId: `[${config.taxIdIgv}]`,
      comment: 'Envío',
    });
    neto += envioNeto;
  }

  if (details.length === 0) {
    motivos.push('El pedido no tiene ninguna línea facturable.');
  }

  const igv = neto * config.tasaIgv;
  const total = aDosDecimales(neto + igv);
  const diferencia = aDosDecimales(total - pedido.total);

  // ── El cuadre ─────────────────────────────────────────────────────────────
  // Si lo calculado no coincide con lo que cobró Shopify, algo se ha entendido
  // mal: un descuento de pedido, una propina, un impuesto distinto. Emitir un
  // comprobante por un importe que no es el cobrado es un problema con SUNAT y
  // con el cliente, así que se para aquí.
  if (details.length > 0 && Math.abs(diferencia) > TOLERANCIA) {
    motivos.push(
      `El total calculado (S/ ${total.toFixed(2)}) no cuadra con el que cobró Shopify ` +
        `(S/ ${pedido.total.toFixed(2)}): sobran o faltan S/ ${Math.abs(diferencia).toFixed(2)}. ` +
        'Puede ser un descuento a nivel de pedido o un impuesto distinto. No se emite nada.',
    );
  }

  const resumen = {
    neto: aDosDecimales(neto),
    igv: aDosDecimales(igv),
    total,
    totalShopify: aDosDecimales(pedido.total),
    diferencia,
  };

  if (motivos.length > 0 || !decision.comprobante) {
    return { pedido, decision, documento: null, motivos, avisos, resumen };
  }

  const emision = fechaEmision(new Date(pedido.creadoEl));

  const documento: NuevoDocumento = {
    documentTypeId:
      decision.comprobante === 'FACTURA' ? config.doctypeFacturaId : config.doctypeBoletaId,
    officeId: config.officeId,
    ...(config.priceListId ? { priceListId: config.priceListId } : {}),
    emissionDate: emision,
    expirationDate: emision,
    declare: 1,
    details,
    // Deja rastro del pedido en el propio comprobante, para poder cotejarlos
    // sin salir de Bsale.
    references: [
      {
        number: pedido.nombre.replace('#', ''),
        referenceDate: emision,
        reason: `Pedido Shopify ${pedido.nombre}`,
        code: '801',
      },
    ],
    salesId: claveIdempotencia(pedido),
    dispatch: config.descontarStock ? 1 : 0,
    // Bsale manda el comprobante al correo del cliente. Se pone sólo si hay
    // correo que usar: pedírselo sin destinatario no haría nada, pero deja un
    // rastro confuso en Bsale de envíos que nunca salieron.
    ...(config.enviarCorreo && correoDelCliente(pedido) ? { sendEmail: 1 as const } : {}),
  };

  return { pedido, decision, documento, motivos, avisos, resumen };
}

export interface ResultadoEmision {
  ok: boolean;
  documento: DocumentoEmitido | null;
  /** `true` si Bsale devolvió uno que ya existía en vez de crear otro. */
  yaExistia: boolean;
  error: string | null;
}

/**
 * Emite de verdad. **Esto declara ante SUNAT y no se deshace con un despliegue.**
 *
 * Antes de llamar a Bsale resuelve el cliente: se busca por DNI/RUC y sólo se
 * crea si no existe. Buscar primero evita llenar Bsale de clientes duplicados,
 * que es lo que pasa cuando cada pedido crea uno nuevo.
 *
 * Para la boleta a consumidor final no se toca el cliente en absoluto: Bsale no
 * lo exige y crear un «cliente sin datos» por cada compra anónima ensucia la
 * base para nada.
 */
export async function emitirComprobante(
  client: BsaleClient,
  plan: PlanComprobante,
): Promise<ResultadoEmision> {
  if (!plan.documento) {
    return {
      ok: false,
      documento: null,
      yaExistia: false,
      error: plan.motivos.join(' | ') || 'El pedido no se puede facturar.',
    };
  }

  const { identificacion, comprobante } = plan.decision;
  const documento = { ...plan.documento };

  try {
    if (identificacion.numero) {
      const existente = await client.buscarCliente(identificacion.numero);

      if (existente) {
        documento.clientId = existente.id;
      } else {
        const esEmpresa = identificacion.tipo === 'RUC';
        const nombreCompleto = plan.pedido.cliente?.nombre ?? '';
        const [firstName, ...resto] = nombreCompleto.split(' ');

        const creado = await client.crearCliente({
          code: identificacion.numero,
          companyOrPerson: esEmpresa ? 1 : 0,
          // Para factura la razón social es obligatoria. Si el cliente no la
          // escribió, se usa su nombre: es mejor que dejarlo vacío y que Bsale
          // rechace la emisión.
          company: esEmpresa ? identificacion.razonSocial || nombreCompleto || null : null,
          firstName: esEmpresa ? null : firstName || null,
          lastName: esEmpresa ? null : resto.join(' ') || null,
          // Sin correo en la ficha, Bsale no tiene a dónde mandar el
          // comprobante aunque se le pida.
          email: correoDelCliente(plan.pedido),
          address: plan.pedido.direccion.linea1,
          city: plan.pedido.direccion.ciudad,
          municipality: plan.pedido.direccion.provincia,
        });

        documento.clientId = creado.id;
      }
    } else if (comprobante === 'FACTURA') {
      // No debería pasar —una factura sin RUC no llega hasta aquí—, pero si
      // pasara, emitirla sin cliente la haría rechazable por SUNAT.
      return {
        ok: false,
        documento: null,
        yaExistia: false,
        error: 'Una factura necesita cliente identificado.',
      };
    }

    const emitido = await client.emitirDocumento(documento);

    // Bsale devuelve el documento ya existente cuando el `salesId` se repite.
    // No hay un campo que lo diga; se deduce de que venga informado.
    const yaExistia = Boolean(emitido.salesId) && emitido.salesId === documento.salesId;

    return { ok: true, documento: emitido, yaExistia, error: null };
  } catch (error) {
    return { ok: false, documento: null, yaExistia: false, error: (error as Error).message };
  }
}
