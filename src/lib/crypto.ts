/**
 * Cifrado de credenciales en reposo.
 *
 * AES-256-GCM: cifrado autenticado. Si alguien manipula el ciphertext guardado
 * en la base de datos, el descifrado falla en vez de devolver basura silenciosa.
 *
 * Formato persistido: tres columnas separadas (ciphertext, iv, tag) en lugar de
 * un blob concatenado, para que el esquema sea explícito y auditable.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // recomendado por NIST para GCM
const TAG_BYTES = 16;

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
}

/**
 * Convierte la ENCRYPTION_KEY (base64) en un Buffer de 32 bytes.
 * Falla ruidosamente: una clave mal formada debe impedir el arranque, no
 * descubrirse en producción al intentar descifrar un token.
 */
export function parseEncryptionKey(base64Key: string): Buffer {
  if (!base64Key) {
    throw new CryptoError('ENCRYPTION_KEY no está definida. Genérala con: npm run keygen');
  }
  let key: Buffer;
  try {
    key = Buffer.from(base64Key, 'base64');
  } catch {
    throw new CryptoError('ENCRYPTION_KEY no es base64 válido.');
  }
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `ENCRYPTION_KEY debe tener exactamente ${KEY_BYTES} bytes (recibidos: ${key.length}). Genérala con: npm run keygen`,
    );
  }
  return key;
}

/** Cifra un secreto en texto plano. Devuelve las tres piezas a persistir. */
export function seal(plaintext: string, key: Buffer): SealedSecret {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new CryptoError('No se puede cifrar un valor vacío.');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/** Descifra un secreto. Lanza CryptoError si el dato fue alterado o la clave no corresponde. */
export function open(sealed: SealedSecret, key: Buffer): string {
  const { ciphertext, iv, tag } = sealed;
  if (iv.length !== IV_BYTES) throw new CryptoError('IV con longitud inválida.');
  if (tag.length !== TAG_BYTES) throw new CryptoError('Tag de autenticación con longitud inválida.');

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Mensaje deliberadamente genérico: no revelamos nada sobre la clave.
    throw new CryptoError('No se pudo descifrar la credencial (clave incorrecta o dato alterado).');
  }
}

/** Comparación en tiempo constante. Para verificar secretos sin filtrar información por timing. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Genera un secreto aleatorio en hex. Para segmentos secretos de URL de webhooks. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
