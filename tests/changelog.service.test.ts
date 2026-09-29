/**
 * Pruebas de la traducción a registros de cambios.
 *
 * Lo que importa: el mensaje y el `context` dicen exactamente qué cambió, y
 * una reparación que toca código de barras y costo a la vez genera DOS
 * registros, no uno que mezcle los dos.
 */
import { describe, expect, it } from 'vitest';
import {
  registrosDeSync,
  registrosDeReparacion,
  registrosDeCreacion,
} from '../src/services/changelog.service.js';
import type { CambioPlanificado } from '../src/services/sync.service.js';
import type { Reparacion } from '../src/services/repair.service.js';
import type { CandidatoCreacion } from '../src/services/create.service.js';

function cambio(over: Partial<CambioPlanificado> = {}): CambioPlanificado {
  return {
    codigo: 'A1',
    shopifyVariantId: 'gid://var/1',
    shopifyProductId: null,
    shopifyInventoryItemId: 'gid://inv/1',
    nombre: 'Producto',
    valorAnterior: 10,
    valorNuevo: 15,
    ...over,
  };
}

describe('registrosDeSync', () => {
  it('un registro por cambio, con el sistema y la acción correctos', () => {
    const registros = registrosDeSync([cambio()], 'STOCK', 'CRON');
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ system: 'SHOPIFY', action: 'STOCK', sku: 'A1' });
  });

  it('el mensaje muestra el antes y el después', () => {
    const [registro] = registrosDeSync([cambio({ valorAnterior: 10, valorNuevo: 15 })], 'PRECIO', 'MANUAL');
    expect(registro!.message).toBe('10 → 15');
  });

  it('sin valor anterior (primera vez que se ve el SKU), lo muestra como raya', () => {
    const [registro] = registrosDeSync([cambio({ valorAnterior: null, valorNuevo: 8 })], 'STOCK', 'CRON');
    expect(registro!.message).toBe('— → 8');
  });

  it('guarda el origen (manual o cron) en el context, para distinguirlos en el filtro', () => {
    const [manual] = registrosDeSync([cambio()], 'PRECIO', 'MANUAL');
    const [cron] = registrosDeSync([cambio()], 'PRECIO', 'CRON');
    expect(manual!.context?.origen).toBe('MANUAL');
    expect(cron!.context?.origen).toBe('CRON');
  });

  it('sin cambios no genera ningún registro', () => {
    expect(registrosDeSync([], 'STOCK', 'CRON')).toEqual([]);
  });
});

function reparacion(over: Partial<Reparacion> = {}): Reparacion {
  return {
    sku: 'A1',
    variantId: 'gid://var/1',
    productId: 'gid://prod/1',
    bsaleVariantId: 1,
    ...over,
  };
}

describe('registrosDeReparacion', () => {
  it('una reparación que sólo toca el código de barras genera un solo registro', () => {
    const registros = registrosDeReparacion(
      [reparacion({ barcode: '7501234567890', barcodeAnterior: 'A1' })],
      'CRON',
    );
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ action: 'CODIGO_BARRAS', sku: 'A1' });
  });

  it('una reparación que sólo toca el costo genera un solo registro', () => {
    const registros = registrosDeReparacion([reparacion({ costo: 4.5 })], 'CRON');
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ action: 'COSTO', sku: 'A1' });
  });

  it('una reparación que toca los dos campos a la vez genera DOS registros separados', () => {
    const registros = registrosDeReparacion(
      [reparacion({ barcode: '7501234567890', barcodeAnterior: 'A1', costo: 4.5 })],
      'MANUAL',
    );
    expect(registros).toHaveLength(2);
    expect(registros.map((r) => r.action).sort()).toEqual(['CODIGO_BARRAS', 'COSTO']);
  });

  it('el código de barras muestra antes y después; sin anterior, raya', () => {
    const [registro] = registrosDeReparacion(
      [reparacion({ barcode: '7501234567890', barcodeAnterior: null })],
      'CRON',
    );
    expect(registro!.message).toBe('— → 7501234567890');
  });
});

function candidato(over: Partial<CandidatoCreacion> = {}): CandidatoCreacion {
  return {
    sku: 'NUEVO1',
    barcode: null,
    marca: null,
    tipoProducto: null,
    titulo: 'Producto nuevo',
    precio: 25,
    stock: 10,
    bsaleVariantId: 1,
    costo: null,
    ...over,
  };
}

describe('registrosDeCreacion', () => {
  it('un registro por producto creado, con su título en el mensaje', () => {
    const [registro] = registrosDeCreacion([candidato({ titulo: 'Correa para perro' })], 'MANUAL');
    expect(registro!.action).toBe('PRODUCTO_CREADO');
    expect(registro!.message).toContain('Correa para perro');
  });
});
