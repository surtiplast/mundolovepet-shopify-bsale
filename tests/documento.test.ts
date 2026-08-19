/**
 * Pruebas de la identificación tributaria.
 *
 * De estas funciones sale la decisión de emitir boleta o factura, que es la
 * menos reversible del proyecto: un comprobante mal emitido hay que anularlo
 * ante SUNAT. Por eso se prueban con RUCs reales y con las formas en que la
 * gente escribe de verdad el campo «Empresa» del checkout.
 */
import { describe, expect, it } from 'vitest';
import {
  digitoVerificadorRuc,
  esRucValido,
  esDniValido,
  extraerIdentificacion,
  decidirComprobante,
} from '../src/domain/documento.js';

/** RUCs reales y públicos, para no probar sólo contra números inventados. */
const RUC_SUNAT = '20131312955';
const RUC_RENIEC = '20295613620';
const RUC_BCP = '20100047218';

describe('digitoVerificadorRuc', () => {
  it('acierta el de la SUNAT: 20131312955 termina en 5', () => {
    expect(digitoVerificadorRuc('2013131295')).toBe(5);
  });

  it('acierta el del BCP y el de RENIEC', () => {
    expect(digitoVerificadorRuc(RUC_BCP.slice(0, 10))).toBe(Number(RUC_BCP[10]));
    expect(digitoVerificadorRuc(RUC_RENIEC.slice(0, 10))).toBe(Number(RUC_RENIEC[10]));
  });

  it('devuelve null si no son exactamente diez dígitos', () => {
    expect(digitoVerificadorRuc('123')).toBeNull();
    expect(digitoVerificadorRuc('12345678901')).toBeNull();
    expect(digitoVerificadorRuc('abcdefghij')).toBeNull();
  });
});

describe('esRucValido', () => {
  it('acepta RUCs reales', () => {
    for (const ruc of [RUC_SUNAT, RUC_RENIEC, RUC_BCP]) {
      expect(esRucValido(ruc)).toBe(true);
    }
  });

  it('rechaza un RUC con el dígito verificador cambiado', () => {
    // Mismo número, último dígito distinto: es el error de tecleo típico.
    expect(esRucValido('20131312954')).toBe(false);
  });

  it('rechaza prefijos que SUNAT no usa', () => {
    // 11 dígitos y verificador correcto, pero el prefijo 30 no existe.
    expect(esRucValido('30131312950')).toBe(false);
  });

  it('rechaza longitudes que no son once', () => {
    expect(esRucValido('2013131295')).toBe(false);
    expect(esRucValido('201313129550')).toBe(false);
  });

  it('rechaza lo que no son dígitos', () => {
    expect(esRucValido('2013131295X')).toBe(false);
    expect(esRucValido('')).toBe(false);
  });
});

describe('esDniValido', () => {
  it('acepta ocho dígitos', () => {
    expect(esDniValido('45678912')).toBe(true);
  });

  it('rechaza el relleno de quien no quiere dar el suyo', () => {
    expect(esDniValido('00000000')).toBe(false);
  });

  it('rechaza otras longitudes', () => {
    expect(esDniValido('4567891')).toBe(false);
    expect(esDniValido('456789123')).toBe(false);
  });
});

/**
 * El campo «Empresa» es texto libre. Esta tanda recoge lo que la gente escribe
 * de verdad, que casi nunca es el número a secas.
 */
