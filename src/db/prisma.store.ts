/**
 * Implementación de ConnectionStore sobre Prisma.
 *
 * El cliente se recibe con un tipo estructural mínimo en vez de importar
 * `@prisma/client` directamente. Así `npm run typecheck` funciona antes de
 * ejecutar `prisma generate`, y los tests no necesitan el paquete.
 */
import type {
  ConnectionRecord,
  ConnectionStatus,
  ConnectionStore,
  ProviderName,
} from './connection.store.js';

interface ConnectionRow {
  provider: ProviderName;
  encryptedToken: Uint8Array;
  tokenIv: Uint8Array;
  tokenTag: Uint8Array;
  tokenLast4: string;
  metadata: unknown;
  status: ConnectionStatus;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export interface PrismaLike {
  connection: {
    findUnique(args: { where: { provider: ProviderName } }): Promise<ConnectionRow | null>;
    findMany(args?: { orderBy?: { provider: 'asc' | 'desc' } }): Promise<ConnectionRow[]>;
    upsert(args: {
      where: { provider: ProviderName };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<ConnectionRow>;
    update(args: {
      where: { provider: ProviderName };
      data: Record<string, unknown>;
    }): Promise<ConnectionRow>;
  };
}

export class PrismaConnectionStore implements ConnectionStore {
  constructor(private readonly prisma: PrismaLike) {}

  async get(provider: ProviderName): Promise<ConnectionRecord | null> {
    const row = await this.prisma.connection.findUnique({ where: { provider } });
    return row ? toRecord(row) : null;
  }

  async list(): Promise<ConnectionRecord[]> {
    const rows = await this.prisma.connection.findMany({ orderBy: { provider: 'asc' } });
    return rows.map(toRecord);
  }

  async upsert(record: ConnectionRecord): Promise<ConnectionRecord> {
    const payload = {
      encryptedToken: record.encryptedToken,
      tokenIv: record.tokenIv,
      tokenTag: record.tokenTag,
      tokenLast4: record.tokenLast4,
      metadata: record.metadata,
    };
    const row = await this.prisma.connection.upsert({
      where: { provider: record.provider },
      create: { provider: record.provider, ...payload, status: 'UNKNOWN' },
      // Al rotar el token, el estado vuelve a UNKNOWN: no podemos afirmar que
      // sigue conectado hasta volver a probarlo.
      update: { ...payload, status: 'UNKNOWN', lastError: null },
    });
    return toRecord(row);
  }

  async updateStatus(
    provider: ProviderName,
    patch: {
      status: ConnectionStatus;
      lastCheckedAt: Date;
      lastError: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const data: Record<string, unknown> = {
      status: patch.status,
      lastCheckedAt: patch.lastCheckedAt,
      lastError: patch.lastError,
    };
    if (patch.metadata) data['metadata'] = patch.metadata;
    await this.prisma.connection.update({ where: { provider }, data });
  }
}

function toRecord(row: ConnectionRow): ConnectionRecord {
  return {
    provider: row.provider,
    encryptedToken: Buffer.from(row.encryptedToken),
    tokenIv: Buffer.from(row.tokenIv),
    tokenTag: Buffer.from(row.tokenTag),
    tokenLast4: row.tokenLast4,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
  };
}
