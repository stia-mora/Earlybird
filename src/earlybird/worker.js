import Bull from 'bull';
import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { createArticlePipeline } from './pipeline.js';
import { cacheScraperFactory, createSourceMonitor, defaultScraperFactory, retryAtFromRateLimit } from './sourceMonitor.js';
import { enqueueInterruptedJobs, enqueueLegacyEditorialJobs } from './jobRecovery.js';
import { pollIntervalMs, startupPollDelay } from './sourcePollTiming.js';
import { buildDailySummary } from './dailySummary.js';
import { createHermesNotifier } from './hermesNotifier.js';

const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
const prisma = new PrismaClient();
const queue = new Bull('earlybird-articles', redisUrl);
const monitorQueue = new Bull('earlybird-source-monitor', redisUrl);
const notifier = createHermesNotifier({ prisma });
const pipeline = createArticlePipeline({ prisma, scraperFactory: defaultScraperFactory, notifier });
const monitor = createSourceMonitor({
  prisma,
  queue,
  scraperFactory: cacheScraperFactory(defaultScraperFactory),
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
  } catch (error) {
    const retryAt = retryAtFromRateLimit(error);
    if (retryAt) return { rateLimitedUntil: retryAt };
    await sleep(sourceRetryDelayMs);
    try {
      return await monitor.pollSource(sourceId);
    } catch (retryError) {
      const retryAt = retryAtFromRateLimit(retryError);
      if (retryAt) return { rateLimitedUntil: retryAt };
      throw retryError;
    }
  }
}

async function scheduleNextSourcePoll(sourceId, startedAt, rateLimitedUntil = null) {
  const source = await prisma.earlyBirdSource.findUnique({ where: { id: sourceId } });
  if (!source?.enabled) return;
  const every = pollIntervalMs(source);
  const regularDelay = Math.max(0, every - (Date.now() - startedAt));
  const rateLimitDelay = rateLimitedUntil ? Math.max(0, rateLimitedUntil - Date.now()) : 0;
  await enqueueSourcePoll(source, Math.max(regularDelay, rateLimitDelay));
}

async function sendDailySummary() {
  const summary = await buildDailySummary({ prisma });
  const delivery = await notifier.dailySummary(summary);
  console.log(`EarlyBird daily summary ${summary.day}: ${delivery.status}`);
  return delivery;
}

async function runDailyEditorialReview() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const start = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
  const jobs = await prisma.earlyBirdArticleJob.findMany({
    where: { status: { in: ['detected', 'verified'] }, detectedAt: { gte: start, lte: now } },
    select: { id: true },
    orderBy: { detectedAt: 'asc' },
  });
  for (const job of jobs) {
    try {
      await pipeline.process(job.id, { force: true, dailyReview: true });
    } catch (error) {
      console.error(`EarlyBird daily editorial review failed for job ${job.id}:`, error.message);
    }
  }
  console.log(`EarlyBird daily editorial review processed ${jobs.length} job(s)`);
  return jobs.length;
}

await monitor.ensureDefaults();
queue.process('process', Number(process.env.EARLYBIRD_CONCURRENCY || 1), async job => {
  return pipeline.process(job.data.jobId, job.data.options || {});
});
monitorQueue.process('poll', Number(process.env.EARLYBIRD_SOURCE_CONCURRENCY || 2), async job => {
  await waitForSourceRequestSlot();
  const startedAt = Date.now();
  let result;
  try {
    result = await pollSourceWithRetry(job.data.sourceId);
    return result;
  } finally {
    await scheduleNextSourcePoll(job.data.sourceId, startedAt, result?.rateLimitedUntil);
  }
});

async function scheduleSources() {
  const sources = await prisma.earlyBirdSource.findMany({ where: { enabled: true } });
  const active = new Set();
  for (const job of await monitorQueue.getJobs(['waiting', 'delayed', 'active'])) {
    if (job.name !== 'poll' || !job.data?.sourceId) continue;
    if (await job.getState() === 'active') active.add(job.data.sourceId);
    else await job.remove();
  }
  for (const [index, source] of sources.entries()) {
    if (active.has(source.id)) continue;
    await enqueueSourcePoll(source, startupPollDelay(source, { index, total: sources.length }));
  }
}
await scheduleSources();
const recoveredJobs = await enqueueInterruptedJobs({ prisma, queue });
if (recoveredJobs) console.warn(`EarlyBird recovered ${recoveredJobs} interrupted article job(s)`);
const legacyEditorialJobs = await enqueueLegacyEditorialJobs({ prisma, queue });
if (legacyEditorialJobs) console.warn(`EarlyBird requeued ${legacyEditorialJobs} job(s) excluded by the previous editorial policy`);
const dailySummaryTask = cron.schedule(process.env.EARLYBIRD_DAILY_SUMMARY_CRON || '0 21 * * *', () => {
  sendDailySummary().catch(error => console.error('EarlyBird daily summary failed', error.message));
}, { timezone: 'Asia/Shanghai', noOverlap: true });
const editorialReviewTask = cron.schedule(process.env.EARLYBIRD_DAILY_EDITORIAL_REVIEW_CRON || '0 9,17 * * *', () => {
  runDailyEditorialReview().catch(error => console.error('EarlyBird daily editorial review failed', error.message));
}, { timezone: 'Asia/Shanghai', noOverlap: true });
console.log(`EarlyBird worker ready (${await prisma.earlyBirdSource.count()} sources)`);

process.on('SIGTERM', async () => { dailySummaryTask.stop(); editorialReviewTask.stop(); await queue.close(); await monitorQueue.close(); await prisma.$disconnect(); process.exit(0); });
