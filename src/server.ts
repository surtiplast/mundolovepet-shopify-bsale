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
import { catalogRouter } from './routes/catalog.js';
import { syncRouter } from './routes/sync.js';
import { invoicesRouter } from './routes/invoices.js';
import { requiereClave } from './lib/auth.js';
import { readFile } from 'node:fs/promises';
import {
  InMemoryCatalogStore,
  PrismaCatalogStore,
  type CatalogStore,
  type PrismaCatalogLike,
} from './db/catalog.store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function resolveStore(
  env: Env,
): Promise<{ store: ConnectionStore; catalog: CatalogStore; kind: string }> {
  try {
    // Import dinámico: la app arranca aunque `prisma generate` no se haya
    // ejecutado todavía, lo que hace mucho más suave el primer despliegue.
    const mod = (await import('@prisma/client')) as unknown as {
      PrismaClient: new (args?: unknown) => PrismaLike & { $connect(): Promise<void> };
    };
    const prisma = new mod.PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    await prisma.$connect();
    return {
      store: new PrismaConnectionStore(prisma),
      catalog: new PrismaCatalogStore(prisma as unknown as PrismaCatalogLike),
      kind: 'postgresql',
    };
  } catch (error) {
    logger.warn(
      { reason: (error as Error).message },
      'No se pudo conectar a PostgreSQL. Usando almacén en memoria (los tokens no persistirán al reiniciar).',
    );
    return {
      store: new InMemoryConnectionStore(),
      catalog: new InMemoryCatalogStore(),
      kind: 'memoria (volátil)',
    };
  }
}

export async function createApp(
  env: Env,
  store: ConnectionStore,
  storeKind: string,
  catalog: CatalogStore = new InMemoryCatalogStore(),
) {
  const encryptionKey = parseEncryptionKey(env.ENCRYPTION_KEY);
  const service = new ConnectionService({ store, encryptionKey });

  // Los tokens llegan por entorno y se persisten cifrados. A partir de aquí, la
  // app trabaja siempre con la versión cifrada.
  await service.saveCredential('BSALE', env.BSALE_ACCESS_TOKEN, {
    baseUrl: env.BSALE_API_BASE_URL,
  });
  // Para Shopify se guarda el CLIENT SECRET. Desde enero de 2026 no hay token
  // estático que guardar: el token se pide con client credentials y caduca en
  // ~24 h, así que lo duradero —y lo que hay que proteger— es el secreto.
  await service.saveCredential('SHOPIFY', env.SHOPIFY_CLIENT_SECRET, {
    shopDomain: env.SHOPIFY_SHOP_DOMAIN,
    apiVersion: env.SHOPIFY_API_VERSION,
    clientId: env.SHOPIFY_CLIENT_ID,
  });

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detrás de Caddy

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // App Bridge se carga del CDN de Shopify. Es obligatorio: no se puede
          // empaquetar, Shopify exige la versión servida desde su CDN para
          // poder actualizarla sin romper las apps.
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.shopify.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://cdn.shopify.com'],
          connectSrc: ["'self'", 'https://*.myshopify.com', 'https://admin.shopify.com'],
          objectSrc: ["'none'"],
          // Quién puede meter esta app dentro de un marco.
          //
          // Antes era `'none'`, que impedía embeberla en ningún sitio —seguro,
          // pero incompatible con abrirla desde Aplicaciones en el admin—.
          // Ahora se permite exactamente a la tienda y al admin de Shopify, y a
          // nadie más: sigue sin poder embeberla un tercero.
          frameAncestors: [
            `https://${env.SHOPIFY_SHOP_DOMAIN}`,
            'https://admin.shopify.com',
          ],
        },
      },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  app.use(express.json({ limit: '1mb' }));

  // ── El candado ────────────────────────────────────────────────────────────
  // Va ANTES de las rutas y de los ficheros estáticos: protege la API y el
  // panel de una vez. `/api/health` queda fuera porque Render lo consulta para
  // saber si el servicio vive, y un 401 lo daría por caído.
  if (env.PANEL_USER && env.PANEL_PASSWORD) {
    app.use(
      requiereClave({
        usuario: env.PANEL_USER,
        clave: env.PANEL_PASSWORD,
        shopify: {
          clientId: env.SHOPIFY_CLIENT_ID,
          clientSecret: env.SHOPIFY_CLIENT_SECRET,
          tienda: env.SHOPIFY_SHOP_DOMAIN,
        },
        // Sólo el chequeo de salud queda siempre fuera: Render lo consulta
        // para saber si el servicio vive, y un 401 lo daría por caído.
        //
        // El HTML del panel lo resuelve el propio middleware: sin candado
        // cuando lo pide Shopify para enmarcarlo, con candado cuando alguien
        // abre la URL directamente.
        exentas: ['/api/health'],
      }),
    );
  } else {
    // Sólo ocurre en desarrollo: en producción `loadEnv` no deja arrancar.
    logger.warn('Panel SIN contraseña. Correcto en local; en producción no arrancaría.');
  }

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
  app.use('/api', catalogRouter(service, catalog, env));
  app.use('/api', syncRouter(service, catalog, env));
  app.use('/api', invoicesRouter(service, env));

  // ── El panel ──────────────────────────────────────────────────────────────
  //
  // Se sirve a mano en vez de con `express.static` porque hay que sustituir el
  // marcador de la clave de App Bridge. Shopify exige que la clave esté en el
  // HTML: es pública —identifica la app, no la autoriza—, pero no debe quedar
  // escrita en el repositorio, donde apuntaría siempre a la misma app y habría
  // que editarla a mano para cambiar de entorno.
  //
  // El fichero se lee una vez al arrancar. No cambia en caliente, y leerlo en
  // cada petición sería una llamada a disco por visita para nada.
  const panelHtml = (await readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'))
    .replace('__SHOPIFY_API_KEY__', env.SHOPIFY_CLIENT_ID);

  const servirPanel = (_req: express.Request, res: express.Response): void => {
    res.type('html').send(panelHtml);
  };

  app.get('/', servirPanel);
  app.get('/index.html', servirPanel);

  // El resto de estáticos, si algún día los hay.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

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

  const { store, catalog, kind } = await resolveStore(env);
  const { app } = await createApp(env, store, kind, catalog);

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
