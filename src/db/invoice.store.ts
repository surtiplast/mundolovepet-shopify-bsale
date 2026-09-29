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

/** Lo que hace falta del comprobante original para poder anularlo. */
export interface EmisionOriginal {
  /** El id interno del `OrderSync` — hace falta como referencia al guardar la nota. */
  orderSyncId: string;
  bsaleDocumentId: number;
  documentTypeId: number;
  kind: 'BOLETA' | 'FACTURA';
  serialNumber: string;
  number: number;
}

export interface NotaCreditoGuardada {
  orderSyncId: string;
  bsaleDocumentId: number;
  documentTypeId: number;
  /** El `id` (no `bsaleDocumentId`) del documento original que se anula. */
  referenceDocumentId: number;
  serialNumber: string;
  number: number;
  emissionDate: number;
  totalAmount: number;
  motive: string;
  sunatState: number | null;
  sunatMessage: string | null;
}

export interface InvoiceStore {
  /** Guarda pedido y comprobante en una sola transacción. */
  registrar(emision: EmisionGuardada): Promise<void>;
  /** Los pedidos ya facturados, indexados por su id de Shopify. */
  listarFacturados(): Promise<Map<string, ResumenEmision>>;
  /**
   * La URL del PDF de un pedido y el id del documento en Bsale. **Sólo para uso
   * interno del servidor.**
   *
   * La URL nunca debe viajar al navegador: lleva un token en la dirección y
   * quien la tenga puede abrir la factura sin más comprobación. El
   * `bsaleDocumentId` sirve de clave para cachear el PDF en disco.
   */
  documentoPdfDe(shopifyOrderId: string): Promise<{ bsaleDocumentId: number; urlPdf: string } | null>;
  /** El comprobante original de un pedido, o `null` si nunca se emitió. */
  obtenerEmision(shopifyOrderId: string): Promise<EmisionOriginal | null>;
  /**
   * Guarda la nota de crédito y marca el pedido como `CANCELLED`, en una sola
   * transacción — igual que `registrar`: o quedan las dos cosas, o ninguna.
   */
  registrarNotaCredito(nota: NotaCreditoGuardada): Promise<void>;
}

/** Para desarrollo sin base de datos y para las pruebas. */
export class InMemoryInvoiceStore implements InvoiceStore {
  private readonly filas = new Map<string, ResumenEmision>();
  private readonly urls = new Map<string, string>();
  // El original se conserva aparte y NUNCA se borra al anular: es lo que
  // permite auditar qué se emitió, aunque `filas` ya no lo enseñe como
  // «facturado» (igual que en Postgres, `listarFacturados` sólo enseña los
  // que siguen SYNCED).
  private readonly originales = new Map<string, EmisionOriginal>();
  private readonly notasCredito: NotaCreditoGuardada[] = [];

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
    this.originales.set(emision.shopifyOrderId, {
      orderSyncId: emision.shopifyOrderId,
      bsaleDocumentId: emision.documento.bsaleDocumentId,
      documentTypeId: emision.documento.documentTypeId,
      kind: emision.kind,
      serialNumber: emision.documento.serialNumber,
      number: emision.documento.number,
    });
  }

  async listarFacturados(): Promise<Map<string, ResumenEmision>> {
    return new Map(this.filas);
  }

  async documentoPdfDe(shopifyOrderId: string): Promise<{ bsaleDocumentId: number; urlPdf: string } | null> {
    const urlPdf = this.urls.get(shopifyOrderId);
    const original = this.originales.get(shopifyOrderId);
    if (!urlPdf || !original) return null;
    return { bsaleDocumentId: original.bsaleDocumentId, urlPdf };
  }

  async obtenerEmision(shopifyOrderId: string): Promise<EmisionOriginal | null> {
    return this.originales.get(shopifyOrderId) ?? null;
  }

  async registrarNotaCredito(nota: NotaCreditoGuardada): Promise<void> {
    this.notasCredito.push(nota);
    // Desaparece de «facturados», igual que en Postgres al pasar a CANCELLED.
    this.filas.delete(nota.orderSyncId);
  }
}

interface OrderSyncRow {
  id: string;
  shopifyOrderId: bigint | string;
  documentKind: string | null;
  document: {
    bsaleDocumentId: number;
    documentTypeId: number;
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
    update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  };
  bsaleDocument: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  creditNote: {
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

  async documentoPdfDe(shopifyOrderId: string): Promise<{ bsaleDocumentId: number; urlPdf: string } | null> {
    const filas = await this.prisma.orderSync.findMany({
      where: { shopifyOrderId: BigInt(shopifyOrderId) },
      include: { document: true },
    });
    const doc = filas[0]?.document;
    if (!doc?.bsaleUrlPdf) return null;
    return { bsaleDocumentId: doc.bsaleDocumentId, urlPdf: doc.bsaleUrlPdf };
  }

  async obtenerEmision(shopifyOrderId: string): Promise<EmisionOriginal | null> {
    const filas = await this.prisma.orderSync.findMany({
      where: { shopifyOrderId: BigInt(shopifyOrderId) },
      include: { document: true },
    });
    const fila = filas[0];
    if (!fila?.document) return null;

    return {
      orderSyncId: fila.id,
      bsaleDocumentId: fila.document.bsaleDocumentId,
      documentTypeId: fila.document.documentTypeId,
      kind: (fila.documentKind ?? 'BOLETA') as 'BOLETA' | 'FACTURA',
      serialNumber: fila.document.serialNumber,
      number: fila.document.number,
    };
  }

  async registrarNotaCredito(nota: NotaCreditoGuardada): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.creditNote.create({
        data: {
          orderSyncId: nota.orderSyncId,
          bsaleDocumentId: nota.bsaleDocumentId,
          documentTypeId: nota.documentTypeId,
          referenceDocumentId: nota.referenceDocumentId,
          serialNumber: nota.serialNumber,
          number: nota.number,
          emissionDate: new Date(nota.emissionDate * 1000),
          totalAmount: nota.totalAmount,
          motive: nota.motive,
          sunatState: nota.sunatState,
          sunatMessage: nota.sunatMessage,
        },
      });

      // CANCELLED, no ERROR: el comprobante original sigue siendo válido, lo
      // que cambia es que ya no representa una venta vigente. `listarFacturados`
      // sólo enseña `SYNCED`, así que el pedido deja de mostrarse ahí — la nota
      // de crédito queda como su propio rastro en `CreditNote`.
      await tx.orderSync.update({
        where: { id: nota.orderSyncId },
        data: { status: 'CANCELLED' },
      });
    });
  }
}
