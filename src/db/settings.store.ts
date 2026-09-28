/**
 * Interruptores del panel guardados en base de datos.
 *
 * Hoy sólo hay uno: si la sincronización automática de precios está activa.
 * Vivía como variable de entorno (`SYNC_AUTO_PRECIOS`), pero eso exige editar
 * el `.env` y recrear el contenedor para cambiarla — no sirve para un botón
 * del panel. Aquí se guarda para que el botón la cambie al instante, y para
 * que el cron —que corre aparte vía `docker exec`, no comparte memoria con el
 * servidor HTTP— la lea de la misma fuente que el panel.
 *
 * Igual que los demás almacenes, el cliente de Prisma se recibe con un tipo
 * estructural mínimo: el typecheck funciona antes de `prisma generate` y las
 * pruebas no necesitan el paquete ni una base de datos.
 */

export interface SettingsStore {
  /** `null` si nunca se guardó: quien llama decide el valor por defecto. */
  obtener(clave: string): Promise<string | null>;
  guardar(clave: string, valor: string): Promise<void>;
}

/** Para desarrollo sin base de datos y para las pruebas. */
export class InMemorySettingsStore implements SettingsStore {
  private readonly filas = new Map<string, string>();

  async obtener(clave: string): Promise<string | null> {
    return this.filas.get(clave) ?? null;
  }

  async guardar(clave: string, valor: string): Promise<void> {
    this.filas.set(clave, valor);
  }
}

export interface PrismaSettingsLike {
  appSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
}

export class PrismaSettingsStore implements SettingsStore {
  constructor(private readonly prisma: PrismaSettingsLike) {}

  async obtener(clave: string): Promise<string | null> {
    const fila = await this.prisma.appSetting.findUnique({ where: { key: clave } });
    return fila?.value ?? null;
  }

  async guardar(clave: string, valor: string): Promise<void> {
    await this.prisma.appSetting.upsert({
      where: { key: clave },
      create: { key: clave, value: valor },
      update: { value: valor },
    });
  }
}

/** Clave del interruptor de sincronización automática de precios. */
export const CLAVE_SYNC_AUTO_PRECIOS = 'sync_auto_precios';

/**
 * Lee el interruptor con su valor por defecto.
 *
 * El por defecto lo decide quien llama —normalmente `env.SYNC_AUTO_PRECIOS`—
 * para que una instalación que nunca tocó el botón siga comportándose como
 * antes de que este interruptor existiera.
 */
export async function leerSyncAutoPrecios(
  store: SettingsStore,
  porDefecto: boolean,
): Promise<boolean> {
  const guardado = await store.obtener(CLAVE_SYNC_AUTO_PRECIOS);
  if (guardado === null) return porDefecto;
  return guardado === 'true';
}
