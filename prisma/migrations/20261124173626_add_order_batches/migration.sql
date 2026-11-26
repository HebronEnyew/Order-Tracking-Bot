-- CreateEnum
CREATE TYPE "OrderBatchStatus" AS ENUM ('COLLECTING', 'SUBMITTING', 'FAILED', 'SUBMITTED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "batchId" TEXT;

-- CreateTable
CREATE TABLE "OrderBatch" (
    "id" TEXT NOT NULL,
    "batchNumber" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "OrderBatchStatus" NOT NULL DEFAULT 'COLLECTING',
    "promptMessageId" INTEGER,
    "adminSummaryMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "OrderBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderBatch_batchNumber_key" ON "OrderBatch"("batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBatch_adminSummaryMessageId_key" ON "OrderBatch"("adminSummaryMessageId");

-- CreateIndex
CREATE INDEX "OrderBatch_customerId_status_idx" ON "OrderBatch"("customerId", "status");

-- CreateIndex
CREATE INDEX "Order_batchId_idx" ON "Order"("batchId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OrderBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderBatch" ADD CONSTRAINT "OrderBatch_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
