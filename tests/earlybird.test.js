import { describe, expect, it, vi } from 'vitest';
import { createSourceMonitor } from '../src/earlybird/sourceMonitor.js';
import { assembleThread } from '../src/earlybird/threadAssembler.js';
import { scoreHumanized } from '../src/earlybird/humanizer.js';
import { renderGzhMarkdown, validateGzhHtml } from '../src/earlybird/gzhRenderer.js';
import { createWeChatClient } from '../src/earlybird/wechatClient.js';
import { DEFAULT_SOURCES } from '../src/earlybird/utils.js';
import { classifyEditorial, normalizeEditorialDecision } from '../src/earlybird/editorialClassifier.js';
import { isOfficialUrl, normalizeSearchQueries, officialHosts } from '../src/earlybird/researchBrowser.js';
import { assertTweetEvidence, xBrowserCookies } from '../src/earlybird/evidenceCapture.js';
import { createArticlePipeline } from '../src/earlybird/pipeline.js';

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
  it('keeps a brief free of the default numbered section heading', async () => {
    const html = await renderGzhMarkdown('这是一条简短但完整的快讯。', { contentType: 'brief' });
    expect(html).not.toContain('>01<');
  });
});

describe('editorial triage', () => {
  const source = { handle: 'thsottiaux', website: 'https://openai.com' };
  const tiboPost = { id: 'p1', postId: '1', authorUsername: 'thsottiaux', text: 'Codex reset is now available for ChatGPT users.', sourceUrl: 'https://x.com/thsottiaux/status/1' };

  it('allows only the configured Tibo Codex reset or model-support brief', () => {
    const allowed = normalizeEditorialDecision({ publish: true, contentType: 'brief', newsworthiness: 90, reason: '产品变更' }, { post: tiboPost, source });
    const bankedReset = normalizeEditorialDecision({ publish: true, contentType: 'explainer', newsworthiness: 90, reason: '配额补偿' }, { post: { ...tiboPost, text: 'A banked reset lands today.' }, source });
    const denied = normalizeEditorialDecision({ publish: true, contentType: 'brief', newsworthiness: 90 }, { post: { ...tiboPost, text: 'A nice day at OpenAI.' }, source });
    expect(allowed.contentType).toBe('brief');
    expect(bankedReset.contentType).toBe('brief');
    expect(denied.contentType).toBe('ignore');
  });

  it('never turns replies or comments into an article', () => {
    const decision = normalizeEditorialDecision({ publish: true, contentType: 'explainer', newsworthiness: 99 }, { post: { ...tiboPost, rawData: { inReplyTo: { id: '0' } } }, source });
    expect(decision).toMatchObject({ contentType: 'ignore', publish: false });
  });

  it('requires a real candidate post before accepting an event story', () => {
    const post = { id: 'p1', text: 'launch' };
    const recentPosts = [{ id: 'p2', text: 'follow-up' }];
    const missing = normalizeEditorialDecision({ publish: true, contentType: 'event', newsworthiness: 90, relatedPostIds: ['missing'] }, { post, source: { handle: 'openai' }, recentPosts });
    const linked = normalizeEditorialDecision({ publish: true, contentType: 'event', newsworthiness: 90, relatedPostIds: ['p2'] }, { post, source: { handle: 'openai' }, recentPosts });
    expect(missing.contentType).toBe('explainer');
    expect(linked).toMatchObject({ contentType: 'event', relatedPostIds: ['p2'] });
  });

  it('passes only recent candidate summaries to the classifier', async () => {
    const client = { complete: vi.fn(async () => ({ publish: true, contentType: 'brief', newsworthiness: 90, reason: 'Codex reset' })) };
    await classifyEditorial({ client, post: tiboPost, source, recentPosts: [{ id: 'p2', authorUsername: 'openai', text: 'candidate' }] });
    const payload = JSON.parse(client.complete.mock.calls[0][0].user);
    expect(payload.recentCandidates).toEqual([expect.objectContaining({ id: 'p2', text: 'candidate' })]);
  });
});

