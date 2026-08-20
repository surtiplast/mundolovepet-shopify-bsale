/**
 * Pruebas del candado del panel.
 *
 * Lo que importa aquí es que no haya ninguna forma de entrar sin la clave. Las
 * pruebas están escritas como intentos de colarse, no como comprobaciones de
 * que el camino feliz funciona.
 */
import { describe, expect, it, vi } from 'vitest';
import { requiereClave, leerCredenciales } from '../src/lib/auth.js';

const USUARIO = 'rolando';
const CLAVE = 'una-clave-larga-de-verdad';

function basic(usuario: string, clave: string): string {
  return 'Basic ' + Buffer.from(`${usuario}:${clave}`, 'utf8').toString('base64');
}

function contexto(authorization?: string, path = '/api/pedidos') {
  const req = { headers: { authorization }, path, ip: '1.2.3.4' };
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
