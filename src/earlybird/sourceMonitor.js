import { DEFAULT_SOURCES, comparePosts } from './utils.js';
import { readFile } from 'node:fs/promises';
import { normalizeCookies } from '../scrapers/twitter/http/accountPool.js';

const ARTICLE_QUEUE_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30000 },
  removeOnComplete: 100,
  removeOnFail: 100,
};

export function editorialBatchDelay(now = Date.now(), intervalMs = Number(process.env.EARLYBIRD_EDITORIAL_BATCH_MINUTES || 30) * 60 * 1000) {
  const interval = Math.max(60_000, intervalMs);
  return Math.max(0, Math.ceil(now / interval) * interval - now);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`source poll timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function isNewer(post, source) {
  if (!source.lastSeenCreatedAt && !source.lastSeenPostId) return true;
  const seen = { createdAt: source.lastSeenCreatedAt, id: source.lastSeenPostId };
  return comparePosts(post, seen) > 0;
}

export function cacheScraperFactory(factory) {
  let scraperPromise;
  return async (source) => {
    if (!scraperPromise) {
      scraperPromise = Promise.resolve(factory(source)).catch((error) => {
        scraperPromise = undefined;
        throw error;
      });
    }
    return scraperPromise;
  };
}

export function retryAtFromRateLimit(error, now = Date.now()) {
  const resetAt = Number(error?.resetAt);
  return error?.name === 'RateLimitError' && Number.isFinite(resetAt) && resetAt > now ? resetAt : null;
}

export function mergeCookieHeaders(...headers) {
  const cookies = new Map();
  for (const header of headers.filter(Boolean)) {
    for (const entry of header.split(';')) {
      const separator = entry.indexOf('=');
      if (separator < 1) continue;
      cookies.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
    }
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export async function configuredXCookies({ cookieHeader = process.env.X_COOKIES || process.env.TWITTER_COOKIES, cookieFile = process.env.EARLYBIRD_X_COOKIES_FILE, readFileImpl = readFile } = {}) {
  const importedCookies = cookieFile ? await readFileImpl(cookieFile, 'utf8') : '';
  return mergeCookieHeaders(
    cookieHeader ? normalizeCookies(cookieHeader) : '',
    importedCookies ? normalizeCookies(importedCookies) : '',
  );
}

function sourceErrorMessage(error) {
  const retryAt = retryAtFromRateLimit(error);
  if (retryAt) return `X rate limited until ${new Date(retryAt).toISOString()}`;
  return String(error?.message || error).slice(0, 500);
}

async function recordPoll(prisma, data) {
  if (!prisma.earlyBirdPoll?.create) return;
  await prisma.earlyBirdPoll.create({ data });
}

export function createSourceMonitor({ prisma, queue, scraperFactory, now = () => new Date(), logger = console, pollTimeoutMs = Number(process.env.EARLYBIRD_SOURCE_POLL_TIMEOUT_MS || 30000) } = {}) {
  if (!prisma) throw new Error('source monitor requires prisma');
  return {
    async ensureDefaults() {
      for (const source of DEFAULT_SOURCES) {
        await prisma.earlyBirdSource.upsert({
          where: { handle: source.handle },
          update: {},
          create: { ...source, pollIntervalSeconds: 300 },
        });
      }
    },
    async pollSource(sourceId) {
      const source = await prisma.earlyBirdSource.findUnique({ where: { id: sourceId } });
      if (!source || !source.enabled) return { baseline: false, detected: 0 };
      try {
        const scraper = await withTimeout(scraperFactory(source), pollTimeoutMs);
        const posts = (await withTimeout(scraper.scrapeTweets(source.handle, { limit: 20, includeReplies: false }), pollTimeoutMs)) || [];
        const ordered = [...posts].sort((a, b) => comparePosts(a, b));
        if (!source.baselineComplete) {
          const newest = ordered.at(-1);
          if (!newest) {
            await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { baselineComplete: true, lastPolledAt: now(), lastError: null } });
            await recordPoll(prisma, { sourceId: source.id, outcome: 'baseline', detectedCount: 0, polledAt: now() });
            return { baseline: true, detected: 0 };
          }
          await prisma.earlyBirdSource.update({ where: { id: source.id }, data: {
            baselineComplete: true,
            lastSeenCreatedAt: newest?.createdAt ? new Date(newest.createdAt) : null,
            lastSeenPostId: newest?.id || null,
            lastPolledAt: now(), lastError: null,
          } });
          await recordPoll(prisma, { sourceId: source.id, outcome: 'baseline', detectedCount: 0, polledAt: now() });
          return { baseline: true, detected: 0 };
        }
        const fresh = ordered.filter(post => isNewer(post, source));
        let detected = 0;
        const postIds = [];
        for (const post of fresh) {
          const record = await prisma.earlyBirdPost.upsert({
            where: { sourceId_postId: { sourceId: source.id, postId: String(post.id) } },
            update: { rawData: post, text: post.text || '', createdAt: post.createdAt ? new Date(post.createdAt) : null, sourceUrl: `https://x.com/${source.handle}/status/${post.id}` },
            create: { sourceId: source.id, postId: String(post.id), rootPostId: String(post.id), sourceUrl: `https://x.com/${source.handle}/status/${post.id}`, authorUsername: post.author?.username || source.handle, text: post.text || '', createdAt: post.createdAt ? new Date(post.createdAt) : null, rawData: post, mediaData: post.media || [] },
          });
          const job = await prisma.earlyBirdArticleJob.upsert({ where: { postId: record.id }, update: {}, create: { sourceId: source.id, postId: record.id, status: 'detected' } });
          if (queue) await queue.add('process', { jobId: job.id }, {
            jobId: `earlybird-article-${job.id}`,
            delay: editorialBatchDelay(),
            ...ARTICLE_QUEUE_OPTIONS,
          });
          detected += 1;
          postIds.push(String(post.id));
        }
        const newest = ordered.at(-1);
        if (newest && (isNewer(newest, source))) await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { lastSeenCreatedAt: newest.createdAt ? new Date(newest.createdAt) : null, lastSeenPostId: newest.id, lastPolledAt: now(), lastError: null } });
        else await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { lastPolledAt: now(), lastError: null } });
        await recordPoll(prisma, { sourceId: source.id, outcome: detected ? 'detected' : 'no_new', detectedCount: detected, postIds: postIds.length ? postIds : undefined, polledAt: now() });
        return { baseline: false, detected };
      } catch (error) {
        const message = sourceErrorMessage(error);
        logger.error?.('EarlyBird source poll failed', source.handle, message);
        await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { lastPolledAt: now(), lastError: message } });
        await recordPoll(prisma, { sourceId: source.id, outcome: 'failed', detectedCount: 0, error: message, polledAt: now() });
        throw error;
      }
    },
    async pollAll() {
      const sources = await prisma.earlyBirdSource.findMany({ where: { enabled: true } });
      return Promise.all(sources.map(source => this.pollSource(source.id).catch(() => ({ baseline: false, detected: 0, failed: true }))));
    },
  };
}

export async function defaultScraperFactory() {
  const { createHttpScraper } = await import('../scrapers/twitter/http/index.js');
  const requestTimeoutMs = Number(process.env.EARLYBIRD_X_REQUEST_TIMEOUT_MS || 12000);
  return createHttpScraper({
    cookies: await configuredXCookies(),
    proxy: process.env.EARLYBIRD_X_PROXY || undefined,
    rateLimitStrategy: 'error',
    maxRetries: Number(process.env.EARLYBIRD_X_MAX_RETRIES || 1),
    fetch: (url, options = {}) => fetch(url, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs),
    }),
  });
}
