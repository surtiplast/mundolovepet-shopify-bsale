/**
 * API de sincronización Bsale → Shopify — Fase 3.
 *
 * Dos endpoints, y la diferencia entre ellos es la más importante del proyecto:
 *
 *   POST /api/sync/preview   calcula qué cambiaría. NO escribe.
 *   POST /api/sync/apply     escribe de verdad en la tienda.
 *
 * `apply` exige `?confirmar=si` en la URL. No es burocracia: evita que una
 * pulsación accidental, un enlace copiado o un reintento del navegador
 * modifiquen miles de precios. Escribir en la tienda de un cliente debe costar
 * un gesto deliberado.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import type { ConnectionService } from '../services/connection.service.js';
import type { CatalogStore } from '../db/catalog.store.js';
import { compararCatalogos } from '../services/matching.service.js';
import { normalizarSku } from '../services/catalog.service.js';
import {
  planificar,
  aplicarStock,
  aplicarPrecios,
  type TipoSync,
  type ResultadoAplicacion,
} from '../services/sync.service.js';
import {
  planificarCreacion,
  anadirCostos,
  crearProductos,
  type ResultadoCreacion,
} from '../services/create.service.js';
import {
  planificarReparacion,
  anadirCostosReparacion,
  aplicarReparacion,
  TODOS_LOS_CAMPOS,
  type CamposReparacion,
  type ResultadoReparacion,
} from '../services/repair.service.js';
import {
  buscarDuplicados,
  planificarBorradoDuplicados,
  borrarDuplicados,
  type ResultadoBorrado,
} from '../services/duplicates.service.js';
import type { ShopifyVariant } from '../integrations/shopify/client.js';
import { IntegrationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const syncLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas sincronizaciones seguidas. Espera unos minutos.' },
});

/**
 * Candado contra operaciones de escritura concurrentes.
 *
 * `apply`, `crear`, `reparar` y `duplicados/eliminar` leen la tienda, calculan
 * un plan y luego escriben. Si dos de estas peticiones corren a la vez —dos
 * pestañas, un doble clic, un reintento— ambas calculan el plan sobre la misma
 * foto de Shopify y ninguna ve lo que la otra ya está creando/borrando: el caso
 * más claro es `/sync/crear`, donde dos ejecuciones concurrentes pueden decidir
 * que el mismo SKU «falta» y crearlo dos veces, justo el bug de duplicados que
 * `create.service.ts` existe para evitar.
 *
 * Un candado en memoria basta: la app corre en un solo proceso.
 */
let operacionEnCurso: string | null = null;

async function conCandado<T>(nombre: string, fn: () => Promise<T>): Promise<T> {
  if (operacionEnCurso) {
    throw new IntegrationError(
      `Ya hay una operación de sincronización en curso (${operacionEnCurso}). Espera a que termine.`,
      { provider: 'SHOPIFY', retryable: false, code: 'SYNC_BUSY' },
    );
  }
  operacionEnCurso = nombre;
  try {
    return await fn();
  } finally {
    operacionEnCurso = null;
  }
}

function tipoDe(req: Request): TipoSync | null {
  const t = String(req.query.tipo ?? '').toUpperCase();
  return t === 'STOCK' || t === 'PRECIO' ? t : null;
}

/**
 * Qué campos repara esta llamada: `?campos=barcode`, `?campos=costo`, o los dos
 * si no se dice nada.
 *
 * El valor por defecto mantiene el comportamiento anterior, para que un enlace
 * guardado o el cron sigan haciendo lo mismo que hacían.
 */
function camposDe(req: Request): CamposReparacion {
  const c = String(req.query.campos ?? '').toLowerCase();
  if (c === 'barcode' || c === 'codigo') return { barcode: true, costo: false };
  if (c === 'costo' || c === 'coste') return { barcode: false, costo: true };
  return TODOS_LOS_CAMPOS;
}

