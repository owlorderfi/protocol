import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service.js';

/**
 * DB-backed operator metrics. Separate from ContractStateService because
 * these are local Postgres queries, not on-chain reads — different
 * failure modes, different cache TTLs, no chain involvement.
 *
 * Three groups:
 *  - countByStatus    : current snapshot of Order + ScheduledOrder +
 *                        ScheduledExecution by status (per chain).
 *  - failedRecent     : count + latest reason for FAILED Orders +
 *                        FAILED ScheduledExecutions in the last N hours.
 *                        Useful for "is anything broken right now?"
 *  - throughputLastHour: how many trades actually settled in the last
 *                        hour (FILLED Orders + FILLED ScheduledExecutions).
 *                        Operator-facing "is the keeper doing work?"
 *                        signal.
 *
 * Order's missing `updatedAt` means FAILED counting uses `createdAt` as
 * proxy (orders normally fail within minutes of creation, so the drift
 * is minimal). ScheduledExecution has `executedAt` which is the right
 * anchor for that side.
 */
@Injectable()
export class AdminStatsService {
  private readonly logger = new Logger(AdminStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async countByStatus(chainId: number): Promise<{
    orders: Record<string, number>;
    scheduled: Record<string, number>;
    executions: Record<string, number>;
  }> {
    const [orderGroups, scheduledGroups, execGroups] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['status'],
        where: { chainId },
        _count: true,
      }),
      this.prisma.scheduledOrder.groupBy({
        by: ['status'],
        where: { chainId },
        _count: true,
      }),
      // ScheduledExecution has no direct chainId — join via scheduledOrder.
      this.prisma.scheduledExecution.groupBy({
        by: ['status'],
        where: { scheduledOrder: { chainId } },
        _count: true,
      }),
    ]);

    return {
      orders: toCountMap(orderGroups),
      scheduled: toCountMap(scheduledGroups),
      executions: toCountMap(execGroups),
    };
  }

  async failedRecent(
    chainId: number,
    hours: number = 24,
  ): Promise<{
    orders: { count: number; latestReason: string | null; latestAt: string | null };
    executions: { count: number; latestReason: string | null; latestAt: string | null };
  }> {
    const since = new Date(Date.now() - hours * 3_600_000);

    const [orderCount, latestOrder, execCount, latestExec] = await Promise.all([
      this.prisma.order.count({
        where: { chainId, status: 'FAILED', createdAt: { gte: since } },
      }),
      this.prisma.order.findFirst({
        where: { chainId, status: 'FAILED', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { failureReason: true, createdAt: true },
      }),
      this.prisma.scheduledExecution.count({
        where: {
          status: 'FAILED',
          executedAt: { gte: since },
          scheduledOrder: { chainId },
        },
      }),
      this.prisma.scheduledExecution.findFirst({
        where: {
          status: 'FAILED',
          executedAt: { gte: since },
          scheduledOrder: { chainId },
        },
        orderBy: { executedAt: 'desc' },
        select: { failureReason: true, executedAt: true },
      }),
    ]);

    return {
      orders: {
        count: orderCount,
        latestReason: latestOrder?.failureReason ?? null,
        latestAt: latestOrder ? latestOrder.createdAt.toISOString() : null,
      },
      executions: {
        count: execCount,
        latestReason: latestExec?.failureReason ?? null,
        latestAt: latestExec ? latestExec.executedAt.toISOString() : null,
      },
    };
  }

  /**
   * Throughput: how many FILLED trades happened in the rolling 1h window,
   * with the prior 1h as a comparison so the operator can see if the
   * trend is up or down ("keeper picked up volume" vs "keeper stalled").
   * Combines Order.FILLED + ScheduledExecution.FILLED — both are
   * settled-on-chain trades from the operator's POV.
   */
  async throughputLastHour(chainId: number): Promise<{
    lastHour: number;
    priorHour: number;
    deltaPct: number; // +X% or -X%; null if priorHour == 0
  }> {
    const now = Date.now();
    const oneHourAgo = new Date(now - 3_600_000);
    const twoHoursAgo = new Date(now - 7_200_000);

    const [lastHourOrders, lastHourExecs, priorHourOrders, priorHourExecs] = await Promise.all([
      this.prisma.order.count({
        where: { chainId, status: 'FILLED', filledAt: { gte: oneHourAgo } },
      }),
      this.prisma.scheduledExecution.count({
        where: {
          status: 'FILLED',
          executedAt: { gte: oneHourAgo },
          scheduledOrder: { chainId },
        },
      }),
      this.prisma.order.count({
        where: {
          chainId,
          status: 'FILLED',
          filledAt: { gte: twoHoursAgo, lt: oneHourAgo },
        },
      }),
      this.prisma.scheduledExecution.count({
        where: {
          status: 'FILLED',
          executedAt: { gte: twoHoursAgo, lt: oneHourAgo },
          scheduledOrder: { chainId },
        },
      }),
    ]);

    const lastHour = lastHourOrders + lastHourExecs;
    const priorHour = priorHourOrders + priorHourExecs;
    const deltaPct = priorHour === 0 ? 0 : ((lastHour - priorHour) / priorHour) * 100;

    return { lastHour, priorHour, deltaPct };
  }
}

function toCountMap(
  groups: Array<{ status: string; _count: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) out[g.status] = g._count;
  return out;
}
