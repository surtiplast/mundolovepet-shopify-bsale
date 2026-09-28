/**
 * Registro de webhooks recibidos.
 *
 * ── Por qué guardar el evento y no actuar directo ────────────────────────────
 *
 * `sincronizar.ts` ya relee el catálogo completo cada minuto por cron: los
 * webhooks no sustituyen eso todavía, lo complementan. Antes de decidir qué
 * hacer con cada `topic` (documento, stock, producto, variante, precio) hace
 * falta poder ver qué está mandando Bsale de verdad — llegan en cuanto se
 * activen, y hasta entonces nadie los ha visto en producción. Guardar primero
 * y decidir después es más seguro que adivinar la reacción y descubrir en
 * producción que el payload no traía lo que se esperaba.
 *
 * ── Deduplicación ─────────────────────────────────────────────────────────
 *
 * Bsale puede reintentar un webhook si la respuesta tarda o falla. El
 * `@@unique([source, externalId])` del modelo evita procesar el mismo evento
 * dos veces: `registrar` detecta el choque y avisa con `yaExistia` en vez de
 * fallar.
 *
 * Igual que los demás almacenes, el cliente de Prisma se recibe con un tipo
 * estructural mínimo: el typecheck funciona antes de `prisma generate` y las
 * pruebas no necesitan el paquete ni una base de datos.
 */

export type FuenteWebhook = 'BSALE' | 'SHOPIFY';

export interface EventoWebhook {
  source: FuenteWebhook;
  /** `resourceId` de Bsale, o el id de webhook de Shopify. */
  externalId: string;
  topic: string;
  payload: unknown;
}

export interface WebhookStore {
  /** `yaExistia: true` si es un reenvío del mismo evento — no hace falta reprocesarlo. */
  registrar(evento: EventoWebhook): Promise<{ yaExistia: boolean }>;
}

/** Para desarrollo sin base de datos y para las pruebas. */
export class InMemoryWebhookStore implements WebhookStore {
  private readonly vistos = new Set<string>();

  async registrar(evento: EventoWebhook): Promise<{ yaExistia: boolean }> {
    const clave = `${evento.source}:${evento.externalId}`;
    if (this.vistos.has(clave)) return { yaExistia: true };
    this.vistos.add(clave);
    return { yaExistia: false };
  }
}

/** Código de Prisma para «choque de restricción única». */
const CHOQUE_UNICO = 'P2002';

export interface PrismaWebhookLike {
  webhookEvent: {
    create(args: {
      data: { source: FuenteWebhook; externalId: string; topic: string; payload: unknown };
    }): Promise<unknown>;
  };
}

export class PrismaWebhookStore implements WebhookStore {
  constructor(private readonly prisma: PrismaWebhookLike) {}

  async registrar(evento: EventoWebhook): Promise<{ yaExistia: boolean }> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          source: evento.source,
          externalId: evento.externalId,
          topic: evento.topic,
          payload: evento.payload,
        },
      });
      return { yaExistia: false };
    } catch (error) {
      if ((error as { code?: string }).code === CHOQUE_UNICO) {
        return { yaExistia: true };
      }
      throw error;
    }
  }
}
