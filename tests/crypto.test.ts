import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CryptoError,
  generateSecret,
  open,
  parseEncryptionKey,
  safeEqual,
  seal,
} from '../src/lib/crypto.js';

const key = randomBytes(32);

describe('parseEncryptionKey', () => {
  it('acepta una clave de 32 bytes en base64', () => {
    const b64 = randomBytes(32).toString('base64');
    expect(parseEncryptionKey(b64)).toHaveLength(32);
  });

  it('rechaza una clave vacía', () => {
    expect(() => parseEncryptionKey('')).toThrow(CryptoError);
  });

  it('rechaza una clave de longitud incorrecta', () => {
    const corta = randomBytes(16).toString('base64');
    expect(() => parseEncryptionKey(corta)).toThrow(/32 bytes/);
  });
});

describe('seal / open', () => {
  it('devuelve el mismo texto tras cifrar y descifrar', () => {
    const token = 'shpat_0123456789abcdef0123456789abcdef';
    expect(open(seal(token, key), key)).toBe(token);
  });

  it('produce un ciphertext distinto en cada cifrado del mismo texto (IV aleatorio)', () => {
    const a = seal('mismo-token', key);
    const b = seal('mismo-token', key);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('nunca deja el texto plano dentro del ciphertext', () => {
    const token = 'token-super-secreto-de-bsale';
    const sealed = seal(token, key);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('secreto');
    expect(sealed.ciphertext.toString('latin1')).not.toContain(token);
  });

  it('falla si el ciphertext fue alterado (GCM detecta manipulación)', () => {
    const sealed = seal('token', key);
    sealed.ciphertext[0] ^= 0xff;
    expect(() => open(sealed, key)).toThrow(CryptoError);
  });

  it('falla si el tag de autenticación fue alterado', () => {
    const sealed = seal('token', key);
    sealed.tag[0] ^= 0xff;
    expect(() => open(sealed, key)).toThrow(CryptoError);
  });

  it('falla con una clave distinta', () => {
    const sealed = seal('token', key);
    expect(() => open(sealed, randomBytes(32))).toThrow(CryptoError);
  });

  it('no revela información de la clave en el mensaje de error', () => {
    const sealed = seal('token', key);
    try {
      open(sealed, randomBytes(32));
      expect.unreachable('debió lanzar');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(key.toString('base64'));
      expect(msg).not.toContain('token');
    }
  });

  it('rechaza cifrar un valor vacío', () => {
    expect(() => seal('', key)).toThrow(CryptoError);
  });

  it('soporta caracteres no ASCII', () => {
    const texto = 'ñandú · émisión · 日本 · 🐾';
    expect(open(seal(texto, key), key)).toBe(texto);
  });
});

describe('safeEqual', () => {
  it('reconoce cadenas iguales', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rechaza cadenas distintas de igual longitud', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('rechaza cadenas de distinta longitud sin lanzar', () => {
    expect(safeEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('generateSecret', () => {
  it('genera hex de la longitud pedida', () => {
    expect(generateSecret(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no repite valores', () => {
    const s = new Set(Array.from({ length: 50 }, () => generateSecret(16)));
    expect(s.size).toBe(50);
  });
});
