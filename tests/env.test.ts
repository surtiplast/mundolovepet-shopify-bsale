import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import { backoffDelayMs, defaultRetryable } from '../src/lib/errors.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: 'x'.repeat(40),
  ADMIN_EMAIL: 'surtiplast.pe@gmail.com',
  SHOPIFY_SHOP_DOMAIN: 'mundolovepet.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_abc123',
  BSALE_ACCESS_TOKEN: 'bsale-token',
};

describe('loadEnv', () => {
  it('acepta una configuración válida y aplica los valores por defecto', () => {
    const env = loadEnv(base as NodeJS.ProcessEnv);
    expect(env.SHOPIFY_API_VERSION).toBe('2026-07');
    expect(env.BSALE_API_BASE_URL).toBe('https://api.bsale.io/v1');
    expect(env.PORT).toBe(3000);
  });

  it('rechaza una ENCRYPTION_KEY que no sean 32 bytes', () => {
    const env = { ...base, ENCRYPTION_KEY: randomBytes(16).toString('base64') };
    expect(() => loadEnv(env as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
  });

  it('rechaza un SESSION_SECRET corto', () => {
    const env = { ...base, SESSION_SECRET: 'corto' };
    expect(() => loadEnv(env as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
  });

  it('rechaza un dominio de tienda mal formado', () => {
    const env = { ...base, SHOPIFY_SHOP_DOMAIN: 'mundolovepet.com' };
    expect(() => loadEnv(env as NodeJS.ProcessEnv)).toThrow(/myshopify\.com/);
  });

  it('rechaza una versión de API con formato inválido', () => {
    const env = { ...base, SHOPIFY_API_VERSION: 'v2' };
    expect(() => loadEnv(env as NodeJS.ProcessEnv)).toThrow(/versión/i);
  });

  it('exige el token de Bsale', () => {
    const { BSALE_ACCESS_TOKEN: _omitido, ...sinToken } = base;
    expect(() => loadEnv(sinToken as NodeJS.ProcessEnv)).toThrow(/BSALE_ACCESS_TOKEN/);
  });

  it('permite que los IDs de Bsale falten en la Fase 1', () => {
    const env = loadEnv(base as NodeJS.ProcessEnv);
    expect(env.BSALE_OFFICE_ID).toBeUndefined();
    expect(env.BSALE_DOCTYPE_BOLETA_ID).toBeUndefined();
  });

  it('convierte los IDs numéricos cuando están presentes', () => {
    const env = loadEnv({ ...base, BSALE_OFFICE_ID: '7' } as NodeJS.ProcessEnv);
    expect(env.BSALE_OFFICE_ID).toBe(7);
  });

  it('lista TODOS los problemas de configuración a la vez, no sólo el primero', () => {
    const roto = { ...base, SESSION_SECRET: 'corto', SHOPIFY_SHOP_DOMAIN: 'malo' };
    try {
      loadEnv(roto as NodeJS.ProcessEnv);
      expect.unreachable('debió lanzar');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('SESSION_SECRET');
      expect(msg).toContain('SHOPIFY_SHOP_DOMAIN');
    }
  });
});

describe('política de reintentos', () => {
  it('considera reintentables 408, 429 y los 5xx', () => {
    expect(defaultRetryable(408)).toBe(true);
    expect(defaultRetryable(429)).toBe(true);
    expect(defaultRetryable(500)).toBe(true);
    expect(defaultRetryable(503)).toBe(true);
  });

  it('NO reintenta los 4xx de cliente: reintentar no arregla un request mal formado', () => {
    expect(defaultRetryable(400)).toBe(false);
    expect(defaultRetryable(401)).toBe(false);
    expect(defaultRetryable(403)).toBe(false);
    expect(defaultRetryable(404)).toBe(false);
    expect(defaultRetryable(422)).toBe(false);
  });

  it('reintenta cuando no hay status (fallo de red)', () => {
    expect(defaultRetryable(undefined)).toBe(true);
  });

  it('mantiene el backoff dentro del tope', () => {
    for (let intento = 1; intento <= 12; intento++) {
      const d = backoffDelayMs(intento, 500, 30_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it('aplica jitter: dos llamadas seguidas no dan siempre el mismo valor', () => {
    const valores = new Set(Array.from({ length: 40 }, () => backoffDelayMs(8)));
    expect(valores.size).toBeGreaterThan(1);
  });
});
