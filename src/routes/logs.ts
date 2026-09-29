/**
 * API de sólo lectura del registro de cambios: qué se actualizó solo (o a
 * mano) y cuándo. Ver `synclog.store.ts` para qué se guarda y por qué.
 */
import { Router, type Request, type Response } from 'express';
import type { SyncLogStore, AccionLog } from '../db/synclog.store.js';

const ACCIONES_VALIDAS: readonly AccionLog[] = [
  'STOCK',
  'PRECIO',
  'COSTO',
  'CODIGO_BARRAS',
  'PRODUCTO_CREADO',
];

function fechaDe(valor: unknown): Date | undefined {
  if (typeof valor !== 'string' || !valor) return undefined;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function logsRouter(logs: SyncLogStore): Router {
  const router = Router();

  router.get('/logs', async (req: Request, res: Response) => {
    const accion = String(req.query.accion ?? '');
    const limite = Number(req.query.limite) > 0 ? Math.min(Number(req.query.limite), 500) : 200;
    const offset = Number(req.query.offset) > 0 ? Number(req.query.offset) : 0;

    try {
      const pagina = await logs.listar({
        desde: fechaDe(req.query.desde),
        hasta: fechaDe(req.query.hasta),
        action: (ACCIONES_VALIDAS as readonly string[]).includes(accion) ? (accion as AccionLog) : undefined,
        sku: typeof req.query.sku === 'string' && req.query.sku ? req.query.sku : undefined,
        limite,
        offset,
      });
      res.json({ ok: true, ...pagina });
    } catch (error) {
      res.status(500).json({ error: { message: (error as Error).message || 'No se pudo leer el registro de cambios.' } });
    }
  });

  return router;
}
