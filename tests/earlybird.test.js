import { describe, expect, it, vi } from 'vitest';
import { createSourceMonitor } from '../src/earlybird/sourceMonitor.js';
import { assembleThread } from '../src/earlybird/threadAssembler.js';
import { scoreHumanized } from '../src/earlybird/humanizer.js';
import { renderGzhMarkdown, validateGzhHtml } from '../src/earlybird/gzhRenderer.js';
import { createWeChatClient } from '../src/earlybird/wechatClient.js';
import { DEFAULT_SOURCES } from '../src/earlybird/utils.js';

function prismaFixture() {
  const sources = [{ id: 's1', handle: 'openai', enabled: true, baselineComplete: false, lastSeenCreatedAt: null, lastSeenPostId: null }];
  const posts = new Map();
  const jobs = new Map();
  return {
    earlyBirdSource: {
      upsert: vi.fn(async ({ create }) => sources[0]),
      findUnique: vi.fn(async () => sources[0]),
      findMany: vi.fn(async () => sources),
      update: vi.fn(async ({ data }) => Object.assign(sources[0], data)),
    },
    earlyBirdPost: {
      upsert: vi.fn(async ({ create }) => { const item = { id: `p${posts.size + 1}`, ...create }; posts.set(item.id, item); return item; }),
    },
    earlyBirdArticleJob: { upsert: vi.fn(async ({ create }) => { const item = { id: `j${jobs.size + 1}`, ...create }; jobs.set(item.id, item); return item; }) },
  };
}

describe('EarlyBird source monitor', () => {
  it('seeds the configured AI sources with their official websites', async () => {
    const prisma = prismaFixture();
    const monitor = createSourceMonitor({ prisma, scraperFactory: vi.fn() });
    await monitor.ensureDefaults();
    expect(prisma.earlyBirdSource.upsert).toHaveBeenCalledTimes(DEFAULT_SOURCES.length);
    expect(prisma.earlyBirdSource.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ handle: 'openai', website: 'https://openai.com' }),
    }));
  });

  it('builds a baseline without enqueueing historical posts', async () => {
    const prisma = prismaFixture();
    const queue = { add: vi.fn() };
    const monitor = createSourceMonitor({ prisma, queue, scraperFactory: async () => ({ scrapeTweets: async () => [{ id: '10', createdAt: '2026-01-01T00:00:00Z', text: 'old' }] }) });
    const result = await monitor.pollSource('s1');
    expect(result).toEqual({ baseline: true, detected: 0 });
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.earlyBirdSource.update).toHaveBeenCalled();
  });

  it('completes an empty baseline so the first future post is detected', async () => {
    const prisma = prismaFixture();
    const monitor = createSourceMonitor({ prisma, scraperFactory: async () => ({ scrapeTweets: async () => [] }) });

    const result = await monitor.pollSource('s1');

    expect(result).toEqual({ baseline: true, detected: 0 });
    expect(prisma.earlyBirdSource.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ baselineComplete: true }),
    }));
  });
});

describe('thread assembly and humanizer', () => {
  it('sorts a complete thread chronologically', async () => {
    const tweets = await assembleThread({ scraper: { scrapeFullThread: async () => [{ id: '2', createdAt: '2026-01-01T00:01:00Z' }, { id: '1', createdAt: '2026-01-01T00:00:00Z' }] }, post: { postId: '1' }, waitMs: 0 });
    expect(tweets.map(tweet => tweet.id)).toEqual(['1', '2']);
  });
  it('keeps the root post and author replies from the HTTP thread response', async () => {
    const tweets = await assembleThread({
      scraper: { scrapeFullThread: async () => ({ rootTweet: { id: '1', createdAt: '2026-01-01T00:00:00Z' }, authorReplies: [{ id: '2', createdAt: '2026-01-01T00:01:00Z' }] }) },
      post: { postId: '1' },
      waitMs: 0,
    });
    expect(tweets.map(tweet => tweet.id)).toEqual(['1', '2']);
  });
  it('falls back to the captured root post when thread collection fails', async () => {
    const post = { postId: '1', rawData: { id: '1', text: 'root' } };
    const tweets = await assembleThread({ scraper: { scrapeFullThread: async () => { throw new Error('rate limited'); } }, post, waitMs: 0, logger: { warn: vi.fn() } });
    expect(tweets).toEqual([post.rawData]);
  });
  it('penalizes common AI traces', () => {
    expect(scoreHumanized('值得注意的是，在当今生态中不仅如此而且如此。')).toBeLessThan(45);
  });
});

describe('Graphite renderer', () => {
  it('renders a compliant section without forbidden tags', async () => {
    const html = await renderGzhMarkdown('# 标题\n\n## 事件事实\n\n这是一段需要标记关键词的中文内容。', { title: '标题', digest: '摘要' });
    expect(html.startsWith('<section')).toBe(true);
    expect(html).not.toMatch(/<div|<style|<script|position:\s*(absolute|fixed|sticky)/i);
    expect(html).toContain('leaf=');
  });
  it('blocks HTML that has validator warnings before a draft can be created', async () => {
    await expect(validateGzhHtml('<section><p>中文,半角标点</p></section>', { run: async () => 'WARNING ×1' })).rejects.toThrow('gzh HTML validation failed');
  });
  it('accepts a clean validator result', async () => {
    await expect(validateGzhHtml('<section><p><span leaf="">中文。</span></p></section>', { run: async () => '完全合规' })).resolves.toBe('完全合规');
  });
});

describe('WeChat client', () => {
  it('caches access tokens and verifies draft calls', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/cgi-bin/token')) return new Response(JSON.stringify({ access_token: 't1', expires_in: 7200 }), { status: 200 });
      if (url.includes('/draft/add')) return new Response(JSON.stringify({ media_id: 'm1' }), { status: 200 });
      return new Response(JSON.stringify({ media_id: 'm1', news_item: [{}] }), { status: 200 });
    });
    const client = createWeChatClient({ appId: 'a', appSecret: 's', fetchImpl, apiBase: 'https://wechat.test' });
    await client.accessToken();
    await client.addDraft({ title: '标题', content: '<p>内容</p>', thumb_media_id: 'thumb' });
    await client.getDraft('m1');
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes('/cgi-bin/token'))).toHaveLength(1);
    expect(calls.some(call => call.url.includes('/draft/add'))).toBe(true);
  });
});
