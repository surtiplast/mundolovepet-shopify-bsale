import { describe, expect, it } from 'vitest';
import { maskToken, redact, scrubMessage, tokenLast4 } from '../src/lib/mask.js';

describe('maskToken', () => {
  it('muestra sólo los últimos 4 caracteres', () => {
    expect(maskToken('shpat_0123456789abcdefWXYZ')).toBe('••••WXYZ');
  });

  it('oculta por completo los tokens muy cortos', () => {
    expect(maskToken('abc123')).toBe('••••');
  });

  it('maneja null y undefined', () => {
    expect(maskToken(null)).toBe('—');
    expect(maskToken(undefined)).toBe('—');
  });

  it('nunca devuelve el token completo', () => {
    const token = 'shpat_muylargoysecretoabcdef123456';
    expect(maskToken(token)).not.toContain('shpat');
    expect(maskToken(token).length).toBeLessThan(token.length);
  });
});

describe('tokenLast4', () => {
  it('extrae los últimos 4 caracteres', () => {
    expect(tokenLast4('abcdefghij')).toBe('ghij');
  });

  it('devuelve cadena vacía para tokens cortos', () => {
    expect(tokenLast4('abc')).toBe('');
  });
});

describe('redact', () => {
  it('redacta claves sensibles en el primer nivel', () => {
    const r = redact({ access_token: 'secreto', nombre: 'Rolando' }) as Record<string, unknown>;
    expect(r['access_token']).toBe('[REDACTADO]');
    expect(r['nombre']).toBe('Rolando');
  });

  it('redacta sin importar mayúsculas o minúsculas', () => {
    const r = redact({ AccessToken: 'x', PASSWORD: 'y', Secret: 'z' }) as Record<string, unknown>;
    expect(Object.values(r).every((v) => v === '[REDACTADO]')).toBe(true);
  });

  it('redacta en estructuras anidadas', () => {
    const r = redact({
      req: { headers: { authorization: 'Bearer abc' } },
      lista: [{ token: 'tok' }],
    }) as any;
    expect(r.req.headers.authorization).toBe('[REDACTADO]');
    expect(r.lista[0].token).toBe('[REDACTADO]');
  });

  it('conserva valores no sensibles', () => {
    const r = redact({ sku: 'MLP-001', cantidad: 12, activo: true }) as any;
    expect(r).toEqual({ sku: 'MLP-001', cantidad: 12, activo: true });
  });

  it('corta a una profundidad máxima en lugar de desbordar la pila', () => {
    let deep: any = 'fondo';
    for (let i = 0; i < 30; i++) deep = { nivel: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain('PROFUNDIDAD_MAXIMA');
  });

  it('no rompe con null, undefined ni fechas', () => {
    const r = redact({ a: null, b: undefined, c: new Date('2026-08-16T00:00:00Z') }) as any;
    expect(r.a).toBeNull();
    expect(r.c).toBe('2026-08-16T00:00:00.000Z');
  });
});

describe('scrubMessage', () => {
  it('elimina un secreto conocido del mensaje', () => {
    const secreto = 'bsale-token-abcdef123456';
    const msg = `Falló la llamada con access_token=${secreto} en /v1/offices.json`;
    const limpio = scrubMessage(msg, [secreto]);
    expect(limpio).not.toContain(secreto);
    expect(limpio).toContain('[REDACTADO]');
  });

  it('detecta tokens de Shopify por patrón aunque no se le pasen', () => {
    const msg = 'Error con shpat_0123456789abcdef0123456789abcdef';
    expect(scrubMessage(msg)).not.toContain('shpat_0123456789');
  });

  it('ignora secretos demasiado cortos para evitar destrozar el mensaje', () => {
    expect(scrubMessage('el precio es 12', ['12'])).toBe('el precio es 12');
  });

  it('deja intacto un mensaje sin secretos', () => {
    const msg = 'Bsale respondió con estado 404.';
    expect(scrubMessage(msg, ['token-largo-secreto'])).toBe(msg);
  });
});
