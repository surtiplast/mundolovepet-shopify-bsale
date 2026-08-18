/**
 * Emparejamiento Bsale ↔ Shopify — primer paso de la Fase 3.
 *
 * ── Por qué esto va antes de sincronizar nada ────────────────────────────────
 *
 * La sincronización necesita saber qué variante de Shopify corresponde a cada
 * variante de Bsale. La regla del proyecto es «el código las une», pero hay un
 * detalle que decide si funciona o no: **en Shopify ese código puede estar en
 * `sku` o en `barcode`, y son campos distintos.**
 *
 * En el catálogo de Mundo Love Pet los códigos de Bsale son EAN de 14 dígitos.
 * Un catálogo así, importado desde un ERP, es habitual que los tenga en
 * `barcode` y el `sku` vacío. Si la sincronización busca por `sku` y el número
 * está en `barcode`, no encuentra nada: **no da error, simplemente no actualiza
 * ningún producto**. Y eso se descubre tarde y mal.
 *
 * Este módulo no escribe nada. Compara los dos catálogos contra los dos campos
 * y dice cuál empareja mejor, para elegir con datos y no por suposición.
 */
import type { ShopifyVariant } from '../integrations/shopify/client.js';
import { normalizarSku } from './catalog.service.js';

export type CampoEmparejamiento = 'sku' | 'barcode';

export interface CodigoBsale {
  sku: string;
  bsaleVariantId: number;
  nombre: string | null;
  precio: number | null;
  stock: number | null;
}

export interface Emparejado {
  codigo: string;
  bsaleVariantId: number;
  shopifyVariantId: string;
  shopifyInventoryItemId: string | null;
  nombreShopify: string | null;
  precioBsale: number | null;
  precioShopify: number | null;
  stockBsale: number | null;
  stockShopify: number | null;
  /** Difieren precio o stock: es lo que la sincronización tendría que escribir. */
  difierePrecio: boolean;
  difiereStock: boolean;
}

export interface InformeEmparejamiento {
  /** El campo que más coincidencias produce. Es el que debe usar la Fase 3. */
  campoRecomendado: CampoEmparejamiento;
  coincidenciasPorSku: number;
  coincidenciasPorBarcode: number;
  totalBsale: number;
  totalShopify: number;
  emparejados: Emparejado[];
  /** En Bsale pero no en Shopify: habría que crearlos. */
  soloEnBsale: string[];
  /** En Shopify pero no en Bsale: quedarían huérfanos, sin stock que sincronizar. */
  soloEnShopify: string[];
  /** Variantes de Shopify sin ningún código en el campo elegido. */
  shopifySinCodigo: number;
  conDiferencias: number;
  advertencias: string[];
}

/**
 * Compara ambos catálogos y devuelve el informe.
 *
 * No decide nada por su cuenta más allá de recomendar el campo: la Fase 3
 * seguirá pidiendo confirmación antes de escribir.
 */
