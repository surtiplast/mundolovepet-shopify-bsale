-- La URL del PDF del comprobante en Bsale.
--
-- Se guarda para poder servirlo desde la app. No se expone al navegador: esa
-- URL lleva un token en la propia dirección y quien la tenga puede ver la
-- factura, así que la app hace de intermediaria.
ALTER TABLE "BsaleDocument" ADD COLUMN "bsaleUrlPdf" TEXT;
