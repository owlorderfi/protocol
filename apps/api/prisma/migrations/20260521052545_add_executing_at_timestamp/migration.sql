-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "executingAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "orders_status_executingAt_idx" ON "orders"("status", "executingAt");
