/**
 * ToptanPortal - Prisma Istemci Fabrikasi
 *
 * Gelistirme modunda hot-reload sirasinda baglanti havuzunun tukenmemesi icin
 * global uzerinde tekil (singleton) tutulur.
 */

import { PrismaClient, Prisma } from '@prisma/client';

export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const globalForPrisma = globalThis as unknown as {
  __toptanportalPrisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const logLevels: Prisma.LogLevel[] =
    process.env.NODE_ENV === 'production'
      ? ['warn', 'error']
      : ['query', 'warn', 'error'];

  return new PrismaClient({
    log: logLevels.map((level) => ({ level, emit: 'stdout' as const })),
    errorFormat: process.env.NODE_ENV === 'production' ? 'minimal' : 'pretty',
  });
}

export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.__toptanportalPrisma) {
    globalForPrisma.__toptanportalPrisma = createPrismaClient();
  }
  return globalForPrisma.__toptanportalPrisma;
}

export const prisma: PrismaClient = getPrismaClient();
