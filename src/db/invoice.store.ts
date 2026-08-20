/**
 * Registro de comprobantes emitidos.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────
 *
 * Hasta ahora la app emitía y se olvidaba. El único candado contra emitir dos
 * veces era el `salesId` de Bsale, que funciona —Bsale devuelve el documento
 * existente en vez de crear otro— pero deja a la app ciega: el panel no puede
 * decir «este pedido ya está facturado», y cada vez que lo abres vuelve a
 * ofrecerte el botón de emitir.
 *
 * Con esto el pedido queda marcado en cuanto se emite, y el panel puede
 * enseñarte la serie y el número en vez de un botón que no deberías pulsar.
 *
 * ── Los dos registros y por qué van juntos ───────────────────────────────────
 *
 * `OrderSync` es el pedido: qué se facturó, por cuánto, en qué estado quedó.
 * `BsaleDocument` es el comprobante: serie, número, fecha, respuesta de SUNAT.
 *
 * Se escriben **en la misma transacción**. Guardar el pedido como facturado sin
 * el documento dejaría un pedido que dice estar emitido y no puede probarlo; y
 * el documento sin el pedido sería un comprobante huérfano. Todo o nada.
 *
 * ── Prisma con tipo estructural ──────────────────────────────────────────────
 *
 * Igual que en los demás almacenes, el cliente se recibe con un tipo mínimo en
 * vez de importar `@prisma/client`. Así el typecheck funciona antes de ejecutar
 * `prisma generate` y las pruebas no necesitan el paquete ni una base de datos.
 */

export interface EmisionGuardada {
  /** El id numérico del pedido de Shopify. */
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyOrderGid: string;
  /** `shopify-order-<id>`. Lo mismo que se manda a Bsale como `salesId`. */
  idempotencyKey: string;
  kind: 'BOLETA' | 'FACTURA';
  totalAmount: number;
  currency: string;
  /** Lo que respondió Bsale, para poder cotejarlo sin salir del panel. */
  documento: {
    bsaleDocumentId: number;
    documentTypeId: number;
    serialNumber: string;
    number: number;
    /** Segundos desde epoch, como lo devuelve Bsale. */
    emissionDate: number;
    totalAmount: number;
    token: string;
    /** `informed`: 0 aceptado, 1 enviado, 2 rechazado por SUNAT. */
    sunatState: number | null;
    sunatMessage: string | null;
    /** La URL del PDF en Bsale. Se guarda, no se expone. */
    urlPdf: string | null;
  };
}

/** Lo que el panel necesita saber de un pedido ya facturado. */
export interface ResumenEmision {
  shopifyOrderId: string;
  kind: string;
  serialNumber: string;
  number: number;
  totalAmount: number;
  sunatState: number | null;
  emitidoEl: Date;
  /** `true` si hay PDF que servir. La URL en sí no sale de aquí. */
  tienePdf: boolean;
}

export interface InvoiceStore {
  /** Guarda pedido y comprobante en una sola transacción. */
  registrar(emision: EmisionGuardada): Promise<void>;
  /** Los pedidos ya facturados, indexados por su id de Shopify. */
  listarFacturados(): Promise<Map<string, ResumenEmision>>;
  /**
   * La URL del PDF de un pedido. **Sólo para uso interno del servidor.**
   *
   * Nunca debe viajar al navegador: lleva un token en la dirección y quien la
   * tenga puede abrir la factura sin más comprobación.
   */
  urlPdfDe(shopifyOrderId: string): Promise<string | null>;
}

/** Para desarrollo sin base de datos y para las pruebas. */
export class InMemoryInvoiceStore implements InvoiceStore {
  private readonly filas = new Map<string, ResumenEmision>();
  private readonly urls = new Map<string, string>();

