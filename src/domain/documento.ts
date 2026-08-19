/**
 * Identificación tributaria del comprador: DNI, RUC, o nada.
 *
 * ── Por qué esto es un módulo aparte y sin I/O ───────────────────────────────
 *
 * De aquí sale la decisión de emitir una BOLETA o una FACTURA. Es la decisión
 * menos reversible del proyecto: un comprobante mal emitido no se corrige con
 * un despliegue, hay que anularlo ante SUNAT con otro documento. Por eso vive
 * en funciones puras —sin red, sin base de datos— que se pueden probar
 * exhaustivamente y leer de una sentada.
 *
 * ── De dónde sale el número ──────────────────────────────────────────────────
 *
 * En Mundo Love Pet el DNI/RUC se captura en el campo **Empresa** («company»)
 * del checkout de Shopify. Es un campo nativo de la dirección, disponible en
 * todos los planes; los campos propios del checkout exigirían Shopify Plus.
 *
 * El precio de esa solución es que el cliente escribe lo que quiere: llegan
 * cosas como «RUC 20123456789», «20123456789 - Mi Empresa SAC» o el nombre de
 * una empresa sin número. Este módulo se encarga de eso.
 */

/** Qué clase de identificación trae el pedido. */
export type TipoIdentificacion = 'DNI' | 'RUC' | 'NINGUNA';

/** Qué comprobante corresponde emitir. */
export type TipoComprobante = 'BOLETA' | 'FACTURA';

export interface Identificacion {
  tipo: TipoIdentificacion;
  /** Sólo dígitos. Cadena vacía si no hay identificación. */
  numero: string;
  /** Lo que quedó del campo tras quitar el número: suele ser la razón social. */
  razonSocial: string | null;
  /** El texto original, sin tocar. Para poder mostrarlo al revisar. */
  original: string | null;
}

export interface DecisionComprobante {
  comprobante: TipoComprobante | null;
  identificacion: Identificacion;
  /** `true` cuando NO se debe emitir nada y un humano tiene que mirarlo. */
  requiereRevision: boolean;
  /** Explicación en castellano llano, para enseñarla en el panel. */
  motivo: string;
}

/**
 * Dígito verificador del RUC peruano — módulo 11.
 *
 * Se multiplican los diez primeros dígitos por los factores fijos
 * `5 4 3 2 7 6 5 4 3 2`, se suman, y el verificador es `11 − (suma mod 11)`,
 * con dos casos especiales: 10 se convierte en 0 y 11 en 1.
 *
 * Comprobado con el RUC de la propia SUNAT, `20131312955`: la suma da 94,
 * 94 mod 11 = 6, y 11 − 6 = 5, que es su último dígito.
 *
 * Validar esto aquí evita mandar a Bsale un RUC que SUNAT va a rechazar
 * después, cuando el documento ya está emitido y corregirlo cuesta una nota de
 * crédito.
 */
export function digitoVerificadorRuc(primerosDiez: string): number | null {
  if (!/^\d{10}$/.test(primerosDiez)) return null;

  const factores = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) {
    suma += Number(primerosDiez[i]) * factores[i]!;
  }

  const resto = suma % 11;
  const verificador = 11 - resto;
  if (verificador === 10) return 0;
  if (verificador === 11) return 1;
  return verificador;
}

/**
 * ¿Es un RUC válido?
 *
 * Comprueba tres cosas: que tenga 11 dígitos, que empiece por un prefijo que
 * SUNAT usa, y que el dígito verificador cuadre.
 *
 * Los prefijos válidos son 10 y 15 (persona natural), 17 (sucesión indivisa) y
 * 20 (persona jurídica). Un número de 11 dígitos que empiece por otra cosa no
 * es un RUC aunque el verificador cuadre por casualidad.
 */
export function esRucValido(valor: string): boolean {
  if (!/^\d{11}$/.test(valor)) return false;

  const prefijo = valor.slice(0, 2);
  if (!['10', '15', '17', '20'].includes(prefijo)) return false;

  const esperado = digitoVerificadorRuc(valor.slice(0, 10));
  return esperado !== null && esperado === Number(valor[10]);
}

/**
 * ¿Es un DNI válido?
 *
 * Ocho dígitos. El DNI peruano tiene un dígito de verificación, pero **no forma
 * parte** de los ocho: va aparte en el carné y casi nadie lo escribe. Exigirlo
 * rechazaría DNIs correctos, así que sólo se comprueba el formato.
 *
 * `00000000` se descarta: es lo que sale cuando alguien rellena el campo por
 * salir del paso.
 */
export function esDniValido(valor: string): boolean {
  return /^\d{8}$/.test(valor) && valor !== '00000000';
}

