import Bull from 'bull';
import { PrismaClient } from '@prisma/client';
import { createArticlePipeline } from './pipeline.js';
import { createSourceMonitor, defaultScraperFactory } from './sourceMonitor.js';

const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
const prisma = new PrismaClient();
const queue = new Bull('earlybird-articles', redisUrl);
const monitorQueue = new Bull('earlybird-source-monitor', redisUrl);
const pipeline = createArticlePipeline({ prisma, scraperFactory: defaultScraperFactory });
const monitor = createSourceMonitor({
  prisma,
  queue,
  scraperFactory: defaultScraperFactory,
  pollTimeoutMs: Number(process.env.EARLYBIRD_SOURCE_POLL_TIMEOUT_MS || 30000),
});
const sourceRequestIntervalMs = Number(process.env.EARLYBIRD_SOURCE_MIN_REQUEST_INTERVAL_MS || 5000);
const sourceRetryDelayMs = 10000;
let nextSourceRequestAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForSourceRequestSlot() {
  const now = Date.now();
  const delay = Math.max(0, nextSourceRequestAt - now);
  nextSourceRequestAt = Math.max(nextSourceRequestAt, now) + sourceRequestIntervalMs;
  if (delay) await sleep(delay);
}

async function enqueueSourcePoll(source, delay = 0) {
  const runAt = Date.now() + Math.max(0, delay);
  return monitorQueue.add('poll', { sourceId: source.id }, {
    jobId: `earlybird-poll-${source.id}-${runAt}`,
    delay: Math.max(0, delay),
    removeOnComplete: 10,
    removeOnFail: 20,
  });
}

async function pollSourceWithRetry(sourceId) {
  try {
    return await monitor.pollSource(sourceId);
  } catch {
    await sleep(sourceRetryDelayMs);
    return monitor.pollSource(sourceId);
  }
}

async function scheduleNextSourcePoll(sourceId, startedAt) {
  const source = await prisma.earlyBirdSource.findUnique({ where: { id: sourceId } });
  if (!source?.enabled) return;
  const every = Math.max(15000, source.pollIntervalSeconds * 1000);
  await enqueueSourcePoll(source, Math.max(0, every - (Date.now() - startedAt)));
}

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
monitorQueue.process('poll', Number(process.env.EARLYBIRD_SOURCE_CONCURRENCY || 2), async job => {
  await waitForSourceRequestSlot();
  const startedAt = Date.now();
  try {
    return await pollSourceWithRetry(job.data.sourceId);
  } finally {
    await scheduleNextSourcePoll(job.data.sourceId, startedAt);
  }
});

async function scheduleSources() {
  const sources = await prisma.earlyBirdSource.findMany({ where: { enabled: true } });
  const scheduled = new Set((await monitorQueue.getJobs(['waiting', 'delayed', 'active']))
    .filter(job => job.name === 'poll' && job.data?.sourceId)
    .map(job => job.data.sourceId));
  for (const [index, source] of sources.entries()) {
    if (scheduled.has(source.id)) continue;
    const every = Math.max(15000, source.pollIntervalSeconds * 1000);
    const staggerMs = Math.max(1000, Math.floor(every / sources.length));
    await enqueueSourcePoll(source, 1000 + index * staggerMs);
  }
}
await scheduleSources();
console.log(`EarlyBird worker ready (${await prisma.earlyBirdSource.count()} sources)`);

process.on('SIGTERM', async () => { await queue.close(); await monitorQueue.close(); await prisma.$disconnect(); process.exit(0); });
