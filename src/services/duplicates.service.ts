/**
 * Informe de códigos repetidos en Shopify.
 *
 * ── De dónde salen los duplicados ────────────────────────────────────────────
 *
 * Del alta de productos, cuando la comparación miraba un solo campo: un producto
 * que en Shopify tenía el código en `barcode` con el `sku` vacío se daba por
 * ausente y se creaba otra vez. Ver `docs/SKU-DUPLICADOS.md`.
 *
 * Aquello ya está arreglado, pero **los duplicados que se crearon siguen ahí**.
 * Este módulo los encuentra.
 *
 * ── Por qué sólo informa y no borra ──────────────────────────────────────────
 *
 * Borrar productos de una tienda es la operación más destructiva que podría
 * hacer esta app, y aquí no hay forma de estar seguro: dos variantes con el
 * mismo código pueden ser un duplicado que crearon nosotros, o dos productos
 * distintos que el comerciante quiso registrar así. Un formato en dos tamaños
 * mal cargado tiene esa pinta y no debe desaparecer.
 *
 * Lo que sí puede hacer el informe es **ordenar la sospecha**: marca cuál de las
 * variantes tiene toda la pinta de haberla creado la app —borrador, sin imagen,
 * creada tarde— para que la decisión humana sea rápida en vez de arqueológica.
 */
import type { ShopifyVariant } from '../integrations/shopify/client.js';
import { normalizarSku } from './catalog.service.js';

export interface VarianteRepetida {
  variantId: string;
  productId: string | null;
  titulo: string | null;
  sku: string | null;
  barcode: string | null;
  precio: number | null;
  stock: number | null;
  /** `true` si es borrador: el estado en que la app crea los productos. */
  esBorrador: boolean;
  /** `true` si no tiene ninguna imagen. Los que crea la app nunca la tienen. */
  sinImagen: boolean;
  /**
   * Cuánto se parece a algo creado por la app, de 0 a 2.
   *
   * No es una certeza, es una ordenación: los de puntuación 2 —borrador y sin
   * imagen— son los que primero conviene mirar.
   */
  sospecha: number;
}

export interface GrupoDuplicado {
  /** El código que comparten, normalizado. */
  codigo: string;
  /** En qué campo coinciden. */
  campo: 'sku' | 'barcode' | 'ambos';
  variantes: VarianteRepetida[];
}

export interface InformeDuplicados {
  grupos: GrupoDuplicado[];
  resumen: {
    /** Códigos que aparecen en más de una variante. */
    codigosRepetidos: number;
    /** Variantes implicadas, sumando todos los grupos. */
    variantesImplicadas: number;
    /** Cuántas sobran: una por código se queda, el resto son excedente. */
    excedente: number;
    /** De ese excedente, cuántas parecen creadas por la app. */
    sospechosas: number;
  };
}

function aVarianteRepetida(v: ShopifyVariant): VarianteRepetida {
  const esBorrador = v.estado === 'DRAFT';
  const sinImagen = v.tieneImagen === false;

  return {
    variantId: v.id,
    productId: v.productId,
    titulo: v.productTitle,
    sku: v.sku,
    barcode: v.barcode,
    precio: v.price == null ? null : Number(v.price),
    stock: v.inventoryQuantity,
    esBorrador,
    sinImagen,
    sospecha: (esBorrador ? 1 : 0) + (sinImagen ? 1 : 0),
  };
}

/**
 * Busca códigos que aparezcan en más de una variante. **No escribe nada.**
 *
 * Se agrupa por SKU y por código de barras por separado, y luego se juntan: un
 * mismo par de variantes puede colisionar por los dos campos, y en ese caso
 * debe salir una sola vez.
 */
export function buscarDuplicados(variantes: ShopifyVariant[]): InformeDuplicados {
  const porSku = new Map<string, ShopifyVariant[]>();
  const porBarcode = new Map<string, ShopifyVariant[]>();

  for (const v of variantes) {
    const sku = normalizarSku(v.sku);
    const barcode = normalizarSku(v.barcode);

    if (sku) porSku.set(sku, [...(porSku.get(sku) ?? []), v]);
    // Si el código de barras es igual al SKU no se indexa aparte: sería el
    // mismo choque contado dos veces. Pasa en los productos que la app creó
    // antes de arreglar el código de barras.
    if (barcode && barcode !== sku) {
      porBarcode.set(barcode, [...(porBarcode.get(barcode) ?? []), v]);
    }
  }

  /** Los grupos ya vistos, para no repetir un choque que ocurre en los dos campos. */
  const grupos = new Map<string, GrupoDuplicado>();

  const anadir = (codigo: string, lista: ShopifyVariant[], campo: 'sku' | 'barcode') => {
    if (lista.length < 2) return;

    const existente = grupos.get(codigo);
    if (existente) {
      // El mismo código choca por los dos campos. Se marca así y se unen las
      // variantes sin repetirlas.
      existente.campo = 'ambos';
      const vistas = new Set(existente.variantes.map((v) => v.variantId));
      for (const v of lista) {
        if (!vistas.has(v.id)) existente.variantes.push(aVarianteRepetida(v));
      }
      return;
    }

    grupos.set(codigo, { codigo, campo, variantes: lista.map(aVarianteRepetida) });
  };

  for (const [codigo, lista] of porSku) anadir(codigo, lista, 'sku');
  for (const [codigo, lista] of porBarcode) anadir(codigo, lista, 'barcode');

  const resultado = [...grupos.values()];

  // Dentro de cada grupo, primero los más sospechosos: son los candidatos a
  // borrar y así se ven sin desplazarse.
  for (const g of resultado) g.variantes.sort((a, b) => b.sospecha - a.sospecha);

  // Y los grupos, por cuántas variantes sobran: los peores arriba.
  resultado.sort((a, b) => b.variantes.length - a.variantes.length);

  const variantesImplicadas = resultado.reduce((n, g) => n + g.variantes.length, 0);

  return {
    grupos: resultado,
    resumen: {
      codigosRepetidos: resultado.length,
      variantesImplicadas,
      // Por cada código sobra todo menos una.
      excedente: variantesImplicadas - resultado.length,
      sospechosas: resultado.reduce(
        (n, g) => n + g.variantes.filter((v) => v.sospecha === 2).length,
        0,
      ),
    },
  };
}