describe('extraerIdentificacion', () => {
  it('el número a secas', () => {
    const r = extraerIdentificacion(RUC_SUNAT);
    expect(r.tipo).toBe('RUC');
    expect(r.numero).toBe(RUC_SUNAT);
  });

  it('con la etiqueta delante: «RUC 20131312955»', () => {
    const r = extraerIdentificacion(`RUC ${RUC_SUNAT}`);
    expect(r.tipo).toBe('RUC');
    expect(r.numero).toBe(RUC_SUNAT);
    expect(r.razonSocial).toBeNull();
  });

  it('con la razón social detrás', () => {
    const r = extraerIdentificacion(`${RUC_SUNAT} - MUNDO LOVE PET SAC`);
    expect(r.numero).toBe(RUC_SUNAT);
    expect(r.razonSocial).toBe('MUNDO LOVE PET SAC');
  });

  it('con la razón social delante', () => {
    const r = extraerIdentificacion(`MUNDO LOVE PET SAC ${RUC_SUNAT}`);
    expect(r.numero).toBe(RUC_SUNAT);
    expect(r.razonSocial).toBe('MUNDO LOVE PET SAC');
  });

  it('con guiones dentro del número', () => {
    const r = extraerIdentificacion('20-131312955');
    expect(r.tipo).toBe('RUC');
    expect(r.numero).toBe(RUC_SUNAT);
  });

  it('un DNI', () => {
    const r = extraerIdentificacion('DNI 45678912');
    expect(r.tipo).toBe('DNI');
    expect(r.numero).toBe('45678912');
  });

  it('si están el RUC y el DNI, gana el RUC: quiere factura', () => {
    const r = extraerIdentificacion(`45678912 / ${RUC_SUNAT}`);
    expect(r.tipo).toBe('RUC');
    expect(r.numero).toBe(RUC_SUNAT);
  });

  it('campo vacío o sólo espacios', () => {
    expect(extraerIdentificacion('').tipo).toBe('NINGUNA');
    expect(extraerIdentificacion('   ').tipo).toBe('NINGUNA');
    expect(extraerIdentificacion(null).tipo).toBe('NINGUNA');
    expect(extraerIdentificacion(undefined).tipo).toBe('NINGUNA');
  });

  it('sólo el nombre de la empresa, sin número', () => {
    const r = extraerIdentificacion('Veterinaria San Roque');
    expect(r.tipo).toBe('NINGUNA');
    expect(r.razonSocial).toBe('Veterinaria San Roque');
  });

  it('un RUC mal escrito se devuelve igualmente, para poder avisar', () => {
    const r = extraerIdentificacion('20131312954');
    expect(r.tipo).toBe('RUC');
    expect(r.numero).toBe('20131312954');
  });

  it('ocho dígitos dentro de un número largo no son un DNI', () => {
    // 9 dígitos: ni DNI ni RUC. Un teléfono, probablemente.
    const r = extraerIdentificacion('987654321');
    expect(r.tipo).toBe('NINGUNA');
  });

  it('conserva siempre el texto original', () => {
    expect(extraerIdentificacion('  RUC 20131312955  ').original).toBe('RUC 20131312955');
  });
});

describe('decidirComprobante', () => {
  it('RUC válido → factura', () => {
    const d = decidirComprobante(`${RUC_SUNAT} MUNDO LOVE PET SAC`);
    expect(d.comprobante).toBe('FACTURA');
    expect(d.requiereRevision).toBe(false);
  });

  it('DNI válido → boleta', () => {
    const d = decidirComprobante('45678912');
    expect(d.comprobante).toBe('BOLETA');
    expect(d.requiereRevision).toBe(false);
  });

  it('campo vacío → boleta a consumidor final', () => {
    const d = decidirComprobante(null);
    expect(d.comprobante).toBe('BOLETA');
    expect(d.requiereRevision).toBe(false);
    expect(d.motivo).toMatch(/consumidor final/i);
  });

  /**
   * El caso que justifica todo el módulo. Un RUC mal escrito NO se degrada a
   * boleta: el cliente pidió factura, y una boleta no le sirve para deducir el
   * gasto. Emitirla obligaría a anularla ante SUNAT.
   */
  describe('cuando no se emite nada', () => {
    it('un RUC inválido para la revisión, no emite boleta', () => {
      const d = decidirComprobante('20131312954');

      expect(d.comprobante).toBeNull();
      expect(d.requiereRevision).toBe(true);
      expect(d.motivo).toMatch(/no es válido/i);
    });

    it('un nombre de empresa sin número también se revisa', () => {
      const d = decidirComprobante('Veterinaria San Roque');

      expect(d.comprobante).toBeNull();
      expect(d.requiereRevision).toBe(true);
    });

    it('nunca devuelve comprobante Y revisión a la vez', () => {
      const casos = [RUC_SUNAT, '45678912', null, '', '20131312954', 'Veterinaria San Roque'];

      for (const caso of casos) {
        const d = decidirComprobante(caso);
        expect(d.requiereRevision).toBe(d.comprobante === null);
      }
    });
  });

  it('el motivo siempre explica algo, para poder leerlo en el panel', () => {
    const casos = [RUC_SUNAT, '45678912', null, '20131312954', 'Veterinaria San Roque'];

    for (const caso of casos) {
      expect(decidirComprobante(caso).motivo.length).toBeGreaterThan(10);
    }
  });
});
