/**
 * Pruebas de la verificación del token de sesión.
 *
 * Un fallo aquí abre la app entera: quien consiga que un token falso pase por
 * bueno puede cambiar precios y emitir comprobantes ante SUNAT. Por eso la
 * mayoría de estas pruebas son intentos de falsificación, no comprobaciones del
 * camino feliz.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verificarTokenSesion, dominioDe } from '../src/lib/session-token.js';

const CLIENT_ID = 'c3de50d1466dc40754ea28f814d19b46';
const CLIENT_SECRET = 'shpss-secreto-de-pruebas-no-real';
const TIENDA = 'mundo-love-pet.myshopify.com';
const AHORA = 1_755_700_000;

function b64url(objeto: unknown): string {
  return Buffer.from(JSON.stringify(objeto), 'utf8').toString('base64url');
}

/** Fabrica un token como el que emitiría Shopify. */
function token(
  cambios: Record<string, unknown> = {},
  opciones: { secreto?: string; cabecera?: Record<string, unknown>; firma?: string } = {},
): string {
  const cabecera = b64url(opciones.cabecera ?? { alg: 'HS256', typ: 'JWT' });
  const carga = b64url({
    iss: `https://${TIENDA}/admin`,
    dest: `https://${TIENDA}`,
    aud: CLIENT_ID,
    sub: '42',
    exp: AHORA + 60,
    nbf: AHORA - 1,
    iat: AHORA,
    jti: 'f8912129-1af6-4cad-9ca3-76b0f7621087',
    sid: 'sesion-abc',
    ...cambios,
  });

  const firma =
    opciones.firma ??
    createHmac('sha256', opciones.secreto ?? CLIENT_SECRET)
      .update(`${cabecera}.${carga}`)
      .digest('base64url');

  return `${cabecera}.${carga}.${firma}`;
}

const opciones = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  tiendaEsperada: TIENDA,
  ahora: AHORA,
};

describe('dominioDe', () => {
  it('quita el esquema y lo que venga detrás', () => {
    expect(dominioDe(`https://${TIENDA}`)).toBe(TIENDA);
    expect(dominioDe(`https://${TIENDA}/admin`)).toBe(TIENDA);
    expect(dominioDe(TIENDA)).toBe(TIENDA);
  });

  it('no distingue mayúsculas', () => {
    expect(dominioDe('https://MUNDO-LOVE-PET.myshopify.com')).toBe(TIENDA);
  });
});

