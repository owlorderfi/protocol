import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';

/**
 * Aggregated wallet-connection / session stats for the operator dashboard.
 * Cheap counts off the User + Session tables; designed to be called once
 * per panel refresh (60s polling on the frontend).
 *
 * Privacy: we deliberately do NOT expose individual wallet addresses in
 * counts. The "recent logins" list returns truncated addresses (first 6 +
 * last 4 chars) — enough for the operator to recognize "yes that's me /
 * yes that's a known tester" without dumping a full wallet history.
 */

export interface UsersStats {
  total_users: number;
  active_sessions: number;
  sessions_24h: number;
  new_users_7d: number;
  recent_logins: Array<{
    wallet_short: string;
    created_at: string; // ISO
  }>;
}

@Injectable()
export class UsersStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async collect(): Promise<UsersStats> {
    const now = new Date();
    const day_ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const week_ago = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Parallel queries — independent reads, no cross-dependency.
    const [total_users, active_sessions, sessions_24h, new_users_7d, recent] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.session.count({
          where: { revokedAt: null, expiresAt: { gt: now } },
        }),
        this.prisma.session.count({
          where: { createdAt: { gt: day_ago } },
        }),
        this.prisma.user.count({
          where: { createdAt: { gt: week_ago } },
        }),
        this.prisma.session.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            createdAt: true,
            user: { select: { walletAddress: true } },
          },
        }),
      ]);

    return {
      total_users,
      active_sessions,
      sessions_24h,
      new_users_7d,
      recent_logins: recent.map((s) => ({
        wallet_short: truncateWallet(s.user.walletAddress),
        created_at: s.createdAt.toISOString(),
      })),
    };
  }
}

function truncateWallet(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