  async registrar(emision: EmisionGuardada): Promise<void> {
    // El unique de `shopifyOrderId` en PostgreSQL rechazaría el segundo. Aquí
    // se imita para que las pruebas vean el mismo comportamiento.
    if (this.filas.has(emision.shopifyOrderId)) {
      throw new Error(`El pedido ${emision.shopifyOrderName} ya está registrado.`);
    }

    this.filas.set(emision.shopifyOrderId, {
      shopifyOrderId: emision.shopifyOrderId,
      kind: emision.kind,
      serialNumber: emision.documento.serialNumber,
      number: emision.documento.number,
      totalAmount: emision.documento.totalAmount,
      sunatState: emision.documento.sunatState,
      emitidoEl: new Date(emision.documento.emissionDate * 1000),
      tienePdf: Boolean(emision.documento.urlPdf),
    });
    if (emision.documento.urlPdf) {
      this.urls.set(emision.shopifyOrderId, emision.documento.urlPdf);
    }
  }

  async listarFacturados(): Promise<Map<string, ResumenEmision>> {
    return new Map(this.filas);
  }

  async urlPdfDe(shopifyOrderId: string): Promise<string | null> {
    return this.urls.get(shopifyOrderId) ?? null;
  }
}

interface OrderSyncRow {
  id: string;
  shopifyOrderId: bigint | string;
  documentKind: string | null;
  document: {
    serialNumber: string;
    number: number;
    totalAmount: unknown;
    sunatState: number | null;
    emissionDate: Date;
    bsaleUrlPdf: string | null;
  } | null;
}

export interface PrismaInvoiceLike {
  $transaction<T>(fn: (tx: PrismaInvoiceLike) => Promise<T>): Promise<T>;
  orderSync: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findMany(args?: Record<string, unknown>): Promise<OrderSyncRow[]>;
  };
  bsaleDocument: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export class PrismaInvoiceStore implements InvoiceStore {
  constructor(private readonly prisma: PrismaInvoiceLike) {}

  async registrar(emision: EmisionGuardada): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.orderSync.create({
        data: {
          shopifyOrderId: BigInt(emision.shopifyOrderId),
          shopifyOrderName: emision.shopifyOrderName,
          shopifyOrderGid: emision.shopifyOrderGid,
          idempotencyKey: emision.idempotencyKey,
          documentKind: emision.kind,
          totalAmount: emision.totalAmount,
          currency: emision.currency,
          status: 'SYNCED',
          attempts: 1,
          processedAt: new Date(),
          // El payload se guarda vacío a propósito: el pedido completo vive en
          // Shopify y duplicarlo aquí sería copiar datos personales del cliente
          // sin necesitarlos. Lo que hace falta para auditar está en las
          // columnas de al lado.
          payload: {},
        },
      });

      await tx.bsaleDocument.create({
        data: {
          orderSyncId: pedido.id,
          bsaleDocumentId: emision.documento.bsaleDocumentId,
          documentTypeId: emision.documento.documentTypeId,
          kind: emision.kind,
          serialNumber: emision.documento.serialNumber,
          number: emision.documento.number,
          // Bsale manda la fecha en segundos; Prisma quiere un Date.
          emissionDate: new Date(emision.documento.emissionDate * 1000),
          totalAmount: emision.documento.totalAmount,
          bsaleToken: emision.documento.token,
          sunatState: emision.documento.sunatState,
          sunatMessage: emision.documento.sunatMessage,
          bsaleUrlPdf: emision.documento.urlPdf,
        },
      });
    });
  }

  async listarFacturados(): Promise<Map<string, ResumenEmision>> {
    const filas = await this.prisma.orderSync.findMany({
      where: { status: 'SYNCED' },
      include: { document: true },
      orderBy: { createdAt: 'desc' },
    });

    const mapa = new Map<string, ResumenEmision>();
    for (const f of filas) {
      if (!f.document) continue;
      mapa.set(String(f.shopifyOrderId), {
        shopifyOrderId: String(f.shopifyOrderId),
        kind: f.documentKind ?? '',
        serialNumber: f.document.serialNumber,
        number: f.document.number,
        totalAmount: Number(f.document.totalAmount),
        sunatState: f.document.sunatState,
        emitidoEl: f.document.emissionDate,
        tienePdf: Boolean(f.document.bsaleUrlPdf),
      });
    }
    return mapa;
  }

  async urlPdfDe(shopifyOrderId: string): Promise<string | null> {
    const filas = await this.prisma.orderSync.findMany({
      where: { shopifyOrderId: BigInt(shopifyOrderId) },
      include: { document: true },
    });
    return filas[0]?.document?.bsaleUrlPdf ?? null;
  }
}
