/**
 * Veritabani sertlestirme betigini uygular.
 * Her migration sonrasi otomatik calisir; elle de calistirilabilir:
 *   pnpm --filter @toptanportal/db harden
 */

import { PrismaClient } from '@prisma/client';
import { HARDENING_STATEMENTS } from '../hardening';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let applied = 0;

  try {
    await prisma.$connect();

    for (const statement of HARDENING_STATEMENTS) {
      try {
        await prisma.$executeRawUnsafe(statement.sql);
        applied += 1;
        process.stdout.write(`  [ok]   ${statement.name}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  [FAIL] ${statement.name}\n         ${message}\n`);
        throw new Error(`Sertlestirme adimi basarisiz: ${statement.name}`);
      }
    }

    process.stdout.write(
      `\nVeritabani sertlestirme tamamlandi. ${applied}/${HARDENING_STATEMENTS.length} ifade uygulandi.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nSertlestirme basarisiz: ${message}\n`);
  process.exitCode = 1;
});
