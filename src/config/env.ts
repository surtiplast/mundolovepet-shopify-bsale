/**
 * Validación de configuración.
 *
 * Si falta algo esencial, la app NO arranca. Es preferible un fallo ruidoso al
 * desplegar que descubrir a mitad de una facturación que ENCRYPTION_KEY estaba
 * vacía.
 */
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  REDIS_URL: z.string().min(1).optional(),

  ENCRYPTION_KEY: z
    .string()
    .min(1, 'ENCRYPTION_KEY es obligatoria. Genérala con: npm run keygen')
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'ENCRYPTION_KEY debe decodificar a exactamente 32 bytes.',
    }),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET debe tener al menos 32 caracteres'),

  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_HASH: z.string().min(1).optional(),

  // ── Shopify ──
  SHOPIFY_SHOP_DOMAIN: z
    .string()
    .regex(/^[a-z0-9-]+\.myshopify\.com$/i, 'Debe tener el formato tienda.myshopify.com'),
  /**
   * Credenciales de la app del Dev Dashboard.
   *
   * Desde el 1 de enero de 2026 Shopify no permite crear apps personalizadas
   * desde el admin de la tienda, que eran las que entregaban un token estático
   * `shpat_…`. Las apps nuevas dan Client ID y Client Secret, y el token se
   * pide con el flujo de client credentials — caduca cada ~24 h y lo renueva
   * `integrations/shopify/token.ts`.
   */
  SHOPIFY_CLIENT_ID: z.string().min(1, 'SHOPIFY_CLIENT_ID es obligatorio'),
  SHOPIFY_CLIENT_SECRET: z.string().min(1, 'SHOPIFY_CLIENT_SECRET es obligatorio'),
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Formato de versión inválido (ej. 2026-07)')
    .default('2026-07'),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),

  // ── Bsale ──
  BSALE_ACCESS_TOKEN: z.string().min(1, 'BSALE_ACCESS_TOKEN es obligatorio'),
  BSALE_API_BASE_URL: z.string().url().default('https://api.bsale.io/v1'),

  // Estos se descubren llamando a la API en la Fase 1. Opcionales hasta la Fase 2.
  BSALE_OFFICE_ID: z.coerce.number().int().positive().optional(),
  BSALE_PRICE_LIST_ID: z.coerce.number().int().positive().optional(),
  BSALE_DOCTYPE_BOLETA_ID: z.coerce.number().int().positive().optional(),
  BSALE_DOCTYPE_FACTURA_ID: z.coerce.number().int().positive().optional(),
  BSALE_TAX_ID_IGV: z.coerce.number().int().positive().optional(),
  BSALE_WEBHOOK_PATH_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida:\n${detalle}\n\nRevisa tu archivo .env (ver .env.example).`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Sólo para tests. */
export function resetEnvCache(): void {
  cached = null;
}