export function compararCatalogos(
  bsale: CodigoBsale[],
  shopify: ShopifyVariant[],
): InformeEmparejamiento {
  const codigosBsale = new Map<string, CodigoBsale>();
  for (const b of bsale) {
    const clave = normalizarSku(b.sku);
    if (clave) codigosBsale.set(clave, b);
  }

  const porSku = indexar(shopify, 'sku');
  const porBarcode = indexar(shopify, 'barcode');

  const aciertosSku = contarAciertos(codigosBsale, porSku);
  const aciertosBarcode = contarAciertos(codigosBsale, porBarcode);

  // Empate a cero incluido: se prefiere `sku` porque es el campo que Shopify
  // documenta para esto, y así el mensaje de «no empareja nada» apunta al sitio
  // que el comerciante espera revisar.
  const campoRecomendado: CampoEmparejamiento =
    aciertosBarcode > aciertosSku ? 'barcode' : 'sku';
  const indice = campoRecomendado === 'barcode' ? porBarcode : porSku;

  const emparejados: Emparejado[] = [];
  const soloEnBsale: string[] = [];

  for (const [clave, b] of codigosBsale) {
    const s = indice.get(clave);
    if (!s) {
      soloEnBsale.push(b.sku);
      continue;
    }

    const precioShopify = s.price == null ? null : Number(s.price);
    const stockShopify = s.inventoryQuantity;

    emparejados.push({
      codigo: b.sku,
      bsaleVariantId: b.bsaleVariantId,
      shopifyVariantId: s.id,
      shopifyInventoryItemId: s.inventoryItemId,
      nombreShopify: s.productTitle,
      precioBsale: b.precio,
      precioShopify,
      stockBsale: b.stock,
      stockShopify,
      // Se comparan con tolerancia de céntimo: los precios viajan como cadena
      // en Shopify y como número en Bsale, y 18 vs 18.00 no es una diferencia.
      difierePrecio:
        b.precio != null && precioShopify != null && Math.abs(b.precio - precioShopify) >= 0.01,
      difiereStock: b.stock != null && stockShopify != null && b.stock !== stockShopify,
    });
  }

  const clavesBsale = new Set(codigosBsale.keys());
  const soloEnShopify: string[] = [];
  let shopifySinCodigo = 0;

  for (const s of shopify) {
    const clave = normalizarSku(campoRecomendado === 'barcode' ? s.barcode : s.sku);
    if (!clave) {
      shopifySinCodigo++;
      continue;
    }
    if (!clavesBsale.has(clave)) soloEnShopify.push(clave);
  }

  const advertencias: string[] = [];

  if (aciertosSku === 0 && aciertosBarcode === 0) {
    advertencias.push(
      'Ningún código de Bsale coincide con Shopify, ni por SKU ni por código de barras. ' +
        'Revisa que los productos de Shopify tengan cargado el código antes de sincronizar.',
    );
  } else if (campoRecomendado === 'barcode') {
    advertencias.push(
      'Los códigos coinciden con el campo «código de barras» de Shopify, no con el SKU. ' +
        'La sincronización usará el código de barras.',
    );
  }

  if (shopifySinCodigo > 0) {
    advertencias.push(
      `${shopifySinCodigo} variantes de Shopify no tienen ${campoRecomendado === 'barcode' ? 'código de barras' : 'SKU'}: no se podrán sincronizar.`,
    );
  }

  if (soloEnBsale.length > 0) {
    advertencias.push(
      `${soloEnBsale.length} productos existen en Bsale pero no en Shopify. La Fase 3 no los crea: sólo actualiza los que ya existen.`,
    );
  }

  return {
    campoRecomendado,
    coincidenciasPorSku: aciertosSku,
    coincidenciasPorBarcode: aciertosBarcode,
    totalBsale: codigosBsale.size,
    totalShopify: shopify.length,
    emparejados,
    soloEnBsale,
    soloEnShopify,
    shopifySinCodigo,
    conDiferencias: emparejados.filter((e) => e.difierePrecio || e.difiereStock).length,
    advertencias,
  };
}

/**
 * Indexa las variantes de Shopify por uno de sus campos.
 *
 * Si un mismo código aparece en varias variantes se queda la primera y no se
 * cuenta dos veces: emparejar una variante de Bsale con dos de Shopify sería
 * ambiguo, y escribir en las dos es justo lo que no queremos.
 */
function indexar(
  variantes: ShopifyVariant[],
  campo: CampoEmparejamiento,
): Map<string, ShopifyVariant> {
  const mapa = new Map<string, ShopifyVariant>();
  for (const v of variantes) {
    const clave = normalizarSku(campo === 'barcode' ? v.barcode : v.sku);
    if (clave && !mapa.has(clave)) mapa.set(clave, v);
  }
  return mapa;
}

function contarAciertos(
  bsale: Map<string, CodigoBsale>,
  shopify: Map<string, ShopifyVariant>,
): number {
  let n = 0;
  for (const clave of bsale.keys()) if (shopify.has(clave)) n++;
  return n;
}
