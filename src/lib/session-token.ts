/**
 * Verificación del token de sesión de Shopify.
 *
 * ── Qué es ───────────────────────────────────────────────────────────────────
 *
 * Cuando la app se abre dentro del admin de Shopify, App Bridge entrega en cada
 * llamada un JWT firmado por Shopify con **tu Client Secret**. Ese token
 * demuestra dos cosas: que la petición viene de dentro del admin, y de qué
 * tienda y qué usuario.
 *
 * Es autenticación de verdad, y mejor que una contraseña compartida: la
 * identidad la gestiona Shopify, caduca sola y no hay nada que rotar cuando
 * alguien deja de trabajar en la tienda.
 *
 * ── Por qué está escrito a mano y no con una librería ────────────────────────
 *
 * Verificar un JWT HS256 son treinta líneas de `node:crypto`. La alternativa
 * (`jsonwebtoken`) traería un árbol de dependencias entero para eso, y en una
 * app que emite comprobantes ante SUNAT cada dependencia nueva es superficie de
 * ataque. Aquí se puede leer entero y comprobar que hace lo que dice.
 *
 * Se acepta SÓLO HS256, explícitamente. Aceptar el algoritmo que venga en la
 * cabecera es el fallo clásico de las implementaciones de JWT: permite el
 * ataque `alg: none`, en el que un token sin firma se da por bueno.
 *
 * ── Duración ─────────────────────────────────────────────────────────────────
 *
 * Un minuto. App Bridge lo vuelve a pedir en cada llamada, así que no hay que
 * refrescarlo; sí hay que tolerar un poco de desfase de reloj entre el servidor
 * de Shopify y el nuestro.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Lo que Shopify mete en el token. */
export interface ClaimsSesion {
  /** El admin de la tienda: `https://x.myshopify.com/admin`. */
  iss: string;
  /** La tienda: `https://x.myshopify.com`. */
  dest: string;
  /** El Client ID de la app que debe recibirlo. */
  aud: string;
  /** El usuario de Shopify. */
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid: string;
}

export interface ResultadoVerificacion {
  valido: boolean;
  claims: ClaimsSesion | null;
  /** El dominio de la tienda, ya sin `https://`. */
  tienda: string | null;
  error: string | null;
}

/**
 * Margen para el desfase de relojes, en segundos.
 *
 * Con un token que dura 60 segundos, un servidor adelantado unos segundos
 * rechazaría tokens recién emitidos por `nbf`. Cinco segundos absorben eso sin
 * alargar de forma apreciable la vida del token.
 */
const MARGEN_RELOJ = 5;

function base64urlADecodificado(parte: string): Buffer {
  // base64url usa `-` y `_` donde base64 usa `+` y `/`, y omite el relleno.
  const base64 = parte.replace(/-/g, '+').replace(/_/g, '/');
  const relleno = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  return Buffer.from(base64 + relleno, 'base64');
}

/** Quita el `https://` y la barra final, para poder comparar dominios. */
export function dominioDe(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

/**
 * Verifica el token. Devuelve el motivo exacto cuando falla, para poder
 * diagnosticar sin adivinar.
 *
 * `ahora` es inyectable para poder probar la caducidad sin esperar un minuto.
 */
export function verificarTokenSesion(
  token: string | undefined,
  opciones: { clientId: string; clientSecret: string; tiendaEsperada?: string; ahora?: number },
): ResultadoVerificacion {
  const fallo = (error: string): ResultadoVerificacion => ({
    valido: false,
    claims: null,
    tienda: null,
    error,
  });

  if (!token) return fallo('No llegó ningún token de sesión.');

  const partes = token.split('.');
  if (partes.length !== 3) return fallo('El token no tiene el formato de un JWT.');

  const [cabeceraB64, cargaB64, firmaB64] = partes as [string, string, string];

  // ── Cabecera ──────────────────────────────────────────────────────────────
  let cabecera: { alg?: string; typ?: string };
  try {
    cabecera = JSON.parse(base64urlADecodificado(cabeceraB64).toString('utf8'));
  } catch {
    return fallo('La cabecera del token no es JSON válido.');
  }

  // Se exige HS256 en vez de fiarse de lo que diga el token. Aceptar el
  // algoritmo declarado permitiría `alg: none`, es decir, un token sin firma.
  if (cabecera.alg !== 'HS256') {
    return fallo(`Algoritmo no admitido: ${cabecera.alg ?? 'ninguno'}. Sólo se acepta HS256.`);
  }

  // ── Firma ─────────────────────────────────────────────────────────────────
  const esperada = createHmac('sha256', opciones.clientSecret)
    .update(`${cabeceraB64}.${cargaB64}`)
    .digest();
  const recibida = base64urlADecodificado(firmaB64);

  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) {
    return fallo(
      'La firma no cuadra. Suele significar que SHOPIFY_CLIENT_SECRET no es el de esta app.',
    );
  }

  // ── Contenido ─────────────────────────────────────────────────────────────
  let claims: ClaimsSesion;
  try {
    claims = JSON.parse(base64urlADecodificado(cargaB64).toString('utf8'));
  } catch {
    return fallo('El contenido del token no es JSON válido.');
  }

  const ahora = opciones.ahora ?? Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== 'number' || claims.exp + MARGEN_RELOJ < ahora) {
    return fallo('El token ha caducado. Recarga la app dentro de Shopify.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - MARGEN_RELOJ > ahora) {
    return fallo('El token todavía no es válido; puede haber desfase de reloj.');
  }

  // `aud` tiene que ser NUESTRO Client ID. Sin esta comprobación, un token
  // emitido para otra app de la misma tienda serviría para entrar en esta.
  if (claims.aud !== opciones.clientId) {
    return fallo('El token es para otra app.');
  }

  const tienda = dominioDe(claims.dest ?? '');
  if (!tienda) return fallo('El token no dice de qué tienda viene.');

  // Y tiene que ser NUESTRA tienda. Sin esto, cualquiera que instalase la app
  // en su propia tienda podría operar sobre esta.
  if (opciones.tiendaEsperada && tienda !== dominioDe(opciones.tiendaEsperada)) {
    return fallo(`El token viene de ${tienda}, que no es la tienda de esta app.`);
  }

  return { valido: true, claims, tienda, error: null };
}
