/**
 * Punto de entrada — Fase 1.
 *
 * Arranque:
 *  1. Validar configuración (falla ruidosamente si falta algo).
 *  2. Elegir almacén: Prisma si hay base de datos, memoria si no.
 *  3. Cifrar y guardar los tokens de .env.
 *  4. Levantar HTTP con cabeceras de seguridad.
 *
 * Lo que esta fase deliberadamente NO hace: escribir en Shopify, emitir
 * documentos en Bsale, o registrar webhooks.
 */
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadEnv, type Env } from './config/env.js';
import { parseEncryptionKey } from './lib/crypto.js';
import { logger } from './lib/logger.js';
import { InMemoryConnectionStore, type ConnectionStore } from './db/connection.store.js';
import { PrismaConnectionStore, type PrismaLike } from './db/prisma.store.js';
import { ConnectionService } from './services/connection.service.js';
import { connectionsRouter } from './routes/connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function resolveStore(env: Env): Promise<{ store: ConnectionStore; kind: string }> {
  try {
    // Import dinámico: la app arranca aunque `prisma generate` no se haya
    // ejecutado todavía, lo que hace mucho más suave el primer despliegue.
    const mod = (await import('@prisma/client')) as unknown as {
      PrismaClient: new (args?: unknown) => PrismaLike & { $connect(): Promise<void> };
    };
    const prisma = new mod.PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    await prisma.$connect();
    return { store: new PrismaConnectionStore(prisma), kind: 'postgresql' };
  } catch (error) {
    logger.warn(
      { reason: (error as Error).message },
      'No se pudo conectar a PostgreSQL. Usando almacén en memoria (los tokens no persistirán al reiniciar).',
    );
    return { store: new InMemoryConnectionStore(), kind: 'memoria (volátil)' };
  }
}

export async function createApp(env: Env, store: ConnectionStore, storeKind: string) {
  const encryptionKey = parseEncryptionKey(env.ENCRYPTION_KEY);
  const service = new ConnectionService({ store, encryptionKey });

  // Los tokens llegan por entorno y se persisten cifrados. A partir de aquí, la
  // app trabaja siempre con la versión cifrada.
  await service.saveCredential('BSALE', env.BSALE_ACCESS_TOKEN, {
    baseUrl: env.BSALE_API_BASE_URL,
  });
  await service.saveCredential('SHOPIFY', env.SHOPIFY_ADMIN_TOKEN, {
    shopDomain: env.SHOPIFY_SHOP_DOMAIN,
    apiVersion: env.SHOPIFY_API_VERSION,
  });

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detrás de Caddy

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      fase: 1,
      almacen: storeKind,
      versionApiShopify: env.SHOPIFY_API_VERSION,
      hora: new Date().toISOString(),
    });
  });

  app.use('/api', connectionsRouter(service, env));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Manejador final. Nunca devuelve stacks al cliente.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Error no controlado');
    res.status(500).json({ error: 'Error interno del servidor.' });
  });

  return { app, service };
}

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error((error as Error).message);
    process.exit(1);
  }

  const { store, kind } = await resolveStore(env);
  const { app } = await createApp(env, store, kind);

  app.listen(env.PORT, () => {
    logger.info(
      { puerto: env.PORT, almacen: kind, versionApiShopify: env.SHOPIFY_API_VERSION },
      'Mundo Love Pet — Shopify × Bsale · Fase 1 en marcha',
    );
  });
}

// Sólo arranca el servidor cuando el archivo se ejecuta directamente,
// para que los tests puedan importar createApp sin levantar un puerto.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
