-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('SHOPIFY', 'BSALE');

-- CreateEnum
CREATE TYPE "ConnStatus" AS ENUM ('UNKNOWN', 'CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "MapStatus" AS ENUM ('PENDING', 'SYNCED', 'ERROR', 'MISSING_SKU', 'DUPLICATE_SKU', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DocIdType" AS ENUM ('DNI', 'RUC', 'NONE');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('BOLETA', 'FACTURA');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'SYNCED', 'ERROR', 'NEEDS_ATTENTION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "SystemTag" AS ENUM ('SHOPIFY', 'BSALE', 'APP');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('PRODUCTS', 'PRICES', 'STOCK', 'ORDERS', 'RETRY');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'VIEWER');

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "encryptedToken" BYTEA NOT NULL,
    "tokenIv" BYTEA NOT NULL,
    "tokenTag" BYTEA NOT NULL,
    "tokenLast4" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "ConnStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMap" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "bsaleVariantId" INTEGER,
    "bsaleProductId" INTEGER,
    "shopifyVariantGid" TEXT,
    "shopifyProductGid" TEXT,
    "shopifyInventoryItemGid" TEXT,
    "name" TEXT,
    "brand" TEXT,
    "category" TEXT,
    "bsalePrice" DECIMAL(12,4),
    "shopifyPrice" DECIMAL(12,4),
    "bsaleStock" INTEGER,
    "shopifyStock" INTEGER,
    "status" "MapStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMap" (
    "id" TEXT NOT NULL,
    "docType" "DocIdType" NOT NULL,
    "docNumber" TEXT,
    "email" TEXT,
    "bsaleClientId" INTEGER,
    "shopifyCustomerGid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSync" (
    "id" TEXT NOT NULL,
    "shopifyOrderId" BIGINT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "shopifyOrderGid" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "customerMapId" TEXT,
    "documentKind" "DocumentKind",
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BsaleDocument" (
    "id" TEXT NOT NULL,
    "orderSyncId" TEXT NOT NULL,
    "bsaleDocumentId" INTEGER NOT NULL,
    "documentTypeId" INTEGER NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "emissionDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "bsaleToken" TEXT NOT NULL,
    "sunatState" INTEGER,
    "sunatMessage" TEXT,
    "pdfStorageKey" TEXT,
    "pdfFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BsaleDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "system" "SystemTag" NOT NULL,
    "action" TEXT NOT NULL,
    "sku" TEXT,
    "orderRef" TEXT,
    "documentRef" TEXT,
    "result" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "errorCode" TEXT,
    "context" JSONB,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" "SystemTag" NOT NULL,
    "externalId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ADMIN',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Connection_provider_key" ON "Connection"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMap_sku_key" ON "ProductMap"("sku");

-- CreateIndex
CREATE INDEX "ProductMap_status_idx" ON "ProductMap"("status");

-- CreateIndex
CREATE INDEX "ProductMap_bsaleVariantId_idx" ON "ProductMap"("bsaleVariantId");

-- CreateIndex
CREATE INDEX "ProductMap_shopifyVariantGid_idx" ON "ProductMap"("shopifyVariantGid");

-- CreateIndex
CREATE INDEX "CustomerMap_email_idx" ON "CustomerMap"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMap_docType_docNumber_key" ON "CustomerMap"("docType", "docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSync_shopifyOrderId_key" ON "OrderSync"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSync_idempotencyKey_key" ON "OrderSync"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderSync_status_idx" ON "OrderSync"("status");

-- CreateIndex
CREATE INDEX "OrderSync_createdAt_idx" ON "OrderSync"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BsaleDocument_orderSyncId_key" ON "BsaleDocument"("orderSyncId");

-- CreateIndex
CREATE UNIQUE INDEX "BsaleDocument_bsaleDocumentId_key" ON "BsaleDocument"("bsaleDocumentId");

-- CreateIndex
CREATE INDEX "SyncLog_occurredAt_idx" ON "SyncLog"("occurredAt");

-- CreateIndex
CREATE INDEX "SyncLog_system_level_idx" ON "SyncLog"("system", "level");

-- CreateIndex
CREATE INDEX "SyncLog_sku_idx" ON "SyncLog"("sku");

-- CreateIndex
CREATE INDEX "SyncLog_orderRef_idx" ON "SyncLog"("orderRef");

-- CreateIndex
CREATE INDEX "SyncRun_kind_startedAt_idx" ON "SyncRun"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_source_externalId_key" ON "WebhookEvent"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- AddForeignKey
ALTER TABLE "OrderSync" ADD CONSTRAINT "OrderSync_customerMapId_fkey" FOREIGN KEY ("customerMapId") REFERENCES "CustomerMap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BsaleDocument" ADD CONSTRAINT "BsaleDocument_orderSyncId_fkey" FOREIGN KEY ("orderSyncId") REFERENCES "OrderSync"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

