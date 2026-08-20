/**
 * Candado del panel — dos formas de entrar.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * La app cambia precios, crea productos y emite comprobantes ante SUNAT. Sin
 * candado, cualquiera que diera con la URL de Render podía hacer todo eso.
 *
 * ── Las dos vías, y por qué las dos ──────────────────────────────────────────
 *
 * 1. **Token de sesión de Shopify.** Cuando la app se abre desde Aplicaciones
 *    en el admin, App Bridge manda en cada llamada un JWT firmado por Shopify.
 *    Es la vía buena: la identidad la gestiona Shopify, caduca sola y no hay
 *    contraseñas que rotar. Ver `session-token.ts`.
 *
 * 2. **Usuario y contraseña.** Para abrir el panel directamente por su URL, sin
 *    pasar por Shopify.
 *
 * La segunda no se quita al llegar la primera, y es a propósito: si algún día
 * la app deja de cargar dentro de Shopify —una configuración mal puesta, un
 * cambio de App Bridge—, sin ella no habría forma de entrar a arreglarlo. Un
 * candado que puede dejarte fuera de tu propia herramienta no es más seguro,
 * es más frágil.
 *
 * Límites de la vía 2, dichos claramente:
 *  - La contraseña viaja en cada petición. Sobre HTTPS va cifrada.
 *  - No hay usuarios ni permisos: quien entra, puede todo.
 *  - No caduca; se cierra cerrando el navegador.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';
import { verificarTokenSesion } from './session-token.js';

export interface OpcionesAuth {
  usuario?: string;
  clave?: string;
  /** Para verificar el token de sesión. Sin esto, sólo vale la contraseña. */
  shopify?: { clientId: string; clientSecret: string; tienda: string };
  /** Rutas que no piden nada. */
  exentas?: string[];
}

/**
 * ¿Es esta petición la carga de la app dentro del admin de Shopify?
 *
 * Shopify añade `host` y `shop` a la URL cuando abre una app embebida. Cuando
 * eso pasa, el HTML tiene que servirse **sin** pedir credenciales: es el
 * navegador quien lo pide, App Bridge todavía no se ha cargado y no hay ningún
 * token que mandar. Exigir cabecera ahí haría que la app no llegara a abrirse.
 *
 * Esto no abre ningún agujero: el HTML no contiene datos. Todo lo que enseña el
 * panel viene de `/api/*`, que sí exige token o contraseña. Lo único que decide
 * esta función es **cuál de las dos puertas** se le enseña a quien llama.
 *
 * Y hace falta que sea así en los dos sentidos: si el HTML se sirviera siempre
 * sin candado, al abrir el panel por su URL el navegador nunca recibiría un 401
 * de navegación y nunca mostraría el cuadro de usuario y contraseña; las
 * llamadas fallarían una tras otra sin explicación.
 */
function esCargaEmbebida(req: Request): boolean {
  return typeof req.query.host === 'string' && typeof req.query.shop === 'string';
}

/**
 * Compara dos cadenas sin filtrar información por el tiempo que tarda.
 *
 * Un `===` normal sale en cuanto encuentra el primer carácter distinto, y ese
 * tiempo se puede medir para adivinar la clave letra a letra. `timingSafeEqual`
 * siempre tarda lo mismo.
 *
 * Exige que los dos búferes midan igual, así que primero se compara la longitud
 * —que sí se filtra, y no importa— y sólo entonces el contenido.
 */
function igualSeguro(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Descompone la cabecera `Authorization: Basic ...`. */
export function leerCredenciales(cabecera: string | undefined): { usuario: string; clave: string } | null {
  if (!cabecera?.startsWith('Basic ')) return null;

  try {
    const descifrado = Buffer.from(cabecera.slice(6), 'base64').toString('utf8');
    // La contraseña puede llevar dos puntos; el usuario no. Por eso se parte
    // sólo en el primero.
    const corte = descifrado.indexOf(':');
    if (corte < 0) return null;

    return { usuario: descifrado.slice(0, corte), clave: descifrado.slice(corte + 1) };
  } catch {
    return null;
  }
}

/**
 * La cabecera que hace que el navegador pida usuario y contraseña.
 *
 * **Sólo ASCII.** Las cabeceras HTTP no admiten otra cosa, y Node no lo avisa:
 * lanza `ERR_INVALID_CHAR` al responder y la petición muere con un 500 que no
 * menciona la cabecera por ningún sitio.
 *
 * Aquí ya pasó una vez, con un guion largo en «Mundo Love Pet — Bsale». La
 * prueba de `auth.test.ts` que comprueba que esta constante es ASCII está para
 * que no vuelva a pasar.
 */
export const CABECERA_AUTENTICACION = 'Basic realm="Mundo Love Pet - Bsale", charset="UTF-8"';

/** El HTML del panel, no la API ni los datos. */
function esPaginaDelPanel(path: string): boolean {
  return path === '/' || path === '/index.html';
}

/**
 * Middleware que exige contraseña.
 *
 * `/api/health` queda exento a propósito: Render lo consulta para saber si el
 * servicio está vivo, y un 401 haría que lo diera por caído y lo reiniciara en
 * bucle.
 */
export function requiereClave(opciones: OpcionesAuth) {
  const exentas = new Set(opciones.exentas ?? ['/api/health']);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (exentas.has(req.path)) return next();

    // El HTML del panel, cuando lo pide Shopify para enmarcarlo.
    if (opciones.shopify && esCargaEmbebida(req) && esPaginaDelPanel(req.path)) return next();

    const cabecera = req.headers.authorization;

    // ── Vía 1: token de sesión de Shopify ───────────────────────────────────
    if (opciones.shopify && cabecera?.startsWith('Bearer ')) {
      const resultado = verificarTokenSesion(cabecera.slice(7), {
        clientId: opciones.shopify.clientId,
        clientSecret: opciones.shopify.clientSecret,
        tiendaEsperada: opciones.shopify.tienda,
      });

      if (resultado.valido) {
        // Queda a mano por si alguna ruta quiere saber quién hizo qué.
        (req as Request & { tienda?: string; usuarioShopify?: string }).tienda =
          resultado.tienda ?? undefined;
        (req as Request & { usuarioShopify?: string }).usuarioShopify = resultado.claims?.sub;
        return next();
      }

      logger.warn({ ip: req.ip, ruta: req.path, motivo: resultado.error }, 'Token de sesión rechazado');
      res.status(401).json({ error: { message: resultado.error } });
      return;
    }

    // ── Vía 2: usuario y contraseña ─────────────────────────────────────────
    if (opciones.usuario && opciones.clave) {
      const credenciales = leerCredenciales(cabecera);

      // Las dos comparaciones se hacen siempre, aunque la primera falle, para
      // no revelar por el tiempo de respuesta si el usuario existe.
      const usuarioOk = credenciales ? igualSeguro(credenciales.usuario, opciones.usuario) : false;
      const claveOk = credenciales ? igualSeguro(credenciales.clave, opciones.clave) : false;

      if (usuarioOk && claveOk) return next();

      if (credenciales) {
        // Se registra el intento fallido, nunca la clave probada.
        logger.warn(
          { ip: req.ip, ruta: req.path, usuario: credenciales.usuario },
          'Acceso rechazado',
        );
      }
    }

    res.status(401).set('WWW-Authenticate', CABECERA_AUTENTICACION).json({
      error: { message: 'Hace falta identificarse.' },
    });
  };
}
