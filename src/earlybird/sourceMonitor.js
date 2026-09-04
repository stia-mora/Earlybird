import { DEFAULT_HANDLES, comparePosts } from './utils.js';

function isNewer(post, source) {
  if (!source.lastSeenCreatedAt && !source.lastSeenPostId) return true;
  const seen = { createdAt: source.lastSeenCreatedAt, id: source.lastSeenPostId };
  return comparePosts(post, seen) > 0;
}

export function createSourceMonitor({ prisma, queue, scraperFactory, now = () => new Date(), logger = console } = {}) {
  if (!prisma) throw new Error('source monitor requires prisma');
  return {
    async ensureDefaults() {
      for (const handle of DEFAULT_HANDLES) {
        await prisma.earlyBirdSource.upsert({
          where: { handle },
          update: {},
          create: { handle, displayName: handle, pollIntervalSeconds: 60 },
        });
      }
    },
    async pollSource(sourceId) {
      const source = await prisma.earlyBirdSource.findUnique({ where: { id: sourceId } });
      if (!source || !source.enabled) return { baseline: false, detected: 0 };
      try {
        const scraper = await scraperFactory(source);
        const posts = (await scraper.scrapeTweets(source.handle, { limit: 20, includeReplies: false })) || [];
        const ordered = [...posts].sort((a, b) => comparePosts(a, b));
        if (!source.baselineComplete) {
          const newest = ordered.at(-1);
          if (!newest) {
            await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { lastPolledAt: now(), lastError: null } });
            return { baseline: false, detected: 0 };
          }
          await prisma.earlyBirdSource.update({ where: { id: source.id }, data: {
            baselineComplete: true,
            lastSeenCreatedAt: newest?.createdAt ? new Date(newest.createdAt) : null,
            lastSeenPostId: newest?.id || null,
            lastPolledAt: now(), lastError: null,
          } });
          return { baseline: true, detected: 0 };
        }
        const fresh = ordered.filter(post => isNewer(post, source));
        let detected = 0;
        for (const post of fresh) {
          const record = await prisma.earlyBirdPost.upsert({
            where: { sourceId_postId: { sourceId: source.id, postId: String(post.id) } },
            update: { rawData: post, text: post.text || '', createdAt: post.createdAt ? new Date(post.createdAt) : null, sourceUrl: `https://x.com/${source.handle}/status/${post.id}` },
            create: { sourceId: source.id, postId: String(post.id), rootPostId: String(post.id), sourceUrl: `https://x.com/${source.handle}/status/${post.id}`, authorUsername: post.author?.username || source.handle, text: post.text || '', createdAt: post.createdAt ? new Date(post.createdAt) : null, rawData: post, mediaData: post.media || [] },
          });
          const job = await prisma.earlyBirdArticleJob.upsert({ where: { postId: record.id }, update: {}, create: { sourceId: source.id, postId: record.id, status: 'detected' } });
          if (queue) await queue.add('process', { jobId: job.id }, { jobId: `earlybird-article-${job.id}`, removeOnComplete: 100, removeOnFail: 100 });
          detected += 1;
        }
        const newest = ordered.at(-1);
        if (newest && (isNewer(newest, source))) await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { lastSeenCreatedAt: newest.createdAt ? new Date(newest.createdAt) : null, lastSeenPostId: newest.id, lastPolledAt: now(), lastError: null } });
        else await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { lastPolledAt: now(), lastError: null } });
        return { baseline: false, detected };
      } catch (error) {
        logger.error?.('EarlyBird source poll failed', source.handle, error);
        await prisma.earlyBirdSource.update({ where: { id: source.id }, data: { lastPolledAt: now(), lastError: error.message } });
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
  return createHttpScraper({ cookies: process.env.X_COOKIES || process.env.TWITTER_COOKIES });
}
