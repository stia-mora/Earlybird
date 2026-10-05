import { PrismaClient } from '@prisma/client';
import { DEFAULT_SOURCES } from '../src/earlybird/utils.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding EarlyBird sources...');
  for (const source of DEFAULT_SOURCES) {
    const created = await prisma.earlyBirdSource.upsert({
      where: { handle: source.handle },
      update: {},
      create: {
        ...source,
        pollIntervalSeconds: 300,
      },
    });
    console.log(`✅ Seeded source: @${created.handle}`);
  }
  console.log('🌟 EarlyBird seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
