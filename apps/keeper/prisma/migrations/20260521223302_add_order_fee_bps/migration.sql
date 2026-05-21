-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('LIMIT_BUY', 'LIMIT_SELL', 'STOP_LOSS', 'TAKE_PROFIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'EXECUTING', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "walletAddress" VARCHAR(42) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_nonces" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "nonce" VARCHAR(64) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" VARCHAR(255),
    "ipAddress" VARCHAR(45),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL,
    "maker" VARCHAR(42) NOT NULL,
    "tokenIn" VARCHAR(42) NOT NULL,
    "tokenOut" VARCHAR(42) NOT NULL,
    "amountIn" VARCHAR(80) NOT NULL,
    "minAmountOut" VARCHAR(80) NOT NULL,
    "triggerPrice" VARCHAR(80) NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "feeBps" SMALLINT NOT NULL,
    "nonce" VARCHAR(80) NOT NULL,
    "signature" VARCHAR(132) NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executingAt" TIMESTAMP(3),
    "filledAt" TIMESTAMP(3),
    "txHash" VARCHAR(66),
    "filledAmountOut" VARCHAR(80),
    "failureReason" VARCHAR(500),
    "feeTier" INTEGER,
    "feeAmount" VARCHAR(80),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE INDEX "users_walletAddress_idx" ON "users"("walletAddress");

-- CreateIndex
CREATE INDEX "auth_nonces_nonce_idx" ON "auth_nonces"("nonce");

-- CreateIndex
CREATE INDEX "auth_nonces_userId_idx" ON "auth_nonces"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "orders_userId_status_idx" ON "orders"("userId", "status");

-- CreateIndex
CREATE INDEX "orders_status_deadline_idx" ON "orders"("status", "deadline");

-- CreateIndex
CREATE INDEX "orders_status_executingAt_idx" ON "orders"("status", "executingAt");

-- CreateIndex
CREATE INDEX "orders_maker_chainId_idx" ON "orders"("maker", "chainId");

-- AddForeignKey
ALTER TABLE "auth_nonces" ADD CONSTRAINT "auth_nonces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
