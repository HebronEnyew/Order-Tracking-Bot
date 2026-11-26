/*
  Warnings:

  - A unique constraint covering the columns `[optionsRequestMessageId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "optionsRequestMessageId" INTEGER;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "options" JSONB,
ADD COLUMN     "requestedOptions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "Order_optionsRequestMessageId_key" ON "Order"("optionsRequestMessageId");
