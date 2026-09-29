/**
 * Pruebas del candado del panel.
 *
 * Lo que importa aquí es que no haya ninguna forma de entrar sin la clave. Las
 * pruebas están escritas como intentos de colarse, no como comprobaciones de
 * que el camino feliz funciona.
 */
import { describe, expect, it, vi } from 'vitest';
import { requiereClave, leerCredenciales, CABECERA_AUTENTICACION, RUTAS_DEL_PANEL } from '../src/lib/auth.js';

const USUARIO = 'rolando';
const CLAVE = 'una-clave-larga-de-verdad';

function basic(usuario: string, clave: string): string {
  return 'Basic ' + Buffer.from(`${usuario}:${clave}`, 'utf8').toString('base64');
}

function contexto(
  authorization?: string,
  path = '/api/pedidos',
  query: Record<string, string> = {},
) {
  const req = { headers: { authorization }, path, query, ip: '1.2.3.4' };
  const res = {
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

const middleware = requiereClave({ usuario: USUARIO, clave: CLAVE });

describe('leerCredenciales', () => {
  it('descompone la cabecera', () => {
    expect(leerCredenciales(basic('ana', 'secreto'))).toEqual({ usuario: 'ana', clave: 'secreto' });
  });

  it('una contraseña con dos puntos dentro se lee entera', () => {
    // Se parte sólo en el primer «:». Partir en todos truncaría la clave.
    expect(leerCredenciales(basic('ana', 'a:b:c'))).toEqual({ usuario: 'ana', clave: 'a:b:c' });
  });

  it('devuelve null con cabeceras que no valen', () => {
    expect(leerCredenciales(undefined)).toBeNull();
    expect(leerCredenciales('Bearer xyz')).toBeNull();
    expect(leerCredenciales('Basic no-es-base64-válido!!')).toBeNull();
    expect(leerCredenciales('Basic ' + Buffer.from('sin-dos-puntos').toString('base64'))).toBeNull();
  });
});

describe('requiereClave', () => {
  it('deja pasar con la clave correcta', () => {
    const { req, res, next } = contexto(basic(USUARIO, CLAVE));
    middleware(req as never, res as never, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  describe('lo que NO deja pasar', () => {
    const intentos: Array<[string, string | undefined]> = [
      ['sin cabecera ninguna', undefined],
      ['con la cabecera vacía', ''],
      ['con un token Bearer', 'Bearer loquesea'],
      ['con la clave equivocada', basic(USUARIO, 'otra-cosa')],
      ['con el usuario equivocado', basic('otro', CLAVE)],
      ['con la clave vacía', basic(USUARIO, '')],
      ['con los dos vacíos', basic('', '')],
      ['con la clave en otro orden', basic(CLAVE, USUARIO)],
      ['con la clave truncada', basic(USUARIO, CLAVE.slice(0, -1))],
      ['con un carácter de más', basic(USUARIO, CLAVE + 'x')],
      ['con la clave en mayúsculas', basic(USUARIO, CLAVE.toUpperCase())],
    ];

    for (const [descripcion, cabecera] of intentos) {
      it(descripcion, () => {
        const { req, res, next } = contexto(cabecera);
        middleware(req as never, res as never, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
      });
    }
  });

  /**
   * Esto llegó a producción y tumbó el servicio entero: la cabecera llevaba un
   * guion largo («—»), y las cabeceras HTTP sólo admiten ASCII. Node no avisa
   * al escribirla: lanza ERR_INVALID_CHAR al responder, y la petición muere con
   * un 500 que no menciona la cabecera por ningún lado.
   *
   * Las pruebas no lo cogieron porque el `res.set` simulado acepta cualquier
   * cosa. Ésta comprueba la constante directamente.
   */
  it('la cabecera WWW-Authenticate es ASCII puro, o Node tumba la respuesta', () => {
    for (const caracter of CABECERA_AUTENTICACION) {
      expect(caracter.codePointAt(0)).toBeLessThan(128);
    }
  });

  it('pide credenciales al navegador con WWW-Authenticate', () => {
    const { req, res, next } = contexto();
    middleware(req as never, res as never, next);

    expect(res.set).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining('Basic realm='),
    );
  });

  /**
   * Render consulta `/api/health` para saber si el servicio vive. Un 401 lo
   * daría por caído y lo reiniciaría en bucle.
   */
  it('deja pasar /api/health sin clave, o Render reiniciaría el servicio', () => {
    const { req, res, next } = contexto(undefined, '/api/health');
    middleware(req as never, res as never, next);

    expect(next).toHaveBeenCalled();
  });

  it('el panel también está protegido, no sólo la API', () => {
    const { req, res, next } = contexto(undefined, '/index.html');
    middleware(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('la raíz también', () => {
    const { req, res, next } = contexto(undefined, '/');
    middleware(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
  });

  it('nunca devuelve la clave en la respuesta', () => {
    const { req, res, next } = contexto(basic(USUARIO, 'intento-fallido'));
    middleware(req as never, res as never, next);

    const cuerpo = JSON.stringify(res.json.mock.calls);
    expect(cuerpo).not.toContain(CLAVE);
    expect(cuerpo).not.toContain('intento-fallido');
  });
});

/**
 * Esto llegó a producción: se agregó la pestaña «Cambios» al panel y al menú
 * de Shopify, pero `RUTAS_DEL_PANEL` vivía duplicada —una copia en este
 * archivo, otra en `server.ts`— y sólo se actualizó una. La copia que
 * `esPaginaDelPanel` usa se quedó sin «/cambios», así que Shopify cargaba esa
 * página como si no fuera del panel: sin `Authorization`, sin bypass, y el
 * navegador acababa pidiendo usuario y contraseña dentro del propio admin de
 * Shopify.
 *
 * Ahora sólo hay una lista (exportada desde aquí, que `server.ts` importa),
 * así que ya no hay una segunda copia que alguien pueda olvidar actualizar.
 * Estas pruebas cubren que el bypass funcione para cada ruta de esa lista —
 * literalmente, no iterando el array, para que si el día de mañana alguien
 * quita «/cambios» de la lista sin querer, esta prueba lo note igual.
 */
describe('requiereClave — carga embebida dentro de Shopify', () => {
  const middlewareEmbebido = requiereClave({
    usuario: USUARIO,
    clave: CLAVE,
    shopify: { clientId: 'client-id', clientSecret: 'client-secret', tienda: 'mundo-love-pet.myshopify.com' },
  });
  const HOST_SHOP = { host: 'YWRtaW4uc2hvcGlmeS5jb20=', shop: 'mundo-love-pet.myshopify.com' };

  it('cada ruta declarada en RUTAS_DEL_PANEL pasa sin credenciales cuando Shopify manda host y shop', () => {
    for (const ruta of RUTAS_DEL_PANEL) {
      const { req, res, next } = contexto(undefined, ruta, HOST_SHOP);
      middlewareEmbebido(req as never, res as never, next);
      expect(next, `esperaba pasar en ${ruta}`).toHaveBeenCalled();
      expect(res.status, `no debía rechazar ${ruta}`).not.toHaveBeenCalled();
    }
  });

  it('/cambios pasa sin credenciales: la regresión concreta que llegó a producción', () => {
    const { req, res, next } = contexto(undefined, '/cambios', HOST_SHOP);
    middlewareEmbebido(req as never, res as never, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sin host o sin shop, ni siquiera una ruta del panel pasa gratis', () => {
    const { req: soloHost, res: resHost, next: nextHost } = contexto(undefined, '/cambios', { host: HOST_SHOP.host });
    middlewareEmbebido(soloHost as never, resHost as never, nextHost);
    expect(nextHost).not.toHaveBeenCalled();
    expect(resHost.status).toHaveBeenCalledWith(401);

    const { req: soloShop, res: resShop, next: nextShop } = contexto(undefined, '/cambios', { shop: HOST_SHOP.shop });
    middlewareEmbebido(soloShop as never, resShop as never, nextShop);
    expect(nextShop).not.toHaveBeenCalled();
    expect(resShop.status).toHaveBeenCalledWith(401);
  });

  it('host y shop NO abren un boquete en la API: sólo bypasan páginas del panel', () => {
    const { req, res, next } = contexto(undefined, '/api/pedidos', HOST_SHOP);
    middlewareEmbebido(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
