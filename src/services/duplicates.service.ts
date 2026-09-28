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
   * Cuántas variantes tiene el producto al que pertenece.
   *
   * Importa para borrar: Shopify borra productos, no variantes sueltas. Si el
   * producto tiene dos tallas y sólo una está repetida, borrarlo se llevaría la
   * otra por delante. `null` cuando no se ha podido leer, y entonces tampoco se
   * borra.
   */
  variantesDelProducto: number | null;
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
    variantesDelProducto: v.variantesDelProducto ?? null,
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
    // Antes se omitía indexar aquí cuando barcode===sku, pensando que evitaba
    // contar el mismo choque dos veces. No hacía falta: `anadir()` exige
    // lista.length>=2 en CADA mapa por separado, así que una variante sola
    // nunca se duplica consigo misma. Y omitirla tenía un costo real: si esa
    // misma variante (sku='REPE', barcode='REPE', el propio bug que este
    // archivo documenta) comparte barcode con OTRA variante de sku distinto,
    // quedaba fuera de `porBarcode` y esa colisión real no se detectaba.
    if (barcode) {
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

// ── Borrado de duplicados ────────────────────────────────────────────────────

export interface CandidatoBorrado {
  productId: string;
  variantId: string;
  titulo: string | null;
  sku: string | null;
  barcode: string | null;
  /** El código por el que choca con el que se queda. */
  codigo: string;
  /** El producto que sobrevive al grupo, para poder explicarlo en el informe. */
  sobrevive: { productId: string | null; titulo: string | null };
}

export interface PlanBorrado {
  candidatos: CandidatoBorrado[];
  /** Grupos que se dejan intactos, con el motivo. Es la parte importante. */
  intocables: Array<{ codigo: string; motivo: string; variantes: number }>;
  resumen: {
    gruposRevisados: number;
    aBorrar: number;
    gruposIntocables: number;
  };
}

export interface ResultadoBorrado {
  borrados: number;
  fallidos: number;
  errores: Array<{ productId: string; mensaje: string }>;
}

/**
 * Decide qué duplicados se pueden borrar sin arriesgar nada. **No escribe.**
 *
 * ── Las cuatro reglas, y por qué son tan estrechas ───────────────────────────
 *
 * Borrar un producto de una tienda no se deshace. No hay papelera, no hay
 * «ctrl+z», y si el borrado se equivoca la única salida es volver a crearlo a
 * mano con sus fotos, su descripción y su historial de ventas perdido. Por eso
 * aquí la pregunta no es «¿cuántos puedo borrar?» sino «¿de cuáles estoy
 * completamente seguro?».
 *
 * 1. **Sólo borrador.** Un producto publicado puede estar vendiéndose ahora
 *    mismo, tener enlaces desde fuera o estar en una colección. La app nunca
 *    publica nada, así que un duplicado suyo sigue en borrador.
 * 2. **Sólo sin imagen.** La app tampoco pone fotos. Una imagen significa que
 *    una persona pasó por ahí, y lo que tocó una persona no lo borra un botón.
 * 3. **Sólo productos de una única variante.** Shopify borra el producto
 *    entero. Si tiene dos tallas y sólo una está repetida, borrarlo se llevaría
 *    la buena.
 * 4. **Siempre sobrevive uno.** Si en un grupo todas las variantes cumplen lo
 *    anterior, se conserva la primera de todos modos. Un código repetido es un
 *    problema; un código que desaparece del catálogo es otro peor.
 *
 * Lo que no cumpla las cuatro se queda, y el informe dice por qué. Un duplicado
 * que sobrevive se puede borrar a mano en un minuto; uno borrado por error
 * cuesta una tarde.
 */
export function planificarBorradoDuplicados(
  informe: InformeDuplicados,
  limite?: number,
): PlanBorrado {
  const candidatos: CandidatoBorrado[] = [];
  const intocables: Array<{ codigo: string; motivo: string; variantes: number }> = [];

  for (const grupo of informe.grupos) {
    if (limite !== undefined && candidatos.length >= limite) break;

    const borrables = grupo.variantes.filter(
      (v) =>
        v.esBorrador &&
        v.sinImagen &&
        v.productId !== null &&
        v.variantesDelProducto === 1,
    );

    if (borrables.length === 0) {
      intocables.push({
        codigo: grupo.codigo,
        motivo:
          'Ninguna de las variantes es un borrador sin imagen con un solo producto. Revísalo a mano.',
        variantes: grupo.variantes.length,
      });
      continue;
    }

    // Regla 4. Si todas son borrables, la primera se queda igual.
    const sobrantes =
      borrables.length === grupo.variantes.length ? borrables.slice(1) : borrables;

    if (sobrantes.length === 0) {
      intocables.push({
        codigo: grupo.codigo,
        motivo: 'Sólo queda una variante con ese código. No sobra nada.',
        variantes: grupo.variantes.length,
      });
      continue;
    }

    // El que se queda: el primero que NO está en la lista de sobrantes.
    const aBorrar = new Set(sobrantes.map((v) => v.variantId));
    const superviviente = grupo.variantes.find((v) => !aBorrar.has(v.variantId)) ?? null;

    for (const v of sobrantes) {
      if (limite !== undefined && candidatos.length >= limite) break;
      candidatos.push({
        productId: v.productId as string,
        variantId: v.variantId,
        titulo: v.titulo,
        sku: v.sku,
        barcode: v.barcode,
        codigo: grupo.codigo,
        sobrevive: {
          productId: superviviente?.productId ?? null,
          titulo: superviviente?.titulo ?? null,
        },
      });
    }
  }

  return {
    candidatos,
    intocables,
    resumen: {
      gruposRevisados: informe.grupos.length,
      aBorrar: candidatos.length,
      gruposIntocables: intocables.length,
    },
  };
}

/**
 * Borra de verdad. **Esto sí escribe en la tienda, y no se deshace.**
 *
 * Uno a uno y en serie, igual que el alta: un fallo suelto no debe arrastrar al
 * resto, y en paralelo se dispararía el control de caudal de Shopify.
 */
export async function borrarDuplicados(
  eliminarProducto: (productId: string) => Promise<{ ok: boolean; errores: string[] }>,
  plan: PlanBorrado,
): Promise<ResultadoBorrado> {
  const resultado: ResultadoBorrado = { borrados: 0, fallidos: 0, errores: [] };

  // Un mismo producto podría aparecer en dos grupos —choca por SKU y por código
  // de barras con productos distintos—. Borrarlo dos veces daría un error
  // gratuito en el informe.
  const yaBorrados = new Set<string>();

  for (const c of plan.candidatos) {
    if (yaBorrados.has(c.productId)) continue;
    yaBorrados.add(c.productId);

    try {
      const r = await eliminarProducto(c.productId);
      if (r.ok) resultado.borrados++;
      else {
        resultado.fallidos++;
        resultado.errores.push({ productId: c.productId, mensaje: r.errores.join(' | ') });
      }
    } catch (error) {
      resultado.fallidos++;
      resultado.errores.push({ productId: c.productId, mensaje: (error as Error).message });
    }
  }

  return resultado;
}
