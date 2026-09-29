/**
 * Caché en disco del PDF. Lo único que importa: lo que se guarda es
 * exactamente lo que se lee después, y lo que nunca se guardó no aparece.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardarPdf, leerPdfGuardado } from '../src/lib/pdf-storage.js';

let dir: string;
let original: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-storage-'));
  original = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = dir;
});

afterEach(async () => {
  process.env.STORAGE_DIR = original;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('leerPdfGuardado', () => {
  it('devuelve null si nunca se guardó nada para ese documento', async () => {
    expect(await leerPdfGuardado(999)).toBeNull();
  });

  it('devuelve exactamente los bytes que se guardaron', async () => {
    const contenido = Buffer.from('%PDF-1.4 contenido falso');
    await guardarPdf(500, contenido);

    expect(await leerPdfGuardado(500)).toEqual(contenido);
  });

  it('cada bsaleDocumentId tiene su propio archivo', async () => {
    await guardarPdf(1, Buffer.from('uno'));
    await guardarPdf(2, Buffer.from('dos'));

    expect((await leerPdfGuardado(1))?.toString()).toBe('uno');
    expect((await leerPdfGuardado(2))?.toString()).toBe('dos');
  });
});

describe('guardarPdf', () => {
  it('crea el directorio de comprobantes si todavía no existe', async () => {
    await guardarPdf(500, Buffer.from('x'));
    const existe = await fs
      .access(path.join(dir, 'comprobantes'))
      .then(() => true)
      .catch(() => false);
    expect(existe).toBe(true);
  });

  it('sobrescribe si ya había un PDF guardado para el mismo documento', async () => {
    await guardarPdf(500, Buffer.from('viejo'));
    await guardarPdf(500, Buffer.from('nuevo'));

    expect((await leerPdfGuardado(500))?.toString()).toBe('nuevo');
  });
});