export function syncRouter(service: ConnectionService, store: CatalogStore, env: Env): Router {
  const router = Router();

  /**
   * Vuelve a leer Shopify y calcula el plan.
   *
   * Se relee en vez de reutilizar lo del emparejamiento anterior: entre una
   * cosa y otra alguien pudo cambiar un precio a mano, y aplicar sobre datos
   * viejos escribiría valores que ya no corresponden.
   */
  async function calcularPlan(tipo: TipoSync, limite?: number) {
    const guardados = await store.listar();
    if (guardados.length === 0) {
      throw new IntegrationError('No hay catálogo de Bsale leído todavía.', {
        provider: 'BSALE',
        retryable: false,
      });
    }

    const variantes: ShopifyVariant[] = [];
    let locationId: string | null = null;
    const productoPorVariante = new Map<string, string>();

    await service.usarShopify(
      env.SHOPIFY_SHOP_DOMAIN,
      env.SHOPIFY_API_VERSION,
      env.SHOPIFY_CLIENT_ID,
      async (client) => {
        for await (const v of client.listarVariantes()) {
          variantes.push(v);
          if (v.productId) productoPorVariante.set(v.id, v.productId);
        }
        // La sucursal de Shopify donde vive el inventario. Se toma la primera
        // activa: la mayoría de tiendas tiene una sola.
        const ubicaciones = await client.listLocations(10);
        locationId = ubicaciones.find((u) => u.isActive)?.id ?? ubicaciones[0]?.id ?? null;
      },
    );

    const informe = compararCatalogos(
      guardados.map((g) => ({
        sku: g.sku,
        bsaleVariantId: g.bsaleVariantId ?? 0,
        nombre: g.name,
        precio: g.bsalePrice,
        stock: g.bsaleStock,
      })),
      variantes,
    );

    return { plan: planificar(informe.emparejados, tipo, limite), locationId, productoPorVariante };
  }

  /** Simulación. Nunca escribe. */
  router.post('/sync/preview', syncLimiter, async (req: Request, res: Response) => {
    const tipo = tipoDe(req);
    if (!tipo) return res.status(400).json({ error: { message: 'Indica tipo=STOCK o tipo=PRECIO.' } });

    const limite = Number(req.query.limite) > 0 ? Number(req.query.limite) : undefined;

    try {
      const { plan } = await calcularPlan(tipo, limite);
      res.json({
        ok: true,
        simulacion: true,
        tipo,
        resumen: plan.resumen,
        omitidos: plan.omitidos.slice(0, 50),
        totalOmitidos: plan.omitidos.length,
        cambios: plan.cambios.slice(0, 200),
      });
    } catch (error) {
      responderError(res, error, 'No se pudo calcular la simulación.');
    }
  });

  /** Aplicación real. Exige confirmación explícita en la URL. */
  router.post('/sync/apply', syncLimiter, async (req: Request, res: Response) => {
    const tipo = tipoDe(req);
    if (!tipo) return res.status(400).json({ error: { message: 'Indica tipo=STOCK o tipo=PRECIO.' } });

    if (String(req.query.confirmar) !== 'si') {
      return res.status(400).json({
        error: {
          message:
            'Esta operación modifica la tienda. Añade confirmar=si para ejecutarla, o usa /sync/preview para simular.',
        },
      });
    }

    const limite = Number(req.query.limite) > 0 ? Number(req.query.limite) : undefined;

    try {
      await conCandado('sync/apply', async () => {
        const { plan, locationId, productoPorVariante } = await calcularPlan(tipo, limite);

        if (plan.cambios.length === 0) {
          res.json({ ok: true, simulacion: false, tipo, resultado: { aplicados: 0, fallidos: 0, errores: [] }, resumen: plan.resumen });
          return;
        }

        let resultado: ResultadoAplicacion = { aplicados: 0, fallidos: 0, errores: [] };
        if (tipo === 'STOCK') {
          if (!locationId) {
            throw new IntegrationError('No se encontró ninguna sucursal activa en Shopify.', {
              provider: 'SHOPIFY',
              retryable: false,
            });
          }
          await service.usarShopify(
            env.SHOPIFY_SHOP_DOMAIN,
            env.SHOPIFY_API_VERSION,
            env.SHOPIFY_CLIENT_ID,
            async (client) => {
              resultado = await aplicarStock(client, plan, locationId!);
            },
          );
        } else {
          await service.usarShopify(
            env.SHOPIFY_SHOP_DOMAIN,
            env.SHOPIFY_API_VERSION,
            env.SHOPIFY_CLIENT_ID,
            async (client) => {
              resultado = await aplicarPrecios(client, plan, productoPorVariante);
            },
          );
        }

        logger.info({ tipo, ...resultado, planificados: plan.cambios.length }, 'Sincronización aplicada');

        res.json({ ok: true, simulacion: false, tipo, resultado, resumen: plan.resumen });
      });
    } catch (error) {
      responderError(res, error, 'No se pudo aplicar la sincronización.');
    }
  });

  /**
   * Alta de los productos que sólo existen en Bsale.
   *
   * Se crean SIEMPRE en borrador. `confirmar=si` es obligatorio igual que en la
   * sincronización; sin él, simula.
   */
  router.post('/sync/crear', syncLimiter, async (req: Request, res: Response) => {
    const aplicar = String(req.query.confirmar) === 'si';
    const limite = Number(req.query.limite) > 0 ? Number(req.query.limite) : undefined;

    try {
      const guardados = await store.listar();
      if (guardados.length === 0) {
        throw new IntegrationError('No hay catálogo de Bsale leído todavía.', {
          provider: 'BSALE',
          retryable: false,
        });
      }

      const variantes: ShopifyVariant[] = [];
      let locationId: string | null = null;

      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          for await (const v of client.listarVariantes()) variantes.push(v);
          const ubicaciones = await client.listLocations(10);
          locationId = ubicaciones.find((u) => u.isActive)?.id ?? ubicaciones[0]?.id ?? null;
        },
      );

      const informe = compararCatalogos(
        guardados.map((g) => ({
          sku: g.sku,
          bsaleVariantId: g.bsaleVariantId ?? 0,
          nombre: g.name,
          precio: g.bsalePrice,
          stock: g.bsaleStock,
        })),
        variantes,
      );

      // Todos los códigos que Shopify ya conoce, de sus dos campos. Es la red
      // de seguridad contra duplicados: ver `planificarCreacion`.
      const codigosEnShopify = new Set<string>();
      for (const v of variantes) {
        const sku = normalizarSku(v.sku);
        const barcode = normalizarSku(v.barcode);
        if (sku) codigosEnShopify.add(sku);
        if (barcode) codigosEnShopify.add(barcode);
      }

      const plan = planificarCreacion(
        guardados,
        informe.soloEnBsale,
        limite,
        codigosEnShopify,
      );

      if (!aplicar) {
        return res.json({
          ok: true,
          simulacion: true,
          resumen: plan.resumen,
          candidatos: plan.candidatos.slice(0, 200),
          omitidos: plan.omitidos.slice(0, 50),
          totalOmitidos: plan.omitidos.length,
        });
      }

      if (!locationId) {
        throw new IntegrationError('No se encontró ninguna sucursal activa en Shopify.', {
          provider: 'SHOPIFY',
          retryable: false,
        });
      }

      await conCandado('sync/crear', async () => {
        // El costo se pide justo antes de crear, y sólo de los candidatos: Bsale
        // lo da variante por variante, así que pedirlo de todo el catálogo serían
        // miles de peticiones para nada.
        const costos = await service.usarBsale(env.BSALE_API_BASE_URL, (bsale) =>
          anadirCostos(plan, (variantId) => bsale.obtenerCosto(variantId)),
        );

        let resultado: ResultadoCreacion = { creados: 0, fallidos: 0, errores: [], ids: [] };
        await service.usarShopify(
          env.SHOPIFY_SHOP_DOMAIN,
          env.SHOPIFY_API_VERSION,
          env.SHOPIFY_CLIENT_ID,
          async (client) => {
            resultado = await crearProductos(client, plan, locationId!);
          },
        );

        logger.info(
          { ...resultado, planificados: plan.candidatos.length, ...costos },
          'Productos creados en borrador',
        );

        res.json({ ok: true, simulacion: false, resumen: plan.resumen, resultado, costos });
      });
    } catch (error) {
      responderError(res, error, 'No se pudieron crear los productos.');
    }
  });

  /**
   * Corrige productos ya creados con el código de barras o el costo mal.
   *
   * Sólo toca lo que lleva la huella del fallo (código de barras idéntico al
   * SKU) o lo que está vacío. Sin `confirmar=si`, simula.
   */
  router.post('/sync/reparar', syncLimiter, async (req: Request, res: Response) => {
    const aplicar = String(req.query.confirmar) === 'si';
    const limite = Number(req.query.limite) > 0 ? Number(req.query.limite) : undefined;
    const campos = camposDe(req);

    try {
      const guardados = await store.listar();
      if (guardados.length === 0) {
        throw new IntegrationError('No hay catálogo de Bsale leído todavía.', {
          provider: 'BSALE',
          retryable: false,
        });
      }

      const variantes: ShopifyVariant[] = [];
      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          for await (const v of client.listarVariantes()) variantes.push(v);
        },
      );

      const plan = planificarReparacion(guardados, variantes, limite, campos);

      // El costo se consulta siempre que se vaya a reparar —también al simular—,
      // porque si no el informe diría «voy a poner el costo» sin saber si Bsale
      // tiene alguno.
      //
      // Y NO se consulta cuando sólo se pide el código de barras: es una
      // petición a Bsale por variante, y era lo que hacía que reparar sólo el
      // código de barras tardase casi un minuto para nada.
      const costos = campos.costo
        ? await service.usarBsale(env.BSALE_API_BASE_URL, (bsale) =>
            anadirCostosReparacion(plan, (variantId) => bsale.obtenerCosto(variantId)),
          )
        : { conCosto: 0, sinCosto: 0 };

      if (!aplicar) {
        return res.json({
          ok: true,
          simulacion: true,
          campos,
          resumen: plan.resumen,
          costos,
          reparaciones: plan.reparaciones.slice(0, 200),
        });
      }

      await conCandado('sync/reparar', async () => {
        let resultado: ResultadoReparacion = { reparados: 0, fallidos: 0, errores: [] };
        await service.usarShopify(
          env.SHOPIFY_SHOP_DOMAIN,
          env.SHOPIFY_API_VERSION,
          env.SHOPIFY_CLIENT_ID,
          async (client) => {
            resultado = await aplicarReparacion(client, plan);
          },
        );

        logger.info({ campos, ...resultado, ...plan.resumen }, 'Productos reparados');

        res.json({ ok: true, simulacion: false, campos, resumen: plan.resumen, costos, resultado });
      });
    } catch (error) {
      responderError(res, error, 'No se pudieron reparar los productos.');
    }
  });

  /**
   * Códigos repetidos en Shopify. **Sólo lee.**
   *
   * No borra nada y no va a hacerlo: dos variantes con el mismo código pueden
   * ser un duplicado que creó la app o dos productos que el comerciante
   * registró así a propósito, y desde aquí no hay forma de distinguirlo con
   * certeza. Lo que sí hace es ordenar la sospecha.
   */
  router.get('/duplicados', async (_req: Request, res: Response) => {
    try {
      const variantes: ShopifyVariant[] = [];
      await service.usarShopify(
        env.SHOPIFY_SHOP_DOMAIN,
        env.SHOPIFY_API_VERSION,
        env.SHOPIFY_CLIENT_ID,
        async (client) => {
          for await (const v of client.listarVariantes()) variantes.push(v);
        },
      );

      const informe = buscarDuplicados(variantes);

      res.json({
        ok: true,
        resumen: { ...informe.resumen, totalVariantes: variantes.length },
        // Se recortan: con muchos grupos el JSON se dispara y el panel no
        // necesita más para que decidas por dónde empezar.
        grupos: informe.grupos.slice(0, 100),
        totalGrupos: informe.grupos.length,
      });
    } catch (error) {
      responderError(res, error, 'No se pudo buscar duplicados.');
    }
  });

  /**
   * Borra los duplicados que cumplen las cuatro reglas de
   * `planificarBorradoDuplicados`. Sin `confirmar=si`, simula.
   *
   * Es la operación más destructiva de la app —Shopify no tiene papelera para
   * productos—, así que además de la confirmación en la URL lleva su propio
   * limitador, más estrecho que el del resto: un borrado repetido por un
   * reintento del navegador no debe poder vaciar media tienda.
   */
  router.post(
    '/duplicados/eliminar',
    rateLimit({
      windowMs: 5 * 60_000,
      limit: 4,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Demasiados borrados seguidos. Espera unos minutos.' },
    }),
    async (req: Request, res: Response) => {
      const aplicar = String(req.query.confirmar) === 'si';
      const limite = Number(req.query.limite) > 0 ? Number(req.query.limite) : undefined;

      try {
        const variantes: ShopifyVariant[] = [];
        await service.usarShopify(
          env.SHOPIFY_SHOP_DOMAIN,
          env.SHOPIFY_API_VERSION,
          env.SHOPIFY_CLIENT_ID,
          async (client) => {
            for await (const v of client.listarVariantes()) variantes.push(v);
          },
        );

        // Se relee la tienda en vez de fiarse del informe anterior: entre
        // mirarlo y pulsar el botón alguien pudo publicar uno de esos
        // borradores o ponerle una foto, y entonces ya no se debe borrar.
        const informe = buscarDuplicados(variantes);
        const plan = planificarBorradoDuplicados(informe, limite);

        if (!aplicar) {
          return res.json({
            ok: true,
            simulacion: true,
            resumen: plan.resumen,
            candidatos: plan.candidatos.slice(0, 200),
            intocables: plan.intocables.slice(0, 50),
            totalIntocables: plan.intocables.length,
          });
        }

        await conCandado('duplicados/eliminar', async () => {
          let resultado: ResultadoBorrado = { borrados: 0, fallidos: 0, errores: [] };
          await service.usarShopify(
            env.SHOPIFY_SHOP_DOMAIN,
            env.SHOPIFY_API_VERSION,
            env.SHOPIFY_CLIENT_ID,
            async (client) => {
              resultado = await borrarDuplicados((id) => client.eliminarProducto(id), plan);
            },
          );

          logger.warn({ ...resultado, ...plan.resumen }, 'Duplicados borrados');

          res.json({ ok: true, simulacion: false, resumen: plan.resumen, resultado });
        });
      } catch (error) {
        responderError(res, error, 'No se pudieron borrar los duplicados.');
      }
    },
  );

  return router;
}

function responderError(res: Response, error: unknown, mensaje: string): void {
  const err =
    error instanceof IntegrationError
      ? error
      : new IntegrationError(mensaje, { provider: 'SHOPIFY', retryable: false, cause: error });
  logger.error({ err: err.toPublic() }, mensaje);
  const status = err.code === 'SYNC_BUSY' ? 409 : 502;
  res.status(status).json({ error: err.toPublic() });
}
