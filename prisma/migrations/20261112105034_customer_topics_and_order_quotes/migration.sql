/*
  Warnings:

  - You are about to drop the column `forumTopicId` on the `Order` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[forumTopicId]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[orderNumber]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[adminMessageId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'AWAITING_PRICE';
ALTER TYPE "OrderStatus" ADD VALUE 'PRICE_SENT';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "forumTopicId" INTEGER;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "forumTopicId",
ADD COLUMN     "adminMessageId" INTEGER,
ADD COLUMN     "sourceMessageId" INTEGER;

-- AlterTable
ALTER TABLE "OrderItem" ALTER COLUMN "itemDescription" DROP NOT NULL,
ALTER COLUMN "sheinBasePrice" DROP NOT NULL,
ALTER COLUMN "supplierPrice" DROP NOT NULL,
ALTER COLUMN "customerPrice" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_forumTopicId_key" ON "Customer"("forumTopicId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_adminMessageId_key" ON "Order"("adminMessageId");
