import Bull from 'bull';
import { PrismaClient } from '@prisma/client';
import { createArticlePipeline } from './pipeline.js';
import { createSourceMonitor, defaultScraperFactory } from './sourceMonitor.js';

const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
const prisma = new PrismaClient();
const queue = new Bull('earlybird-articles', redisUrl);
const monitorQueue = new Bull('earlybird-source-monitor', redisUrl, {
  limiter: { max: 1, duration: Number(process.env.EARLYBIRD_SOURCE_MIN_REQUEST_INTERVAL_MS || 5000) },
});
const pipeline = createArticlePipeline({ prisma, scraperFactory: defaultScraperFactory });
const monitor = createSourceMonitor({ prisma, queue, scraperFactory: defaultScraperFactory });

await monitor.ensureDefaults();
queue.process('process', Number(process.env.EARLYBIRD_CONCURRENCY || 1), async job => {
  const result = await pipeline.process(job.data.jobId);
  const holdUntil = Date.parse(result?.metadata?.editorial?.holdUntil || '');
  if (result?.status === 'held' && Number.isFinite(holdUntil)) {
    await queue.add('process', { jobId: result.id }, {
      jobId: `earlybird-article-release-${result.id}`,
      delay: Math.max(0, holdUntil - Date.now()),
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }
  return result;
});
monitorQueue.process('poll', async job => monitor.pollSource(job.data.sourceId));

async function scheduleSources() {
  const sources = await prisma.earlyBirdSource.findMany({ where: { enabled: true } });
  for (const source of sources) {
    await monitorQueue.add('poll', { sourceId: source.id }, { jobId: `earlybird-poll-${source.id}`, repeat: { every: Math.max(15000, source.pollIntervalSeconds * 1000) }, removeOnComplete: 10, removeOnFail: 20 });
  }
}
await scheduleSources();
console.log(`EarlyBird worker ready (${await prisma.earlyBirdSource.count()} sources)`);

process.on('SIGTERM', async () => { await queue.close(); await monitorQueue.close(); await prisma.$disconnect(); process.exit(0); });