/**
 * Saca la identificación del campo «Empresa» del checkout.
 *
 * El cliente escribe texto libre, así que hay que buscar el número dentro de lo
 * que sea. Se prefiere un RUC de 11 dígitos sobre un DNI de 8: si alguien
 * escribe los dos, quiere factura.
 *
 * Los separadores habituales —puntos, guiones, espacios— se quitan antes de
 * buscar, porque «20-131312955» es un RUC perfectamente válido mal escrito.
 */
export function extraerIdentificacion(company: string | null | undefined): Identificacion {
  const original = company?.trim() || null;
  const vacia: Identificacion = { tipo: 'NINGUNA', numero: '', razonSocial: null, original };

  if (!original) return vacia;

  // Se buscan candidatos sobre el texto con los separadores internos quitados,
  // pero sólo entre dígitos: así «20-131312955» se une y «SAC 2024» no se pega
  // al número de al lado.
  const unido = original.replace(/(\d)[\s.\-]+(?=\d)/g, '$1');

  const eleven = unido.match(/\d{11}/g) ?? [];
  const ruc = eleven.find((c) => esRucValido(c));
  if (ruc) {
    return { tipo: 'RUC', numero: ruc, razonSocial: restoDelTexto(original, ruc), original };
  }

  // Un número de 11 dígitos que no valida se devuelve igualmente como RUC: es
  // casi seguro un RUC mal escrito, y hay que avisar en vez de tratarlo como
  // «sin identificación» y emitir una boleta a nombre de nadie.
  if (eleven.length > 0) {
    return {
      tipo: 'RUC',
      numero: eleven[0]!,
      razonSocial: restoDelTexto(original, eleven[0]!),
      original,
    };
  }

  // `\d{8}` con fronteras: un trozo de 8 dígitos dentro de un número más largo
  // no es un DNI.
  const ocho = unido.match(/(?<!\d)\d{8}(?!\d)/g) ?? [];
  const dni = ocho.find((c) => esDniValido(c));
  if (dni) {
    return { tipo: 'DNI', numero: dni, razonSocial: restoDelTexto(original, dni), original };
  }

  // Hay texto pero ningún número: el cliente escribió el nombre de su empresa
  // sin el RUC. No sirve para facturar, pero se conserva para poder pedírselo.
  return { ...vacia, razonSocial: original };
}

/** Lo que queda del campo al quitar el número y la basura de alrededor. */
function restoDelTexto(original: string, numero: string): string | null {
  const sinNumero = original
    // El número puede aparecer con separadores; se construye un patrón laxo.
    .replace(new RegExp(numero.split('').join('[\\s.\\-]*'), 'g'), ' ')
    .replace(/\b(ruc|dni|n[°º.]?|nro\.?)\b/gi, ' ')
    .replace(/[\s,;:.\-|]+/g, ' ')
    .trim();

  return sinNumero || null;
}

/**
 * Decide qué comprobante emitir. **Es la función más delicada del proyecto.**
 *
 * Las cuatro salidas posibles:
 *
 *   RUC válido            → FACTURA
 *   DNI válido            → BOLETA
 *   sin identificación    → BOLETA a consumidor final
 *   RUC presente e inválido → NO se emite nada; revisión humana
 *
 * El último caso es el importante. Un RUC mal escrito **no** se degrada a
 * boleta: el cliente pidió factura, y una boleta no le sirve para deducir el
 * gasto. Emitirla y luego anularla es peor que esperar a preguntarle el número
 * correcto.
 */
export function decidirComprobante(company: string | null | undefined): DecisionComprobante {
  const identificacion = extraerIdentificacion(company);

  if (identificacion.tipo === 'RUC') {
    if (esRucValido(identificacion.numero)) {
      return {
        comprobante: 'FACTURA',
        identificacion,
        requiereRevision: false,
        motivo: `RUC ${identificacion.numero} válido.`,
      };
    }
    return {
      comprobante: null,
      identificacion,
      requiereRevision: true,
      motivo:
        `El RUC ${identificacion.numero} no es válido (no cuadra el dígito verificador). ` +
        'No se emite nada: el cliente pidió factura y una boleta no le serviría. ' +
        'Confirma el número con él.',
    };
  }

  if (identificacion.tipo === 'DNI') {
    return {
      comprobante: 'BOLETA',
      identificacion,
      requiereRevision: false,
      motivo: `DNI ${identificacion.numero}.`,
    };
  }

  if (identificacion.razonSocial) {
    return {
      comprobante: null,
      identificacion,
      requiereRevision: true,
      motivo:
        `El cliente escribió «${identificacion.razonSocial}» pero sin número. ` +
        'Si quiere factura hace falta el RUC; si no, se le puede emitir boleta a mano.',
    };
  }

  return {
    comprobante: 'BOLETA',
    identificacion,
    requiereRevision: false,
    motivo: 'Sin identificación: boleta a consumidor final.',
  };
}
