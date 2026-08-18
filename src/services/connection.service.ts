/**
 * Servicio de conexión — corazón de la Fase 1.
 *
 * Responsabilidades:
 *  1. Guardar los tokens cifrados (nunca en claro).
 *  2. Probar la conexión contra cada API real.
 *  3. Exponer al panel un estado seguro: sin tokens, sin stacks, sin URLs internas.
 *  4. Descubrir la configuración real de la cuenta Bsale (IDs de sucursal, tipos
 *     de documento e IGV) en lugar de asumirla.
 */
import { open, seal, type SealedSecret } from '../lib/crypto.js';
import { maskToken, tokenLast4, scrubMessage } from '../lib/mask.js';
import { IntegrationError } from '../lib/errors.js';
import {
  toSealed,
  type ConnectionRecord,
  type ConnectionStore,
  type ProviderName,
} from '../db/connection.store.js';
import { BsaleClient, type BsaleDocumentType, type BsaleOffice } from '../integrations/bsale/client.js';
import { ShopifyClient } from '../integrations/shopify/client.js';
import { ShopifyTokenProvider } from '../integrations/shopify/token.js';

export interface ConnectionView {
  provider: ProviderName;
  label: string;
  connected: boolean;
  status: string;
  maskedToken: string;
  metadata: Record<string, unknown>;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface TestResult {
  provider: ProviderName;
  ok: boolean;
  checkedAt: string;
  details?: Record<string, unknown>;
  error?: { message: string; status?: number; code?: string; retryable: boolean };
}

/** Configuración descubierta en la cuenta Bsale real. Nada de esto se inventa. */
export interface BsaleDiscovery {
  offices: Array<{ id: number; name: string; isVirtual: boolean }>;
  documentTypes: Array<{ id: number; name: string; isElectronic: boolean; isSalesNote: boolean }>;
  taxes: Array<{ id: number; name: string; percentage: number | null }>;
  priceLists: Array<{ id: number; name: string }>;
  suggestions: {
    boletaId: number | null;
    facturaId: number | null;
    igvTaxId: number | null;
    note: string;
  };
}

export interface ConnectionServiceDeps {
  store: ConnectionStore;
  encryptionKey: Buffer;
  /** Inyectables para testear sin red. */
  makeBsaleClient?: (token: string, baseUrl: string) => BsaleClient;
  /**
   * `token` es ahora el CLIENT SECRET de la app, no un token de Admin API.
   * El client_id llega en `clientId` porque no es secreto y hace falta para
   * pedir el token.
   */
  makeShopifyClient?: (
    token: string,
    shopDomain: string,
    apiVersion: string,
    clientId: string,
  ) => ShopifyClient;
  now?: () => Date;
}

export class ConnectionService {
  private readonly store: ConnectionStore;
  private readonly key: Buffer;
  private readonly makeBsale: (token: string, baseUrl: string) => BsaleClient;
  private readonly makeShopify: (
    token: string,
    shop: string,
    version: string,
    clientId: string,
  ) => ShopifyClient;
  private readonly now: () => Date;

  constructor(deps: ConnectionServiceDeps) {
    this.store = deps.store;
    this.key = deps.encryptionKey;
    this.makeBsale =
      deps.makeBsaleClient ?? ((accessToken, baseUrl) => new BsaleClient({ accessToken, baseUrl }));
    this.makeShopify =
      deps.makeShopifyClient ??
      ((clientSecret, shopDomain, apiVersion, clientId) => {
        // El proveedor pide el token con client credentials y lo renueva antes
        // de que caduque. Se pasa como función: el cliente lo resuelve en cada
        // petición, así que nunca trabaja con un token vencido.
        const proveedor = new ShopifyTokenProvider({ shopDomain, clientId, clientSecret });
        return new ShopifyClient({
          accessToken: () => proveedor.getToken(),
          shopDomain,
          apiVersion,
        });
      });
    this.now = deps.now ?? (() => new Date());
  }

  // ── Guardado de credenciales ───────────────────────────────────────────────

  async saveCredential(
    provider: ProviderName,
    token: string,
    metadata: Record<string, unknown> = {},
  ): Promise<ConnectionView> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new IntegrationError('El token no puede estar vacío.', { provider, retryable: false });
    }

