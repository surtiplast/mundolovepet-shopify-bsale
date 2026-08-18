/**
 * Lectura del catálogo de Bsale y diagnóstico de SKU — Fase 2.
 *
 * Esta fase NO escribe nada en Shopify ni en Bsale. Lee el catálogo, lo cruza
 * consigo mismo y avisa de los problemas que impedirían sincronizar bien.
 *
 * ── Por qué el diagnóstico de SKU va antes que la sincronización ─────────────
 *
 * La regla del proyecto es «SKU de Bsale == SKU de Shopify»: es lo único que
 * une una variante de un sistema con la del otro. Si un SKU está repetido en
 * Bsale, la Fase 3 no puede saber a qué variante de Shopify corresponde, y
 * escribiría el precio o el stock en la equivocada. Si falta, esa variante
 * simplemente no se puede sincronizar.
 *
 * Descubrirlo leyendo cuesta un minuto. Descubrirlo escribiendo cuesta revisar
 * a mano los precios de un catálogo entero.
 */
import type {
  BsaleClient,
  BsalePriceDetail,
  BsaleStock,
  BsaleVariant,
} from '../integrations/bsale/client.js';

export type ProblemaSku = 'SIN_SKU' | 'SKU_DUPLICADO' | 'SIN_PRECIO' | 'SIN_STOCK';

export interface ItemCatalogo {
  bsaleVariantId: number;
  bsaleProductId: number | null;
  /** El SKU tal cual viene de Bsale, ya recortado. Cadena vacía si no tiene. */
  sku: string;
  nombre: string | null;
  /** Precio con impuestos incluidos. `null` si la variante no está en la lista. */
  precio: number | null;
  /** Stock disponible en la sucursal consultada. `null` si no hay registro. */
  stock: number | null;
  problemas: ProblemaSku[];
}

export interface ResumenCatalogo {
  total: number;
  conProblemas: number;
  sinSku: number;
  skusDuplicados: number;
  /** Los SKU concretos que aparecen más de una vez, con sus variantes. */
  duplicados: Array<{ sku: string; variantes: number[] }>;
  sinPrecio: number;
  sinStock: number;
  leidoEn: string;
}

export interface CatalogoLeido {
  items: ItemCatalogo[];
  resumen: ResumenCatalogo;
}

export interface LeerCatalogoOpciones {
  priceListId: number;
  officeId: number;
  /** Tope de seguridad, por si el catálogo es enorme y sólo se quiere una muestra. */
  maxItems?: number;
  now?: () => Date;
}

/**
 * Lee el catálogo completo y lo devuelve cruzado con precios y stock.
 *
 * Se hacen tres recorridos completos —variantes, precios y stock— en lugar de
 * pedir el precio y el stock de cada variante por separado. Con 2.000 variantes,
 * lo primero son unas 120 peticiones; lo segundo, 4.000.
 */
export async function leerCatalogo(
  client: BsaleClient,
  opciones: LeerCatalogoOpciones,
): Promise<CatalogoLeido> {
  const now = opciones.now ?? (() => new Date());

  const variantes: BsaleVariant[] = [];
  for await (const v of client.listarVariantes(opciones.maxItems)) variantes.push(v);

  // Precio y stock se indexan por id de variante para cruzarlos en O(1).
  const precioPorVariante = new Map<number, number>();
  for await (const p of client.listarPrecios(opciones.priceListId, opciones.maxItems)) {
    const id = idDeVariante(p);
    if (id === null) continue;
    // variantValueWithTaxes es el precio final al público; es el que interesa
    // para publicar en Shopify, que trabaja con precios con impuestos en Perú.
    const valor = p.variantValueWithTaxes ?? p.variantValue;
    if (typeof valor === 'number') precioPorVariante.set(id, valor);
  }

  const stockPorVariante = new Map<number, number>();
  for await (const s of client.listarStock(opciones.officeId, opciones.maxItems)) {
    const id = idDeVariante(s);
    if (id === null) continue;
    // Se usa el DISPONIBLE, no el total: el reservado ya está comprometido en
    // otros pedidos y publicarlo como vendible provoca sobreventa.
    const cantidad = s.quantityAvailable ?? s.quantity;
    if (typeof cantidad === 'number') stockPorVariante.set(id, cantidad);
  }

  // Cuántas veces aparece cada SKU. Se compara en minúsculas y sin espacios:
  // «ABC-1» y «abc-1 » son el mismo SKU para cualquier operario, y tratarlos
  // como distintos crearía dos productos en Shopify.
  const conteoSku = new Map<string, number[]>();
  for (const v of variantes) {
    const sku = normalizarSku(v.code);
    if (!sku) continue;
    const lista = conteoSku.get(sku) ?? [];
    lista.push(v.id);
    conteoSku.set(sku, lista);
  }

  const items: ItemCatalogo[] = variantes.map((v) => {
    const skuCrudo = (v.code ?? '').trim();
    const skuNormalizado = normalizarSku(v.code);
    const precio = precioPorVariante.get(v.id) ?? null;
    const stock = stockPorVariante.get(v.id) ?? null;

    const problemas: ProblemaSku[] = [];
    if (!skuNormalizado) problemas.push('SIN_SKU');
    else if ((conteoSku.get(skuNormalizado)?.length ?? 0) > 1) problemas.push('SKU_DUPLICADO');
    if (precio === null) problemas.push('SIN_PRECIO');
    if (stock === null) problemas.push('SIN_STOCK');

    return {
      bsaleVariantId: v.id,
      bsaleProductId: v.product?.id ?? null,
      sku: skuCrudo,
      nombre: v.description ?? null,
      precio,
      stock,
      problemas,
    };
  });

  const duplicados = [...conteoSku.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([sku, variantes_]) => ({ sku, variantes: variantes_ }))
    .sort((a, b) => b.variantes.length - a.variantes.length);

  const resumen: ResumenCatalogo = {
    total: items.length,
    conProblemas: items.filter((i) => i.problemas.length > 0).length,
    sinSku: items.filter((i) => i.problemas.includes('SIN_SKU')).length,
    skusDuplicados: duplicados.length,
    duplicados,
    sinPrecio: items.filter((i) => i.problemas.includes('SIN_PRECIO')).length,
    sinStock: items.filter((i) => i.problemas.includes('SIN_STOCK')).length,
    leidoEn: now().toISOString(),
  };

  return { items, resumen };
}

/**
 * Normaliza un SKU para compararlo.
 *
 * Minúsculas y sin espacios en los extremos. No se tocan guiones ni puntos: en
 * un catálogo real «AB-01» y «AB01» pueden ser productos distintos de verdad, y
 * unificarlos escondería un problema en vez de resolverlo.
 */
export function normalizarSku(code: string | null | undefined): string {
  return (code ?? '').trim().toLowerCase();
}

function idDeVariante(x: BsalePriceDetail | BsaleStock): number | null {
  const id = x.variant?.id;
  if (typeof id === 'number') return id;
  // Algunos endpoints devuelven sólo el href: /v1/variants/123.json
  const href = x.variant?.href;
  const m = href?.match(/\/variants\/(\d+)\.json/);
  return m ? Number(m[1]) : null;
}
