-- Caché del costo de Bsale, para no volver a preguntar por variantes que ya
-- se consultaron y no tienen costo registrado.
--
-- Bsale sólo da el costo variante por variante, nunca en el catálogo masivo.
-- Sin este caché, cada pasada de reparar costo (cron cada minuto, o el
-- disparo por webhook) volvía a preguntar por las mismas 800+ variantes sin
-- costo, alargando cada corrida en decenas de segundos para nada.
ALTER TABLE "ProductMap" ADD COLUMN "bsaleCosto" DECIMAL(12,4);
ALTER TABLE "ProductMap" ADD COLUMN "costoRevisadoEl" TIMESTAMP(3);
