import { PrismaClient } from '@prisma/client';

let _prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({ log: ['warn', 'error'] });
  }
  return _prisma;
}

export async function disconnectDb(): Promise<void> {
  await _prisma?.$disconnect();
  _prisma = null;
}
