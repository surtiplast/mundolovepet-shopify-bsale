/**
 * Registro de cambios automáticos: qué se actualizó solo, cuándo y por qué
 * valor pasó a cuál.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────
 *
 * Antes de esto, un stock o un precio que cambiaba solo (por el cron, cada
 * minuto) sólo quedaba en los logs de Docker: útil para depurar, inútil para
 * que alguien sin acceso al servidor responda «¿por qué este producto tiene
 * este precio?». Esto guarda cada cambio real —no cada intento, sólo los que
 * de verdad se escribieron— en `SyncLog`, ya declarado en el esquema desde la
 * Fase 1 y sin usar hasta ahora.
 *
 * ── Qué NO guarda ────────────────────────────────────────────────────────────
 *
 * Sólo escrituras que tuvieron éxito. Un intento fallido ya se ve en el
 * banner del panel o en los logs de la corrida; duplicarlo aquí mezclaría
 * «esto cambió» con «esto se intentó», que es una pregunta distinta.
 *
 * Igual que los demás almacenes, el cliente de Prisma se recibe con un tipo
 * estructural mínimo: el typecheck funciona antes de `prisma generate` y las
 * pruebas no necesitan el paquete ni una base de datos.
 */
import { redact } from '../lib/mask.js';

export type SistemaLog = 'SHOPIFY' | 'BSALE' | 'APP';

/** Qué campo cambió. Uno por tipo de botón/cron que escribe algo. */
export type AccionLog = 'STOCK' | 'PRECIO' | 'COSTO' | 'CODIGO_BARRAS' | 'PRODUCTO_CREADO';

export type OrigenLog = 'MANUAL' | 'CRON';

export interface NuevoRegistro {
  system: SistemaLog;
  action: AccionLog;
  sku: string | null;
  /** Texto listo para mostrar, ej. «12.50 → 13.00». */
  message: string;
  context?: {
    valorAnterior?: number | string | null;
    valorNuevo?: number | string | null;
    origen: OrigenLog;
  };
}

export interface RegistroGuardado extends NuevoRegistro {
  id: string;
  occurredAt: Date;
}

export interface FiltroLogs {
  desde?: Date;
  hasta?: Date;
  action?: AccionLog;
  sku?: string;
  limite?: number;
  offset?: number;
}

export interface PaginaLogs {
  items: RegistroGuardado[];
  total: number;
}

export interface SyncLogStore {
  /** Inserta varios a la vez: una corrida del cron puede cambiar cientos de SKU. */
  registrar(entradas: NuevoRegistro[]): Promise<void>;
  listar(filtro: FiltroLogs): Promise<PaginaLogs>;
}

function coincide(fila: RegistroGuardado, filtro: FiltroLogs): boolean {
  if (filtro.desde && fila.occurredAt < filtro.desde) return false;
  if (filtro.hasta && fila.occurredAt > filtro.hasta) return false;
  if (filtro.action && fila.action !== filtro.action) return false;
  if (filtro.sku && fila.sku !== filtro.sku) return false;
  return true;
}

let contador = 0;

/** Para desarrollo sin base de datos y para las pruebas. */
export class InMemorySyncLogStore implements SyncLogStore {
  private readonly filas: RegistroGuardado[] = [];

  async registrar(entradas: NuevoRegistro[]): Promise<void> {
    const ahora = new Date();
    for (const e of entradas) {
      this.filas.push({ ...e, id: `mem-${++contador}`, occurredAt: ahora });
    }
  }

  async listar(filtro: FiltroLogs): Promise<PaginaLogs> {
    // Empate por fecha (una misma corrida escribe varios en el mismo
    // milisegundo): el id, que crece con el orden de inserción, desempata.
    const todas = this.filas.filter((f) => coincide(f, filtro)).sort((a, b) => {
      const porFecha = b.occurredAt.getTime() - a.occurredAt.getTime();
      if (porFecha !== 0) return porFecha;
      return Number(b.id.slice('mem-'.length)) - Number(a.id.slice('mem-'.length));
    });
    const offset = filtro.offset ?? 0;
    const limite = filtro.limite ?? 200;
    return { items: todas.slice(offset, offset + limite), total: todas.length };
  }
}

export interface PrismaSyncLogLike {
  syncLog: {
    createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
    findMany(args: Record<string, unknown>): Promise<
      Array<{
        id: string;
        occurredAt: Date;
        system: string;
        action: string;
        sku: string | null;
        result: string;
        message: string;
        context: unknown;
      }>
    >;
    count(args: Record<string, unknown>): Promise<number>;
  };
}

export class PrismaSyncLogStore implements SyncLogStore {
  constructor(private readonly prisma: PrismaSyncLogLike) {}

  async registrar(entradas: NuevoRegistro[]): Promise<void> {
    if (entradas.length === 0) return;
    await this.prisma.syncLog.createMany({
      data: entradas.map((e) => ({
        system: e.system,
        action: e.action,
        sku: e.sku,
        result: 'OK',
        message: e.message,
        // Nunca se guarda sin pasar por redact(), aunque hoy el contexto sean
        // sólo números: si mañana se añade algo con un secreto adentro, la
        // regla ya está aplicada y no hay que acordarse de repetirla.
        context: e.context ? (redact(e.context) as Record<string, unknown>) : undefined,
      })),
    });
  }

  async listar(filtro: FiltroLogs): Promise<PaginaLogs> {
    const where: Record<string, unknown> = {};
    if (filtro.desde || filtro.hasta) {
      where.occurredAt = {
        ...(filtro.desde ? { gte: filtro.desde } : {}),
        ...(filtro.hasta ? { lte: filtro.hasta } : {}),
      };
    }
    if (filtro.action) where.action = filtro.action;
    if (filtro.sku) where.sku = filtro.sku;

    const [filas, total] = await Promise.all([
      this.prisma.syncLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: filtro.offset ?? 0,
        take: filtro.limite ?? 200,
      }),
      this.prisma.syncLog.count({ where }),
    ]);

    return {
      total,
      items: filas.map((f) => ({
        id: f.id,
        occurredAt: f.occurredAt,
        system: f.system as SistemaLog,
        action: f.action as AccionLog,
        sku: f.sku,
        message: f.message,
        context: (f.context ?? undefined) as NuevoRegistro['context'],
      })),
    };
  }
}
