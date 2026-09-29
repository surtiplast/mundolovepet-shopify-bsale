/**
 * Caché en disco de los PDFs de comprobantes.
 *
 * ── Por qué ───────────────────────────────────────────────────────────────
 *
 * Sin esto, cada vez que alguien abre «Ver PDF» la app vuelve a pedirlo a
 * Bsale. Guardar una copia en el volumen privado del contenedor evita esa
 * dependencia en cada vista y sobrevive a que la URL de Bsale expire.
 *
 * No usa S3/R2: eso hace falta en Render, donde el disco no es persistente
 * entre despliegues (ver DESPLIEGUE-RENDER.md). Aquí el volumen `storage` de
 * `docker-compose.yml` sí persiste, así que basta con el sistema de archivos.
 *
 * La clave es el `bsaleDocumentId` — un entero que asigna Bsale, nunca texto
 * de un pedido — así que no hace falta sanear nada para escribir la ruta.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Se lee en cada llamada, no una vez al importar: así las pruebas pueden
// apuntar `STORAGE_DIR` a un directorio temporal sin depender del orden de
// los `import`.
function directorioComprobantes(): string {
  return path.join(process.env.STORAGE_DIR || '/app/storage', 'comprobantes');
}

function rutaDe(bsaleDocumentId: number): string {
  return path.join(directorioComprobantes(), `${bsaleDocumentId}.pdf`);
}

export async function leerPdfGuardado(bsaleDocumentId: number): Promise<Buffer | null> {
  try {
    return await fs.readFile(rutaDe(bsaleDocumentId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function guardarPdf(bsaleDocumentId: number, contenido: Buffer): Promise<void> {
  await fs.mkdir(directorioComprobantes(), { recursive: true });
  await fs.writeFile(rutaDe(bsaleDocumentId), contenido);
}