describe('controlled evidence and research', () => {
  it('translates the configured cookie header into X browser cookies', () => {
    expect(xBrowserCookies('auth_token=a; ct0=b')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'auth_token', value: 'a', url: 'https://x.com/' }),
      expect.objectContaining({ name: 'ct0', value: 'b', url: 'https://x.com/' }),
    ]));
  });
  it('blocks denied or empty pages from becoming evidence screenshots', () => {
    expect(() => assertTweetEvidence({ pageText: 'Access to x.com was denied', articleText: 'anything' })).toThrow(/denied access/i);
    expect(() => assertTweetEvidence({ pageText: 'normal', articleText: '' })).toThrow(/empty/i);
    expect(() => assertTweetEvidence({ pageText: 'normal', articleText: 'target X post' })).not.toThrow();
  });
  it('limits research to official HTTPS domains and bounded queries', () => {
    const hosts = officialHosts(['https://openai.com', 'https://www.anthropic.com']);
    expect(isOfficialUrl('https://cdn.openai.com/image.jpg', hosts)).toBe(true);
    expect(isOfficialUrl('https://openai.com.evil.example/article', hosts)).toBe(false);
    expect(isOfficialUrl('http://openai.com/article', hosts)).toBe(false);
    expect(normalizeSearchQueries(['  Codex reset  ', '', 'Codex reset', 'x'.repeat(121)])).toEqual(['Codex reset']);
  });
});

describe('event story pipeline', () => {
  it('merges an eligible candidate and collects media for every story post', async () => {
    const originalThreadWait = process.env.EARLYBIRD_THREAD_WAIT_MS;
    process.env.EARLYBIRD_THREAD_WAIT_MS = '0';
    const post = { id: 'p1', postId: '1', authorUsername: 'openai', sourceUrl: 'https://x.com/openai/status/1', text: 'Primary announcement', rawData: { id: '1', text: 'Primary announcement' }, createdAt: new Date('2026-09-05T00:00:00Z') };
    const related = { id: 'p2', postId: '2', authorUsername: 'geminiapp', sourceUrl: 'https://x.com/geminiapp/status/2', text: 'Related official detail', rawData: { id: '2', text: 'Related official detail' }, createdAt: new Date('2026-09-05T00:10:00Z'), source: { handle: 'geminiapp', website: 'https://gemini.google.com' }, jobs: [] };
    const job = { id: 'j1', status: 'detected', metadata: null, postId: post.id, sourceId: 's1', post, source: { handle: 'openai', website: 'https://openai.com' }, draft: null };
    const updates = [];
    const prisma = {
      earlyBirdArticleJob: {
        findUnique: vi.fn(async () => job),
        update: vi.fn(async ({ data }) => { updates.push(data); return { ...job, ...data }; }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      earlyBirdPost: {
        update: vi.fn(async () => post),
        findMany: vi.fn(async () => [related]),
      },
    };
    const collect = vi.fn(async ({ post: target }) => []);
    const llmClient = { complete: vi.fn(async ({ system }) => {
      if (system.includes('微信公众号总编辑')) return { publish: true, contentType: 'event', newsworthiness: 90, relatedPostIds: ['p2'], reason: '同一发布事件', searchQueries: [] };
      if (system.includes('Humanizer-zh')) return { markdown: '## 一条线索\n\n两条官方动态构成同一事件。', score: 48 };
      return { title: '合并后的官方动态', digest: '两条官方动态构成同一事件。', markdown: '## 一条线索\n\n两条官方动态构成同一事件。' };
    }) };
    const pipeline = createArticlePipeline({
      prisma,
      scraperFactory: async () => ({ scrapeFullThread: async () => [post.rawData] }),
      llmClient,
      wechatClient: null,
      mediaPipeline: { collect },
      evidence: vi.fn(async () => ({ path: 'evidence.png' })),
      analyze: vi.fn(async () => ({ translation: '中文翻译', digest: '两条官方动态构成同一事件。', facts: ['两个官方账号先后发布关联信息。'] })),
    });

    try {
      const result = await pipeline.process(job.id);

      expect(result.status).toBe('rendered');
      expect(collect).toHaveBeenCalledWith(expect.objectContaining({ post }));
      expect(collect).toHaveBeenCalledWith(expect.objectContaining({ post: related }));
      expect(prisma.earlyBirdArticleJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'merged' } }));
    } finally {
      if (originalThreadWait === undefined) delete process.env.EARLYBIRD_THREAD_WAIT_MS;
      else process.env.EARLYBIRD_THREAD_WAIT_MS = originalThreadWait;
    }
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
