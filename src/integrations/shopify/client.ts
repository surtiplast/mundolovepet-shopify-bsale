/**
 * Cliente de la Admin GraphQL API de Shopify.
 *
 * Documentación oficial:
 *   https://shopify.dev/docs/api/admin-graphql/2026-07
 *   https://shopify.dev/docs/api/usage/rate-limits
 *
 * Notas de diseño:
 *  - Se usa GraphQL, no REST: Shopify dirige todo desarrollo nuevo a GraphQL.
 *  - El control de caudal se hace leyendo `extensions.cost.throttleStatus` de la
 *    respuesta real, en lugar de asumir una cuota fija. El tamaño del bucket
 *    depende del plan de la tienda, así que asumirlo sería adivinar.
 *  - Shopify devuelve HTTP 200 con un array `errors` en varios fallos de
 *    GraphQL. Ignorar eso es el error clásico de integración: hay que inspeccionar
 *    el cuerpo, no sólo el código de estado.
 */
import { randomUUID } from 'node:crypto';
import { IntegrationError, backoffDelayMs } from '../../lib/errors.js';
import { scrubMessage } from '../../lib/mask.js';

/**
 * El token puede ser una cadena fija o un proveedor que lo obtiene y renueva.
 *
 * Desde enero de 2026 las apps nuevas de Shopify no entregan un token estático:
 * hay que pedirlo con client credentials y caduca cada ~24 h. Ver
 * `token.ts`. Se admite la cadena para las apps antiguas que aún la tengan y
 * para que las pruebas no necesiten simular el flujo completo.
 */
export type AccessTokenSource = string | (() => Promise<string>);

export interface ShopifyClientOptions {
  shopDomain: string;
  accessToken: AccessTokenSource;
  apiVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: ThrottleStatus;
    };
  };
}

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  currencyCode: string;
  ianaTimezone: string;
  plan: { displayName: string };
}

export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
  address: { city: string | null; country: string | null } | null;
}

/**
 * Variante de Shopify, con los campos que necesita la sincronización.
 *
 * `sku` y `barcode` son campos DISTINTOS y ambos importan: en catálogos que
 * vienen de un ERP peruano es frecuente que el código EAN esté en `barcode` y
 * el `sku` esté vacío, o al revés. Emparejar por el campo equivocado no da
 * error: simplemente no encuentra nada.
 */
export interface ShopifyVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  inventoryItemId: string | null;
  /** «Costo por artículo». `null` cuando la tienda no lo tiene puesto. */
  costo: number | null;
  productId: string | null;
  productTitle: string | null;
  title: string | null;
  /**
   * ACTIVE, DRAFT o ARCHIVED. La app crea siempre en DRAFT, así que sirve para
   * distinguir lo que creó ella de lo que ya estaba.
   */
  estado: string | null;
  /**
   * Si el producto tiene alguna imagen. Los que crea la app nunca la tienen —no
   * hay de dónde sacarla en Bsale—, y eso ayuda a reconocer un duplicado.
   */
  tieneImagen: boolean;
}

export const DEFAULT_API_VERSION = '2026-07';

const SHOP_QUERY = /* GraphQL */ `
  query ConnectionTest {
    shop {
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
      plan {
        displayName
      }
    }
  }
`;

const LOCATIONS_QUERY = /* GraphQL */ `
  query Locations($first: Int!) {
    locations(first: $first) {
      nodes {
        id
        name
        isActive
        address {
          city
          country
        }
      }
    }
  }
`;

const VARIANTS_QUERY = /* GraphQL */ `
  query Variantes($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sku
        barcode
        price
        inventoryQuantity
        inventoryItem {
          id
          # El costo actual, para saber si falta. Shopify lo llama unitCost y lo
          # devuelve como MoneyV2, no como número suelto.
          unitCost {
            amount
          }
        }
        title
        product {
          id
          title
          status
          # Basta con saber si hay al menos una. Pedir todas las imágenes de
          # miles de productos multiplicaría el coste de la consulta para nada.
          media(first: 1) {
            nodes {
              id
            }
          }
        }
      }
    }
  }
`;

/**
 * Precio de una variante.
 *
 * `productVariantsBulkUpdate` exige el id del producto además del de la
 * variante, y admite hasta 250 variantes por llamada — pero todas del MISMO
 * producto. Por eso el servicio agrupa por producto antes de llamar.
 */
