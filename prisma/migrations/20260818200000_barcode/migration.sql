-- Código de barras del fabricante, distinto del SKU.
--
-- En Bsale una variante tiene `code` (el SKU) y `barCode` (el EAN del
-- fabricante), y son valores distintos. Antes se copiaba el SKU al campo de
-- código de barras de Shopify, lo que destruía el EAN real.
ALTER TABLE "ProductMap" ADD COLUMN "barcode" TEXT;
