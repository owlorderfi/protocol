-- CreateEnum
CREATE TYPE "ScheduledOrderStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduledExecutionStatus" AS ENUM ('PENDING', 'FILLED', 'FAILED');

-- CreateTable
CREATE TABLE "scheduled_orders" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "maker" VARCHAR(42) NOT NULL,
    "tokenIn" VARCHAR(42) NOT NULL,
    "tokenOut" VARCHAR(42) NOT NULL,
    "amountPerSlice" VARCHAR(80) NOT NULL,
    "intervalSec" INTEGER NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "maxSlices" INTEGER NOT NULL,
    "maxSlippageBps" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "nonce" VARCHAR(80) NOT NULL,
    "signature" VARCHAR(132) NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledOrderStatus" NOT NULL DEFAULT 'ACTIVE',
    "slicesExecuted" INTEGER NOT NULL DEFAULT 0,
    "lastExecutedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_executions" (
    "id" UUID NOT NULL,
    "scheduledOrderId" UUID NOT NULL,
    "sliceIndex" INTEGER NOT NULL,
    "status" "ScheduledExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" VARCHAR(66),
    "amountIn" VARCHAR(80),
    "amountOut" VARCHAR(80),
    "feeAmount" VARCHAR(80),
    "failureReason" VARCHAR(500),
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_orders_userId_status_idx" ON "scheduled_orders"("userId", "status");

-- CreateIndex
CREATE INDEX "scheduled_orders_status_lastExecutedAt_idx" ON "scheduled_orders"("status", "lastExecutedAt");

-- CreateIndex
CREATE INDEX "scheduled_orders_maker_chainId_idx" ON "scheduled_orders"("maker", "chainId");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_executions_scheduledOrderId_sliceIndex_key" ON "scheduled_executions"("scheduledOrderId", "sliceIndex");

-- CreateIndex
CREATE INDEX "scheduled_executions_scheduledOrderId_status_idx" ON "scheduled_executions"("scheduledOrderId", "status");

-- AddForeignKey
ALTER TABLE "scheduled_orders" ADD CONSTRAINT "scheduled_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_executions" ADD CONSTRAINT "scheduled_executions_scheduledOrderId_fkey" FOREIGN KEY ("scheduledOrderId") REFERENCES "scheduled_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
