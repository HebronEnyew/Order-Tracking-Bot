-- CreateEnum
CREATE TYPE "OrderIntakeStep" AS ENUM ('PRODUCT_NAME', 'SIZE', 'COLOR', 'QUANTITY', 'CONFIRMATION', 'COMPLETED');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'AWAITING_DETAILS';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "intakeStep" "OrderIntakeStep";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "color" TEXT,
ADD COLUMN     "productName" TEXT,
ADD COLUMN     "size" TEXT;