    const sealed: SealedSecret = seal(trimmed, this.key);
    const record: ConnectionRecord = {
      provider,
      encryptedToken: sealed.ciphertext,
      tokenIv: sealed.iv,
      tokenTag: sealed.tag,
      tokenLast4: tokenLast4(trimmed),
      metadata: sanitizeMetadata(metadata),
      status: 'UNKNOWN',
      lastCheckedAt: null,
      lastError: null,
    };

    const saved = await this.store.upsert(record);
    return this.toView(saved);
  }

  /**
   * Presta un cliente de Bsale ya autenticado, sin entregar el token.
   *
   * Otras partes de la app (la lectura del catálogo, por ejemplo) necesitan
   * hablar con Bsale, pero el token sigue sin salir de aquí: se les da el
   * cliente ya construido y ellas lo usan dentro de la función. Es la forma de
   * mantener la regla de que `revealToken` es privado.
   */
  async usarBsale<T>(baseUrl: string, fn: (client: BsaleClient) => Promise<T>): Promise<T> {
    const token = await this.revealToken('BSALE');
    return fn(this.makeBsale(token, baseUrl));
  }

  /** Descifra el token. Método privado a propósito: nunca sale de esta clase. */
  private async revealToken(provider: ProviderName): Promise<string> {
    const record = await this.store.get(provider);
    if (!record) {
      throw new IntegrationError(`No hay credenciales guardadas para ${provider}.`, {
        provider,
        retryable: false,
      });
    }
    return open(toSealed(record), this.key);
  }

  // ── Estado para el panel ───────────────────────────────────────────────────

  async listConnections(): Promise<ConnectionView[]> {
    const records = await this.store.list();
    const byProvider = new Map(records.map((r) => [r.provider, r]));
    return (['BSALE', 'SHOPIFY'] as const).map((provider) => {
      const record = byProvider.get(provider);
      return record
        ? this.toView(record)
        : {
            provider,
            label: labelFor(provider),
            connected: false,
            status: 'Sin configurar',
            maskedToken: '—',
            metadata: {},
            lastCheckedAt: null,
            lastError: null,
          };
    });
  }

  private toView(record: ConnectionRecord): ConnectionView {
    return {
      provider: record.provider,
      label: labelFor(record.provider),
      connected: record.status === 'CONNECTED',
      status: statusLabel(record.status),
      // Sólo los últimos 4 caracteres salen del backend. Nunca el token.
      maskedToken: record.tokenLast4 ? `••••${record.tokenLast4}` : maskToken(null),
      metadata: sanitizeMetadata(record.metadata),
      lastCheckedAt: record.lastCheckedAt?.toISOString() ?? null,
      lastError: record.lastError,
    };
  }

  // ── Pruebas de conexión ────────────────────────────────────────────────────

  async testBsale(baseUrl: string): Promise<TestResult> {
    const checkedAt = this.now();
    let token = '';
    try {
      token = await this.revealToken('BSALE');
      const client = this.makeBsale(token, baseUrl);
      const result = await client.testConnection();

      const details = {
        sucursales: result.officeCount,
        listaSucursales: result.offices.map((o) => ({ id: o.id, nombre: o.name })),
      };
      await this.store.updateStatus('BSALE', {
        status: 'CONNECTED',
        lastCheckedAt: checkedAt,
        lastError: null,
        metadata: { baseUrl, officeCount: result.officeCount },
      });
      return { provider: 'BSALE', ok: true, checkedAt: checkedAt.toISOString(), details };
    } catch (error) {
      return this.recordFailure('BSALE', error, checkedAt, token);
    }
  }

  /**
   * `clientId` no es secreto y por eso viaja como argumento; el client secret
   * sale cifrado de la base y nunca abandona esta clase.
   */
  async testShopify(shopDomain: string, apiVersion: string, clientId: string): Promise<TestResult> {
    const checkedAt = this.now();
    let token = '';
    try {
      token = await this.revealToken('SHOPIFY');
      const client = this.makeShopify(token, shopDomain, apiVersion, clientId);
      const result = await client.testConnection();

      const details = {
        tienda: result.shop.name,
        dominio: result.shop.myshopifyDomain,
        moneda: result.shop.currencyCode,
        zonaHoraria: result.shop.ianaTimezone,
        plan: result.shop.plan?.displayName ?? null,
        versionApi: result.apiVersion,
      };
      await this.store.updateStatus('SHOPIFY', {
        status: 'CONNECTED',
        lastCheckedAt: checkedAt,
        lastError: null,
        metadata: { shopDomain, apiVersion, currency: result.shop.currencyCode },
      });
      return { provider: 'SHOPIFY', ok: true, checkedAt: checkedAt.toISOString(), details };
    } catch (error) {
      return this.recordFailure('SHOPIFY', error, checkedAt, token);
    }
  }

  private async recordFailure(
    provider: ProviderName,
    error: unknown,
    checkedAt: Date,
    token: string,
  ): Promise<TestResult> {
    const integrationError =
      error instanceof IntegrationError
        ? error
        : new IntegrationError(
            error instanceof Error ? error.message : 'Error desconocido.',
            { provider, retryable: false, cause: error },
          );

    // Doble red de seguridad: aunque el mensaje venga de una librería externa,
    // el token no puede acabar en la base de datos ni en la respuesta HTTP.
    const safeMessage = scrubMessage(integrationError.message, token ? [token] : []);

    await this.store.updateStatus(provider, {
      status: 'ERROR',
      lastCheckedAt: checkedAt,
      lastError: safeMessage,
    });

    const pub = integrationError.toPublic();
    return {
      provider,
      ok: false,
      checkedAt: checkedAt.toISOString(),
      error: { ...pub, message: safeMessage },
    };
  }

  // ── Descubrimiento de configuración Bsale ──────────────────────────────────

  /**
   * Lee de la cuenta real los IDs que la Fase 6 necesitará para emitir.
   *
   * Existe porque los IDs de tipo de documento e impuesto **varían entre cuentas
   * de Bsale**. Codificarlos a mano es la forma más rápida de emitir un
   * comprobante del tipo equivocado.
   *
   * Las sugerencias son sólo eso: sugerencias por coincidencia de nombre. El
   * administrador debe confirmarlas en el panel antes de usarlas.
   */
  async discoverBsale(baseUrl: string): Promise<BsaleDiscovery> {
    const token = await this.revealToken('BSALE');
    const client = this.makeBsale(token, baseUrl);

    const [offices, documentTypes, taxes, priceLists] = await Promise.all([
      client.listOffices(),
      client.listDocumentTypes(),
      client.listTaxes(),
      client.listPriceLists(),
    ]);

    const boleta = pickDocumentType(documentTypes.items, 'boleta');
    const factura = pickDocumentType(documentTypes.items, 'factura');
    const igv = taxes.items.find((t) => /igv|impuesto general/i.test(t.name ?? ''));

    return {
      offices: offices.items.map((o: BsaleOffice) => ({
        id: o.id,
        name: o.name,
        isVirtual: o.isVirtual === 1,
      })),
      documentTypes: documentTypes.items.map((d) => ({
        id: d.id,
        name: d.name,
        isElectronic: d.isElectronicService === 1,
        isSalesNote: d.isSalesNote === 1,
      })),
      taxes: taxes.items.map((t) => ({ id: t.id, name: t.name, percentage: t.percentage ?? null })),
      priceLists: priceLists.items.map((p) => ({ id: p.id, name: p.name })),
      suggestions: {
        boletaId: boleta?.id ?? null,
        facturaId: factura?.id ?? null,
        igvTaxId: igv?.id ?? null,
        note:
          'Sugerencias por coincidencia de nombre. Confírmalas en el panel antes de emitir: ' +
          'los IDs varían entre cuentas de Bsale y un ID equivocado emite el documento incorrecto.',
      },
    };
  }
}

/** Prefiere el tipo electrónico y descarta notas de venta. */
function pickDocumentType(
  types: BsaleDocumentType[],
  keyword: string,
): BsaleDocumentType | undefined {
  const matches = types.filter(
    (t) => new RegExp(keyword, 'i').test(t.name ?? '') && t.isSalesNote !== 1 && t.state !== 1,
  );
  return matches.find((t) => t.isElectronicService === 1) ?? matches[0];
}

/** Barrera final: si algo con pinta de secreto llegó a `metadata`, no sale de aquí. */
function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (/token|secret|password|key|hmac/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function labelFor(provider: ProviderName): string {
  return provider === 'BSALE' ? 'Bsale Perú' : 'Shopify';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'CONNECTED':
      return 'Conectado';
    case 'ERROR':
      return 'Error';
    case 'DISCONNECTED':
      return 'Desconectado';
    default:
      return 'Sin verificar';
  }
}