describe('verificarTokenSesion', () => {
  it('acepta un token bien formado', () => {
    const r = verificarTokenSesion(token(), opciones);

    expect(r.valido).toBe(true);
    expect(r.tienda).toBe(TIENDA);
    expect(r.claims?.sub).toBe('42');
    expect(r.error).toBeNull();
  });

  describe('firma', () => {
    it('rechaza un token firmado con otro secreto', () => {
      const r = verificarTokenSesion(token({}, { secreto: 'otro-secreto' }), opciones);

      expect(r.valido).toBe(false);
      expect(r.error).toMatch(/firma/i);
    });

    it('rechaza un token sin firma', () => {
      const r = verificarTokenSesion(token({}, { firma: '' }), opciones);
      expect(r.valido).toBe(false);
    });

    it('rechaza si se manipula el contenido dejando la firma vieja', () => {
      // El ataque evidente: coger un token válido y cambiarle la tienda.
      const original = token();
      const [cab, , firma] = original.split('.');
      const cargaFalsa = b64url({
        iss: 'https://tienda-del-atacante.myshopify.com/admin',
        dest: 'https://tienda-del-atacante.myshopify.com',
        aud: CLIENT_ID,
        sub: '1',
        exp: AHORA + 60,
        nbf: AHORA - 1,
      });

      const r = verificarTokenSesion(`${cab}.${cargaFalsa}.${firma}`, opciones);
      expect(r.valido).toBe(false);
      expect(r.error).toMatch(/firma/i);
    });
  });

  /**
   * El fallo clásico de las implementaciones de JWT: fiarse del `alg` que trae
   * el propio token. Quien lo hace acepta `alg: none`, es decir, tokens sin
   * firma que cualquiera puede fabricar.
   */
  describe('algoritmo', () => {
    it('rechaza alg: none', () => {
      const r = verificarTokenSesion(
        token({}, { cabecera: { alg: 'none', typ: 'JWT' }, firma: '' }),
        opciones,
      );

      expect(r.valido).toBe(false);
      expect(r.error).toMatch(/algoritmo/i);
    });

    it('rechaza alg: NONE, escrito de otra forma', () => {
      const r = verificarTokenSesion(
        token({}, { cabecera: { alg: 'NONE', typ: 'JWT' }, firma: '' }),
        opciones,
      );
      expect(r.valido).toBe(false);
    });

    it('rechaza RS256, aunque la firma cuadrara', () => {
      const r = verificarTokenSesion(token({}, { cabecera: { alg: 'RS256' } }), opciones);
      expect(r.valido).toBe(false);
    });

    it('rechaza una cabecera sin alg', () => {
      const r = verificarTokenSesion(token({}, { cabecera: { typ: 'JWT' } }), opciones);
      expect(r.valido).toBe(false);
    });
  });

  describe('caducidad', () => {
    it('rechaza un token caducado', () => {
      const r = verificarTokenSesion(token({ exp: AHORA - 120 }), opciones);

      expect(r.valido).toBe(false);
      expect(r.error).toMatch(/caducado/i);
    });

    it('tolera unos segundos de desfase de reloj', () => {
      // Caducó hace 3 segundos: dentro del margen.
      expect(verificarTokenSesion(token({ exp: AHORA - 3 }), opciones).valido).toBe(true);
    });

    it('rechaza un token que aún no es válido', () => {
      const r = verificarTokenSesion(token({ nbf: AHORA + 120 }), opciones);
      expect(r.valido).toBe(false);
    });

    it('rechaza un token sin exp', () => {
      const r = verificarTokenSesion(token({ exp: undefined }), opciones);
      expect(r.valido).toBe(false);
    });
  });

  describe('destinatario y tienda', () => {
    it('rechaza un token emitido para otra app', () => {
      const r = verificarTokenSesion(token({ aud: 'otra-app-de-la-misma-tienda' }), opciones);

      expect(r.valido).toBe(false);
      expect(r.error).toMatch(/otra app/i);
    });

    /**
     * Sin esta comprobación, cualquiera que instalase la app en su propia
     * tienda tendría un token válido y podría operar sobre ésta.
     */
    it('rechaza un token de otra tienda', () => {
      const r = verificarTokenSesion(
        token({ dest: 'https://tienda-ajena.myshopify.com' }),
        opciones,
      );

      expect(r.valido).toBe(false);
      expect(r.error).toMatch(/no es la tienda/i);
    });

    it('rechaza un token sin dest', () => {
      const r = verificarTokenSesion(token({ dest: '' }), opciones);
      expect(r.valido).toBe(false);
    });
  });

  describe('formato', () => {
    const basura = [
      ['sin token', undefined],
      ['cadena vacía', ''],
      ['sin puntos', 'noesunjwt'],
      ['con dos partes', 'a.b'],
      ['con cuatro partes', 'a.b.c.d'],
      ['cabecera que no es JSON', 'basura.basura.basura'],
    ] as const;

    for (const [descripcion, valor] of basura) {
      it(`rechaza ${descripcion}`, () => {
        expect(verificarTokenSesion(valor, opciones).valido).toBe(false);
      });
    }

    it('nunca lanza, por muy raro que sea lo que llegue', () => {
      for (const [, valor] of basura) {
        expect(() => verificarTokenSesion(valor, opciones)).not.toThrow();
      }
    });
  });

  it('el error explica el motivo, para poder diagnosticar sin adivinar', () => {
    const casos = [
      token({}, { secreto: 'malo' }),
      token({ exp: AHORA - 120 }),
      token({ aud: 'otra' }),
      token({ dest: 'https://otra.myshopify.com' }),
    ];

    for (const t of casos) {
      const r = verificarTokenSesion(t, opciones);
      expect(r.valido).toBe(false);
      expect(r.error!.length).toBeGreaterThan(10);
    }
  });
});
