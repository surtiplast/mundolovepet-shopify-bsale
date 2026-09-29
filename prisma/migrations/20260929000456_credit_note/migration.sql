-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "orderSyncId" TEXT NOT NULL,
    "bsaleDocumentId" INTEGER NOT NULL,
    "documentTypeId" INTEGER NOT NULL,
    "referenceDocumentId" INTEGER NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "emissionDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "motive" TEXT NOT NULL,
    "sunatState" INTEGER,
    "sunatMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_bsaleDocumentId_key" ON "CreditNote"("bsaleDocumentId");

-- CreateIndex
CREATE INDEX "CreditNote_orderSyncId_idx" ON "CreditNote"("orderSyncId");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_orderSyncId_fkey" FOREIGN KEY ("orderSyncId") REFERENCES "OrderSync"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