const PRECIO_MUTATION = /* GraphQL */ `
  mutation ActualizarPrecios($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Corrección de código de barras y costo.
 *
 * Reutiliza `productVariantsBulkUpdate` —igual que el precio— porque
 * `ProductVariantsBulkInput` admite tanto `barcode` como `inventoryItem.cost`,
 * y así una sola llamada arregla los dos campos a la vez.
 */
const REPARAR_MUTATION = /* GraphQL */ `
  mutation Reparar($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        barcode
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Metafields del pedido.
 *
 * Sirve para dejar escrito en el propio pedido de Shopify qué comprobante se
 * emitió. Sin esto, para saber si un pedido está facturado hay que abrir esta
 * app; con esto se ve desde el pedido, que es donde lo va a buscar cualquiera
 * que atienda a un cliente.
 *
 * `metafieldsSet` crea o actualiza indistintamente, y es **atómico**: si una de
 * las claves falla, no se escribe ninguna. Admite hasta 25 por llamada.
 */
const METAFIELDS_MUTATION = /* GraphQL */ `
  mutation GuardarMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Inventario.
 *
 * Se usa `inventorySetQuantities` con `name: "available"`, que FIJA la cantidad
 * al valor indicado. La alternativa (`inventoryAdjustQuantities`) suma o resta
 * un delta, y con dos procesos sincronizando a la vez acabaría descuadrando.
 * Aquí Bsale es la fuente de verdad: se fija, no se ajusta.
 *
 * OJO con la versión de la API. En 2026-07 el input admite exactamente cuatro
 * campos: `name`, `quantities`, `reason` y `referenceDocumentUri`. El
 * `ignoreCompareQuantity` de versiones anteriores fue retirado, y mandarlo hace
 * que Shopify rechace la mutación entera.
 *
 * En su lugar, cada cantidad EXIGE `changeFromQuantity`: la cantidad que la app
 * cree que hay ahora mismo. Es control de concurrencia — si alguien vendió el
 * producto entre que leímos el stock y lo escribimos, el valor ya no coincide y
 * Shopify rechaza ese cambio concreto en vez de pisar el dato más reciente.
 *
 * Conviene entender por qué esto es bueno y no un estorbo: sin ese control, una
 * sincronización lanzada mientras entran pedidos dejaría el inventario por
 * encima del real y provocaría sobreventa.
 *
 * ── La directiva @idempotent ─────────────────────────────────────────────────
 *
 * Desde 2026-04 es OBLIGATORIA en las mutaciones de inventario, aunque el
 * esquema no la marque como tal: sin ella la llamada falla en ejecución con
 * «The @idempotent directive is required for this mutation».
 *
 * Su función es impedir que un reintento aplique el mismo ajuste dos veces.
 * Por eso la clave se genera UNA VEZ por llamada y se reutiliza en los
 * reintentos internos del cliente: generar una nueva en cada intento anularía
 * la protección, que es exactamente el problema que la directiva evita.
 */
const INVENTARIO_MUTATION = /* GraphQL */ `
  mutation FijarInventario($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        createdAt
        reason
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Alta de un producto nuevo.
 *
 * Se usa `productSet`, que Shopify recomienda expresamente para «sincronizar
 * información desde una fuente de datos externa» — que es justo este caso. Crea
 * el producto, su opción, su variante, el SKU, el código de barras, el precio y
 * el stock en UNA llamada. Con `productCreate` harían falta tres.
 *
 * `synchronous: true` para que la respuesta traiga el producto ya creado y
 * podamos reportar el resultado real. En modo asíncrono devolvería una
 * operación en curso y habría que consultarla después.
 *
 * El producto se crea SIEMPRE en estado borrador. Ver `crearProductoBorrador`.
 */
const CREAR_PRODUCTO_MUTATION = /* GraphQL */ `
  mutation CrearProducto($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product {
        id
        title
        status
        variants(first: 1) {
          nodes {
            id
            sku
            barcode
            price
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Pedidos pagados, con todo lo que hace falta para facturar.
 *
 * ── Por qué se piden estos campos y no otros ─────────────────────────────────
 *
 * `billingAddress.company` y `shippingAddress.company` son el campo «Empresa»
 * del checkout, que es donde Mundo Love Pet captura el DNI o el RUC. Se piden
 * los dos porque el cliente puede rellenar cualquiera de ellos.
 *
 * `discountedUnitPriceSet` es el precio unitario DESPUÉS de los descuentos de
 * línea. Bsale quiere el descuento como porcentaje aparte, así que hace falta
 * también `originalUnitPriceSet` para calcularlo.
 *
 * `taxesIncluded` decide todo el cálculo: en Perú los precios de la tienda
 * llevan el IGV dentro, y Bsale quiere el valor SIN impuesto. Sin este dato no
 * se puede saber si hay que dividir entre 1,18 o no.
 */
const PEDIDOS_QUERY = /* GraphQL */ `
  query Pedidos($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        legacyResourceId
        name
        createdAt
        processedAt
        displayFinancialStatus
        displayFulfillmentStatus
        taxesIncluded
        currencyCode
        note
        email
        customer {
          id
          firstName
          lastName
          email
        }
        billingAddress {
          company
          address1
          address2
          city
          province
          countryCode
          phone
        }
        shippingAddress {
          company
          address1
          address2
          city
          province
          countryCode
          phone
        }
        totalPriceSet {
          shopMoney {
            amount
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
          }
        }
        totalTaxSet {
          shopMoney {
            amount
          }
        }
        lineItems(first: 100) {
          nodes {
            id
            title
            quantity
            sku
            variant {
              id
            }
            originalUnitPriceSet {
              shopMoney {
                amount
              }
            }
            discountedUnitPriceSet {
              shopMoney {
                amount
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Un pedido concreto por su id.
 *
 * Se relee de aquí antes de emitir en vez de fiarse del payload guardado: entre
 * que llegó el pedido y se factura, alguien pudo cancelarlo o reembolsarlo.
 */
const PEDIDO_QUERY = /* GraphQL */ `
  query Pedido($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      createdAt
      processedAt
      displayFinancialStatus
      displayFulfillmentStatus
      taxesIncluded
      currencyCode
      note
      email
      customer {
        id
        firstName
        lastName
        email
      }
      billingAddress {
        company
        address1
        address2
        city
        province
        countryCode
        phone
      }
      shippingAddress {
        company
        address1
        address2
        city
        province
        countryCode
        phone
      }
      totalPriceSet {
        shopMoney {
          amount
        }
      }
      totalShippingPriceSet {
        shopMoney {
          amount
        }
      }
      totalTaxSet {
        shopMoney {
          amount
        }
      }
      lineItems(first: 100) {
        nodes {
          id
          title
          quantity
          sku
          variant {
            id
          }
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
          discountedUnitPriceSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
`;

export interface LineaPedido {
  id: string;
  titulo: string;
  cantidad: number;
  sku: string | null;
  /** Precio unitario de lista, con IGV si la tienda lo incluye. */
  precioOriginal: number;
  /** Precio unitario tras descuentos de línea. */
  precioConDescuento: number;
}

export interface PedidoShopify {
  id: string;
  /** El id numérico. `OrderSync.shopifyOrderId` lo guarda como BigInt. */
  legacyId: string;
  nombre: string;
  creadoEl: string;
  estadoPago: string;
  estadoEnvio: string;
  /** Si los precios de la tienda ya llevan el IGV dentro. En Perú, sí. */
  impuestosIncluidos: boolean;
  moneda: string;
  email: string | null;
  cliente: { id: string; nombre: string | null; email: string | null } | null;
  /** El campo «Empresa» del checkout: aquí viene el DNI o el RUC. */
  empresa: string | null;
  direccion: {
    linea1: string | null;
    linea2: string | null;
    ciudad: string | null;
    provincia: string | null;
    pais: string | null;
    telefono: string | null;
  };
  total: number;
  envio: number;
  impuestos: number;
  lineas: LineaPedido[];
}

/** La forma cruda que devuelve GraphQL, antes de normalizarla. */
interface RawPedido {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  taxesIncluded: boolean;
  currencyCode: string;
  note: string | null;
  email: string | null;
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
  billingAddress: RawDireccion | null;
  shippingAddress: RawDireccion | null;
  totalPriceSet: { shopMoney: { amount: string } } | null;
  totalShippingPriceSet: { shopMoney: { amount: string } } | null;
  totalTaxSet: { shopMoney: { amount: string } } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      quantity: number;
      sku: string | null;
      variant: { id: string } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } } | null;
      discountedUnitPriceSet: { shopMoney: { amount: string } } | null;
    }>;
  };
}

interface RawDireccion {
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  countryCode: string | null;
  phone: string | null;
}

function importe(nodo: { shopMoney: { amount: string } } | null | undefined): number {
  return nodo ? Number(nodo.shopMoney.amount) : 0;
}

function normalizarPedido(n: RawPedido): PedidoShopify {
  const dir = n.billingAddress ?? n.shippingAddress;

  // El campo «Empresa» puede estar en facturación o en envío. Se prefiere el de
  // facturación, que es donde lo pone quien pide factura a conciencia.
  const empresa =
    n.billingAddress?.company?.trim() || n.shippingAddress?.company?.trim() || null;

  const nombre = [n.customer?.firstName, n.customer?.lastName].filter(Boolean).join(' ').trim();

  return {
    id: n.id,
    legacyId: n.legacyResourceId,
    nombre: n.name,
    creadoEl: n.processedAt ?? n.createdAt,
    estadoPago: n.displayFinancialStatus ?? 'DESCONOCIDO',
    estadoEnvio: n.displayFulfillmentStatus ?? 'DESCONOCIDO',
    impuestosIncluidos: n.taxesIncluded,
    moneda: n.currencyCode,
    email: n.email,
    cliente: n.customer
      ? { id: n.customer.id, nombre: nombre || null, email: n.customer.email }
      : null,
    empresa,
    direccion: {
      linea1: dir?.address1 ?? null,
      linea2: dir?.address2 ?? null,
      ciudad: dir?.city ?? null,
      provincia: dir?.province ?? null,
      pais: dir?.countryCode ?? null,
      telefono: dir?.phone ?? null,
    },
    total: importe(n.totalPriceSet),
    envio: importe(n.totalShippingPriceSet),
    impuestos: importe(n.totalTaxSet),
    lineas: n.lineItems.nodes.map((l) => ({
      id: l.id,
      titulo: l.title,
      cantidad: l.quantity,
      sku: l.sku,
      precioOriginal: importe(l.originalUnitPriceSet),
      // Si Shopify no manda el precio con descuento, el original ya es el final.
      precioConDescuento: l.discountedUnitPriceSet
        ? importe(l.discountedUnitPriceSet)
        : importe(l.originalUnitPriceSet),
    })),
  };
}

export interface ProductoNuevo {
  titulo: string;
  sku: string;
  /**
   * Código de barras del fabricante, tal como está en Bsale. **Nunca el SKU.**
   *
   * `null` cuando la variante de Bsale no tiene ninguno, y en ese caso el campo
   * se omite en la mutación: mejor vacío que con un valor inventado.
   */
  barcode: string | null;
  /**
   * La marca de Bsale.
   *
   * En Shopify el campo que le corresponde se llama `vendor` —«Proveedor» en la
   * interfaz en español—. No hay un campo «marca» aparte: Shopify usa ése tanto
   * para el fabricante como para el proveedor, y es el que aparece en los
   * filtros de la tienda.
   */
  marca: string | null;
  /** Precio con IGV. */
  precio: number;
  /**
   * Costo promedio de Bsale, para el campo «Costo por artículo» de Shopify.
   * `null` cuando Bsale no tiene costo registrado; entonces se omite en vez de
   * mandar cero, porque un cero declara un margen del 100 % que es mentira.
   */
  costo: number | null;
  /** Stock inicial. Puede ser cero: el producto se crea agotado, que es correcto. */
  stock: number | null;
  locationId: string;
}

export interface ResultadoCreacion {
  ok: boolean;
  productId: string | null;
  errores: string[];
}

export interface CambioPrecio {
  productId: string;
  variantId: string;
  precio: string;
}

export interface CambioInventario {
  inventoryItemId: string;
  locationId: string;
  cantidad: number;
  /** La cantidad que Shopify tenía cuando la leímos. La exige la API. */
  desde: number;
}

export interface ResultadoEscritura {
  ok: boolean;
  errores: string[];
}

export class ShopifyClient {
  private readonly shopDomain: string;
  private readonly accessToken: AccessTokenSource;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private lastThrottle: ThrottleStatus | null = null;

  constructor(opts: ShopifyClientOptions) {
    if (!opts.shopDomain) {
      throw new IntegrationError('Falta el dominio de la tienda Shopify.', {
        provider: 'SHOPIFY',
        retryable: false,
      });
    }
    if (!opts.accessToken) {
      throw new IntegrationError('Falta el Admin API access token de Shopify.', {
        provider: 'SHOPIFY',
        retryable: false,
      });
    }
    this.shopDomain = opts.shopDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get endpoint(): string {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  /**
   * Resuelve el token justo antes de cada petición.
   *
   * Con un proveedor de client credentials esto importa: el token caduca cada
   * ~24 h y el proveedor decide si devuelve el de la caché o pide uno nuevo. Si
   * se resolviera una sola vez en el constructor, el cliente se quedaría con un
   * token muerto y empezaría a recibir 401 al día siguiente.
   */
  private async resolverToken(): Promise<string> {
    return typeof this.accessToken === 'function' ? this.accessToken() : this.accessToken;
  }

  /** Última lectura del bucket de coste. Útil para mostrarlo en el panel. */
  get throttleStatus(): ThrottleStatus | null {
    return this.lastThrottle;
  }

  // ── API pública ────────────────────────────────────────────────────────────

  /**
   * Prueba de conexión: consulta el objeto `shop`.
   * Coste mínimo, sólo lectura, y devuelve moneda y zona horaria — datos que la
   * app necesita después para formatear montos y fechas de emisión.
   */
  async testConnection(): Promise<{ ok: true; shop: ShopInfo; apiVersion: string }> {
    const data = await this.query<{ shop: ShopInfo }>(SHOP_QUERY);
    return { ok: true, shop: data.shop, apiVersion: this.apiVersion };
  }

  async listLocations(first = 20): Promise<ShopifyLocation[]> {
    const data = await this.query<{ locations: { nodes: ShopifyLocation[] } }>(LOCATIONS_QUERY, {
      first,
    });
    return data.locations.nodes;
  }

  /**
   * Recorre todas las variantes de la tienda.
   *
   * GraphQL pagina por cursor, no por offset: se pide `first` y se sigue con el
   * `endCursor` de la página anterior mientras `hasNextPage` sea cierto. Usar
   * offset aquí no es una opción — la API no lo ofrece.
   *
   * `first` es 100 porque es el máximo que admite Shopify por página. Si el
   * coste de la consulta hiciera saltar el throttling, el propio cliente espera
   * lo que el bucket indica y reintenta.
   */
  async *listarVariantes(maxItems = 100_000): AsyncGenerator<ShopifyVariant, void, undefined> {
    let after: string | null = null;
    let vistos = 0;

    for (;;) {
      const data: {
        productVariants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            sku: string | null;
            barcode: string | null;
            price: string | null;
            inventoryQuantity: number | null;
            inventoryItem: { id: string; unitCost: { amount: string } | null } | null;
            title: string | null;
            product: {
              id: string;
              title: string;
              status: string | null;
              media: { nodes: Array<{ id: string }> } | null;
            } | null;
          }>;
        };
      } = await this.query(VARIANTS_QUERY, { first: 100, after });

      for (const n of data.productVariants.nodes) {
        yield {
          id: n.id,
          sku: n.sku,
          barcode: n.barcode,
          price: n.price,
          inventoryQuantity: n.inventoryQuantity,
          inventoryItemId: n.inventoryItem?.id ?? null,
          costo: n.inventoryItem?.unitCost?.amount == null
            ? null
            : Number(n.inventoryItem.unitCost.amount),
          productId: n.product?.id ?? null,
          productTitle: n.product?.title ?? null,
          title: n.title,
          estado: n.product?.status ?? null,
          tieneImagen: (n.product?.media?.nodes?.length ?? 0) > 0,
        };
        vistos++;
        if (vistos >= maxItems) return;
      }

      if (!data.productVariants.pageInfo.hasNextPage) return;
      after = data.productVariants.pageInfo.endCursor;
      // Sin cursor no se puede continuar; salir es mejor que repetir la página.
      if (!after) return;
    }
  }

  // ── Escritura (Fase 3) ─────────────────────────────────────────────────────

  /**
   * Fija el precio de varias variantes del MISMO producto.
   *
   * Shopify devuelve HTTP 200 con `userErrors` cuando rechaza el cambio: hay
   * que mirarlos, o una actualización fallida pasaría por buena.
   */
  async actualizarPrecios(
    productId: string,
    cambios: Array<{ variantId: string; precio: string }>,
  ): Promise<ResultadoEscritura> {
    const data = await this.query<{
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string; price: string }> | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(PRECIO_MUTATION, {
      productId,
      variants: cambios.map((c) => ({ id: c.variantId, price: c.precio })),
    });

    const errores = (data.productVariantsBulkUpdate?.userErrors ?? []).map(
      (e) => `${(e.field ?? []).join('.')}: ${e.message}`,
    );
    return { ok: errores.length === 0, errores };
  }

  /**
   * Recorre los pedidos de la tienda, del más reciente al más antiguo.
   *
   * `filtro` usa la sintaxis de búsqueda de Shopify. El que interesa para
   * facturar es `financial_status:paid`: un pedido sin pagar no se factura.
   *
   * El campo «Empresa» se toma de la dirección de facturación y, si está vacía,
   * de la de envío. El cliente puede haberlo escrito en cualquiera de las dos y
   * quedarse sólo con una perdería pedidos.
   */
  async *listarPedidos(
    filtro = 'financial_status:paid',
    maxItems = 500,
  ): AsyncGenerator<PedidoShopify, void, undefined> {
    let after: string | null = null;
    let vistos = 0;

    for (;;) {
      const data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawPedido[] } } =
        await this.query(PEDIDOS_QUERY, { first: 25, after, query: filtro });

      for (const n of data.orders.nodes) {
        yield normalizarPedido(n);
        vistos++;
        if (vistos >= maxItems) return;
      }

      if (!data.orders.pageInfo.hasNextPage) return;
      after = data.orders.pageInfo.endCursor;
      if (!after) return;
    }
  }

  /** Un pedido concreto, releído de Shopify. */
  async obtenerPedido(gid: string): Promise<PedidoShopify | null> {
    const data = await this.query<{ order: RawPedido | null }>(PEDIDO_QUERY, { id: gid });
    return data.order ? normalizarPedido(data.order) : null;
  }

  /**
   * Corrige el código de barras y/o el costo de varias variantes de un producto.
   *
   * Cada campo se manda sólo si viene: así se puede arreglar el código de barras
   * sin tocar el costo, o al revés, sin borrar sin querer el que ya estaba.
   */
  async repararVariantes(
    productId: string,
    cambios: Array<{ variantId: string; barcode?: string; costo?: number }>,
  ): Promise<ResultadoEscritura> {
    if (cambios.length === 0) return { ok: true, errores: [] };

    const data = await this.query<{
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string; barcode: string | null }> | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(REPARAR_MUTATION, {
      productId,
      variants: cambios.map((c) => ({
        id: c.variantId,
        ...(c.barcode === undefined ? {} : { barcode: c.barcode }),
        ...(c.costo === undefined ? {} : { inventoryItem: { cost: c.costo } }),
      })),
    });

    const errores = (data.productVariantsBulkUpdate?.userErrors ?? []).map(
      (e) => `${(e.field ?? []).join('.')}: ${e.message}`,
    );
    return { ok: errores.length === 0, errores };
  }

  /**
   * Escribe en el pedido de Shopify los datos del comprobante emitido.
   *
   * Van bajo el espacio de nombres `bsale` para que se distingan de cualquier
   * otro metafield de la tienda y se puedan borrar en bloque si algún día se
   * desinstala la app.
   *
   * Todos son texto, incluido el número: aquí no se hacen cuentas con él y un
   * `number_integer` obligaría a declarar la definición del metafield antes de
   * poder escribirlo.
   */
  async guardarComprobanteEnPedido(
    orderGid: string,
    datos: { tipo: string; serie: string; numero: number; documentoId: number },
  ): Promise<ResultadoEscritura> {
    const metafields = [
      { key: 'document_type', value: datos.tipo },
      { key: 'serial_number', value: datos.serie },
      { key: 'document_number', value: String(datos.numero) },
      { key: 'document_id', value: String(datos.documentoId) },
    ].map((m) => ({
      ownerId: orderGid,
      namespace: 'bsale',
      type: 'single_line_text_field',
      ...m,
    }));

    const data = await this.query<{
      metafieldsSet: {
        metafields: Array<{ key: string; value: string }> | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(METAFIELDS_MUTATION, { metafields });

    const errores = (data.metafieldsSet?.userErrors ?? []).map(
      (e) => `${(e.field ?? []).join('.')}: ${e.message}`,
    );
    return { ok: errores.length === 0, errores };
  }

  /**
   * Fija el inventario disponible de varios artículos en una sucursal.
   *
   * `reason: 'correction'` porque eso es exactamente lo que es: el stock de
   * Shopify estaba mal y se corrige con el de Bsale. Queda registrado así en el
   * historial de inventario de la tienda, que es lo que verá el comerciante.
   */
  async fijarInventario(cambios: CambioInventario[]): Promise<ResultadoEscritura> {
    if (cambios.length === 0) return { ok: true, errores: [] };

    const data = await this.query<{
      inventorySetQuantities: {
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(INVENTARIO_MUTATION, {
      // Una clave por llamada. El bucle de reintentos de `query` reutiliza
      // estas mismas variables, así que un reintento lleva la misma clave y
      // Shopify no vuelve a aplicar el ajuste.
      idempotencyKey: randomUUID(),
      input: {
        name: 'available',
        reason: 'correction',
        // Identifica el origen del cambio en el historial de inventario de
        // Shopify. Sin esto, el comerciante ve ajustes sin saber quién los
        // hizo; con esto aparece el nombre de la integración.
        referenceDocumentUri: `gid://mundolovepet-sync/BsaleSync/${Date.now()}`,
        quantities: cambios.map((c) => ({
          inventoryItemId: c.inventoryItemId,
          locationId: c.locationId,
          quantity: c.cantidad,
          changeFromQuantity: c.desde,
        })),
      },
    });

    const errores = (data.inventorySetQuantities?.userErrors ?? []).map(
      (e) => `${(e.field ?? []).join('.')}: ${e.message}`,
    );
    return { ok: errores.length === 0, errores };
  }

  /**
   * Crea un producto en **borrador**, con una sola variante.
   *
   * ── Por qué borrador y no publicado ──────────────────────────────────────
   *
   * Un producto venido de Bsale llega sin foto, sin descripción y sin
   * colección. Publicarlo automáticamente llenaría la tienda de fichas a medias
   * que el cliente puede encontrar en el buscador. En borrador queda listo —con
   * su SKU, precio y stock correctos— y el comerciante solo tiene que añadir la
   * foto y publicarlo.
   *
   * El estado NO es configurable a propósito: dejar que se publique
   * automáticamente es el tipo de opción que alguien activa «un momento para
   * probar» y se olvida.
   *
   * ── El SKU y el código de barras son campos DISTINTOS ────────────────────
   *
   * Una versión anterior copiaba el SKU al campo `barcode` de Shopify dando por
   * hecho que en Bsale había un único código. No es así: una variante de Bsale
   * tiene `code` (el SKU interno) y `barCode` (el EAN del fabricante), y son
   * valores distintos —p. ej. SKU 74352029961567 y EAN 8595602559152—. Copiar
   * uno sobre el otro destruía el EAN real, que es justo el que leen los
   * lectores de tienda y el que usa Google Shopping.
   *
   * Ahora `barcode` se manda sólo si Bsale tiene uno, y si no se omite.
   */
  async crearProductoBorrador(p: ProductoNuevo): Promise<ResultadoCreacion> {
    const data = await this.query<{
      productSet: {
        product: { id: string } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(CREAR_PRODUCTO_MUTATION, {
      input: {
        title: p.titulo,
        status: 'DRAFT',
        // Se omite si no hay marca, en vez de mandar cadena vacía: un proveedor
        // en blanco ensucia los filtros de la tienda igual que uno inventado.
        ...(p.marca ? { vendor: p.marca } : {}),
        // Un producto sin variantes explícitas necesita igualmente una opción.
        // «Title / Default Title» es la convención de Shopify para eso.
        productOptions: [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }],
        variants: [
          {
            optionValues: [{ optionName: 'Title', name: 'Default Title' }],
            price: p.precio,
            sku: p.sku,
            ...(p.barcode ? { barcode: p.barcode } : {}),
            // Sin `tracked: true` Shopify no lleva la cuenta del inventario y
            // el producto se podría vender sin límite.
            inventoryItem: { tracked: true, ...(p.costo === null ? {} : { cost: p.costo }) },
            ...(p.stock === null
              ? {}
              : {
                  inventoryQuantities: [
                    { locationId: p.locationId, name: 'available', quantity: p.stock },
                  ],
                }),
          },
        ],
      },
    });

    const errores = (data.productSet?.userErrors ?? []).map(
      (e) => `${(e.field ?? []).join('.')}: ${e.message}`,
    );
    return {
      ok: errores.length === 0 && Boolean(data.productSet?.product?.id),
      productId: data.productSet?.product?.id ?? null,
      errores,
    };
  }

  // ── Transporte ─────────────────────────────────────────────────────────────

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: IntegrationError | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.queryOnce<T>(query, variables);
      } catch (error) {
        const err = error as IntegrationError;
        lastError = err;
        if (!err.retryable || attempt === this.maxRetries) throw err;
        await this.sleep(this.retryDelayMs(attempt, err));
      }
    }
    throw lastError ?? new IntegrationError('Fallo desconocido en Shopify.', { provider: 'SHOPIFY' });
  }

  /**
   * Si el fallo fue por throttling, esperamos lo que el propio bucket nos dice
   * que tardará en recuperarse, en vez de un backoff a ciegas.
   */
  private retryDelayMs(attempt: number, err: IntegrationError): number {
    if (err.code === 'THROTTLED' && this.lastThrottle) {
      const { maximumAvailable, currentlyAvailable, restoreRate } = this.lastThrottle;
      if (restoreRate > 0) {
        const deficit = Math.max(0, maximumAvailable / 2 - currentlyAvailable);
        return Math.min(10_000, Math.ceil((deficit / restoreRate) * 1000) + 250);
      }
    }
    return backoffDelayMs(attempt);
  }

  private async queryOnce<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Se resuelve una sola vez por petición: se usa para la cabecera y también
    // para redactarlo si hay que construir un mensaje de error.
    const token = await this.resolverToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (cause) {
      const isAbort = (cause as Error)?.name === 'AbortError';
      throw new IntegrationError(
        isAbort ? `Shopify no respondió en ${this.timeoutMs} ms.` : 'No se pudo conectar con Shopify.',
        { provider: 'SHOPIFY', retryable: true, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();

    if (!response.ok) {
      throw new IntegrationError(this.describeHttpError(response.status), {
        provider: 'SHOPIFY',
        status: response.status,
        ...(response.status === 429 ? { code: 'THROTTLED' } : {}),
      });
    }

    let payload: GraphQLResponse<T>;
    try {
      payload = JSON.parse(raw) as GraphQLResponse<T>;
    } catch (cause) {
      throw new IntegrationError('Shopify devolvió una respuesta que no es JSON válido.', {
        provider: 'SHOPIFY',
        status: response.status,
        retryable: false,
        cause,
      });
    }

    if (payload.extensions?.cost?.throttleStatus) {
      this.lastThrottle = payload.extensions.cost.throttleStatus;
    }

    // Shopify puede responder 200 con errores de GraphQL en el cuerpo.
    if (payload.errors?.length) {
      const code = payload.errors[0]?.extensions?.code;
      const message = payload.errors.map((e) => e.message).join(' | ');
      throw new IntegrationError(
        scrubMessage(`Shopify devolvió errores de GraphQL: ${message}`, [token]),
        {
          provider: 'SHOPIFY',
          status: response.status,
          ...(code ? { code } : {}),
          // THROTTLED es transitorio; el resto de errores GraphQL son del query.
          retryable: code === 'THROTTLED',
          detail: payload.errors,
        },
      );
    }

    if (!payload.data) {
      throw new IntegrationError('Shopify respondió sin datos ni errores.', {
        provider: 'SHOPIFY',
        status: response.status,
        retryable: false,
      });
    }

    return payload.data;
  }

  private describeHttpError(status: number): string {
    switch (status) {
      case 401:
        return 'Shopify rechazó el token (401). Verifica el Admin API access token de la Custom App.';
      case 402:
        return 'La tienda Shopify está en pausa o con pago pendiente (402).';
      case 403:
        return 'Token válido pero sin permisos suficientes (403). Revisa los scopes de la Custom App.';
      case 404:
        return 'Endpoint no encontrado (404). Verifica el dominio de la tienda y la versión de API.';
      case 423:
        return 'La tienda está bloqueada (423).';
      case 429:
        return 'Shopify está limitando las peticiones (429). Se reintentará respetando el bucket de coste.';
      default:
        return status >= 500
          ? `Error interno de Shopify (${status}). Se reintentará.`
          : `Shopify respondió con estado ${status}.`;
    }
  }
}
