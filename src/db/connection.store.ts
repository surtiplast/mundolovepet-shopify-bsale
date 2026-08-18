/**
 * Almacén de credenciales.
 *
 * Se define como interfaz para que la lógica de negocio no dependa de Prisma.
 * Efecto práctico: el servicio de conexión se puede testear entero sin levantar
 * PostgreSQL.
 */
import type { SealedSecret } from '../lib/crypto.js';

export type ProviderName = 'SHOPIFY' | 'BSALE';
export type ConnectionStatus = 'UNKNOWN' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface ConnectionRecord {
  provider: ProviderName;
  encryptedToken: Buffer;
  tokenIv: Buffer;
  tokenTag: Buffer;
  tokenLast4: string;
  metadata: Record<string, unknown>;
  status: ConnectionStatus;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export interface ConnectionStore {
  get(provider: ProviderName): Promise<ConnectionRecord | null>;
  upsert(record: ConnectionRecord): Promise<ConnectionRecord>;
  updateStatus(
    provider: ProviderName,
    patch: {
      status: ConnectionStatus;
      lastCheckedAt: Date;
      lastError: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void>;
  list(): Promise<ConnectionRecord[]>;
}

export function toSealed(record: ConnectionRecord): SealedSecret {
  return { ciphertext: record.encryptedToken, iv: record.tokenIv, tag: record.tokenTag };
}

/** Implementación en memoria. Para tests y para arrancar sin base de datos. */
export class InMemoryConnectionStore implements ConnectionStore {
  private readonly data = new Map<ProviderName, ConnectionRecord>();

  async get(provider: ProviderName): Promise<ConnectionRecord | null> {
    return this.data.get(provider) ?? null;
  }

  async upsert(record: ConnectionRecord): Promise<ConnectionRecord> {
    const existing = this.data.get(record.provider);
    const merged: ConnectionRecord = {
      ...record,
      // Conservamos el resultado de la última comprobación si el token no cambió.
      status: existing && sameToken(existing, record) ? existing.status : 'UNKNOWN',
      lastCheckedAt: existing && sameToken(existing, record) ? existing.lastCheckedAt : null,
      lastError: existing && sameToken(existing, record) ? existing.lastError : null,
    };
    this.data.set(record.provider, merged);
    return merged;
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
    const existing = this.data.get(provider);
    if (!existing) return;
    this.data.set(provider, {
      ...existing,
      status: patch.status,
      lastCheckedAt: patch.lastCheckedAt,
      lastError: patch.lastError,
      metadata: patch.metadata ? { ...existing.metadata, ...patch.metadata } : existing.metadata,
    });
  }

  async list(): Promise<ConnectionRecord[]> {
    return [...this.data.values()];
  }
}

function sameToken(a: ConnectionRecord, b: ConnectionRecord): boolean {
  return a.encryptedToken.equals(b.encryptedToken) && a.tokenIv.equals(b.tokenIv);
}
