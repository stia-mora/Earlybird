// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheScraperFactory, configuredXCookies, createSourceMonitor, editorialBatchDelay, mergeCookieHeaders, retryAtFromRateLimit } from '../src/earlybird/sourceMonitor.js';
import { startupPollDelay } from '../src/earlybird/sourcePollTiming.js';
import { analyzePost, createMultimodalClient } from '../src/earlybird/aiPipeline.js';
import { assembleThread } from '../src/earlybird/threadAssembler.js';
import { humanize, scoreHumanized } from '../src/earlybird/humanizer.js';
import { assertGzhTypography, renderGzhMarkdown, validateGzhHtml } from '../src/earlybird/gzhRenderer.js';
import { createWeChatClient, prepareWechatUpload } from '../src/earlybird/wechatClient.js';
import { comparePosts, DEFAULT_SOURCES, fullWidthPunctuation, sanitizeJsonUnicode } from '../src/earlybird/utils.js';
import { assertTweetEvidence, xBrowserCookies } from '../src/earlybird/evidenceCapture.js';
import { createArticlePipeline, replaceManagedDrafts } from '../src/earlybird/pipeline.js';
import { articleVisualAssets, compactEditorialMarkdown, createArticleWriter, editorialStructureIssues, hasCompactPresentation, markdownBodyLength, markdownHeadingCount, MAX_PARAGRAPH_LENGTH, sanitizeEditorialMarkdown, varyEditorialParagraphs } from '../src/earlybird/articleWriter.js';
import { enqueueInterruptedJobs, enqueueLegacyEditorialJobs } from '../src/earlybird/jobRecovery.js';
import { buildDailySummary } from '../src/earlybird/dailySummary.js';
import { createHermesNotifier } from '../src/earlybird/hermesNotifier.js';
import { availableFixedEndVisuals } from '../src/earlybird/fixedEndVisuals.js';
import { buildCoverPrompt, createCoverImageGenerator, normalizeCoverImage, WECHAT_COVER_SIZE } from '../src/earlybird/coverImage.js';
import { createEditorialOrchestrator, createEditorialReviewer, draftQualityIssues, normalizeEditorialDecision } from '../src/earlybird/editorialReview.js';
import { gatherEditorialResearch, normalizeResearchPlan, selectEditorialResearch } from '../src/earlybird/editorialResearch.js';
import { createEditorialXSearch } from '../src/earlybird/xResearchSearch.js';
import { collectTavilyImages, createTavilyImageSearch, normalizeTavilyImageResult } from '../src/earlybird/tavilyImageSearch.js';

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
  it('treats a post at the saved cursor as already seen', () => {
    const post = { id: '2096133504417616165', createdAt: '2026-09-05T07:09:06.000Z' };
    expect(comparePosts(post, post)).toBe(0);
  });

  it('reuses one authenticated scraper across source polls', async () => {
    const scraper = { scrapeTweets: vi.fn() };
    const factory = vi.fn(async () => scraper);
    const cached = cacheScraperFactory(factory);

    await Promise.all([cached({ handle: 'openai' }), cached({ handle: 'anthropicai' })]);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('waits for X rate-limit reset instead of immediately retrying', () => {
    expect(retryAtFromRateLimit({ name: 'RateLimitError', resetAt: 2_000 }, 1_000)).toBe(2_000);
    expect(retryAtFromRateLimit({ name: 'RateLimitError', resetAt: 1_000 }, 1_000)).toBeNull();
    expect(retryAtFromRateLimit({ name: 'AuthError', resetAt: 2_000 }, 1_000)).toBeNull();
  });

  it('merges an imported Netscape cookie export over the configured header', async () => {
    expect(mergeCookieHeaders('auth_token=old; ct0=old', 'auth_token=new; lang=zh')).toBe('auth_token=new; ct0=old; lang=zh');
    await expect(configuredXCookies({
      cookieHeader: 'auth_token=old; ct0=old',
      cookieFile: '/cookies.txt',
      readFileImpl: async () => '.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tnew\n.x.com\tTRUE\t/\tTRUE\t0\tlang\tzh',
    })).resolves.toBe('auth_token=new; ct0=old; lang=zh');
  });

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

  it('times out a stalled source poll and records the failure', async () => {
    const prisma = prismaFixture();
    const monitor = createSourceMonitor({
      prisma,
      pollTimeoutMs: 1,
      logger: { error: vi.fn() },
      scraperFactory: async () => ({ scrapeTweets: async () => new Promise(() => {}) }),
    });

    await expect(monitor.pollSource('s1')).rejects.toThrow('source poll timed out after 1ms');
    expect(prisma.earlyBirdSource.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: 'source poll timed out after 1ms' }),
    }));
  });

  it('records a visible no-new result for every successful empty poll', async () => {
    const source = { id: 's1', handle: 'openai', enabled: true, baselineComplete: true, lastSeenCreatedAt: new Date('2026-01-01T00:00:00Z'), lastSeenPostId: '1' };
    const prisma = {
      earlyBirdSource: { findUnique: vi.fn(async () => source), update: vi.fn(async () => source) },
      earlyBirdPoll: { create: vi.fn(async ({ data }) => data) },
    };
    const monitor = createSourceMonitor({ prisma, scraperFactory: async () => ({ scrapeTweets: async () => [] }), now: () => new Date('2026-01-01T00:01:00Z') });
    await expect(monitor.pollSource('s1')).resolves.toEqual({ baseline: false, detected: 0 });
    expect(prisma.earlyBirdPoll.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceId: 's1', outcome: 'no_new', detectedCount: 0 }) });
  });

  it('retries newly detected article jobs when a downstream stage fails', async () => {
    const source = { id: 's1', handle: 'openai', enabled: true, baselineComplete: true, lastSeenCreatedAt: new Date('2026-01-01T00:00:00Z'), lastSeenPostId: '1' };
    const queue = { add: vi.fn(async () => {}) };
    const prisma = {
      earlyBirdSource: { findUnique: vi.fn(async () => source), update: vi.fn(async () => source) },
      earlyBirdPost: { upsert: vi.fn(async () => ({ id: 'p2' })) },
      earlyBirdArticleJob: { upsert: vi.fn(async () => ({ id: 'j2' })) },
    };
    const monitor = createSourceMonitor({ prisma, queue, scraperFactory: async () => ({ scrapeTweets: async () => [{ id: '2', createdAt: '2026-01-01T00:01:00Z', text: 'new' }] }) });

    await monitor.pollSource('s1');

    expect(queue.add).toHaveBeenCalledWith('process', { jobId: 'j2' }, expect.objectContaining({
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
    }));
  });

  it('holds each new post until the next editorial batch boundary', () => {
    expect(editorialBatchDelay(1_800_000, 1_800_000)).toBe(0);
    expect(editorialBatchDelay(1_800_001, 1_800_000)).toBe(1_799_999);
  });
});

describe('EarlyBird Hermes notifications', () => {
  it('sends a verified draft through the local Hermes relay', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '{"status":"sent"}' }));
    const notifier = createHermesNotifier({ url: 'http://relay/notify', token: 'test-token', fetchImpl });
    await notifier.draftReady({
      job: { id: 'j1', metadata: { editorial: { contentType: 'explainer' } } },
      draft: { mediaId: 'media-1', requestSummary: { title: '测试草稿' } },
      source: { handle: 'openai' },
      post: { postId: '1' },
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://relay/notify', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer test-token' }),
      body: expect.stringContaining('测试草稿'),
    }));
  });

  it('tells the editor where to manually upload downloaded videos', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '{"status":"sent"}' }));
    const notifier = createHermesNotifier({ url: 'http://relay/notify', token: 'test-token', hostMediaDir: 'E:/EarlyBird/media', fetchImpl });
    await notifier.draftReady({
      job: { id: 'j2', metadata: { editorial: { contentType: 'explainer' } } },
      draft: { mediaId: 'media-2', requestSummary: { title: '视频草稿' } },
      source: { handle: 'grok' },
      post: { postId: '2' },
      manualVideoFiles: ['2-video.mp4'],
    });
    const body = fetchImpl.mock.calls[0][1].body;
    expect(body).toContain('未自动上传至微信素材库');
    expect(body).toContain('E:/EarlyBird/media');
    expect(body).toContain('2-video.mp4');
  });

  it('summarizes today’s drafts and legacy jobs that were filtered before the policy change', async () => {
    const prisma = {
      earlyBirdSource: { findMany: vi.fn(async () => [{ id: 's1', handle: 'openai' }, { id: 's2', handle: 'geminiapp' }]) },
      earlyBirdPost: { findMany: vi.fn(async () => [
        { sourceId: 's1', postId: '1', text: '已制作为草稿的消息', source: { handle: 'openai' }, jobs: [{ status: 'verified', draft: { verified: true } }] },
        { sourceId: 's1', postId: '2', text: '不应制作为草稿的对话', source: { handle: 'openai' }, jobs: [{ status: 'ignored', metadata: { editorial: { reason: '只是日常对话，没有独立新闻价值。' } } }] },
        { sourceId: 's2', postId: '3', text: '关联动态', source: { handle: 'geminiapp' }, jobs: [{ status: 'merged' }] },
      ]) },
    };
    const summary = await buildDailySummary({ prisma, now: new Date('2026-09-05T12:00:00Z') });
    expect(summary).toMatchObject({ detectedPosts: 3, verifiedDrafts: 1 });
    expect(summary.message).toContain('旧版筛选历史');
    expect(summary.message).toContain('旧版事件合并历史');
  });
});

describe('EarlyBird source timing', () => {
  it('spreads rate-limited sources over a five-minute recovery window', () => {
    const source = { pollIntervalSeconds: 300, lastError: 'X rate limited until 2026-09-05T09:00:00.000Z' };
    expect(startupPollDelay(source, { index: 0, total: 10, now: Date.parse('2026-09-05T08:55:00.000Z'), random: () => 0 })).toBe(300000);
    expect(startupPollDelay(source, { index: 9, total: 10, now: Date.parse('2026-09-05T08:55:00.000Z'), random: () => 0.5 })).toBe(585000);
  });

  it('calculates startup poll delay when lastPolledAt is a Date instance or ISO string', () => {
    const now = 1700000000000;
    const dateSource = { pollIntervalSeconds: 300, lastPolledAt: new Date(now - 100000) };
    const strSource = { pollIntervalSeconds: 300, lastPolledAt: new Date(now - 100000).toISOString() };
    const expected = (300 * 1000) - 100000;
    expect(startupPollDelay(dateSource, { index: 0, total: 1, now, random: () => 0 })).toBe(expected);
    expect(startupPollDelay(strSource, { index: 0, total: 1, now, random: () => 0 })).toBe(expected);
  });
});

describe('EarlyBird job recovery', () => {
  it('requeues only jobs interrupted by a worker termination', async () => {
    const prisma = {
      earlyBirdArticleJob: {
        findMany: vi.fn(async () => [{ id: 'j1' }, { id: 'j2' }]),
      },
    };
    const queue = { add: vi.fn(async () => {}) };

    const recovered = await enqueueInterruptedJobs({ prisma, queue, now: () => 1000 });

    expect(recovered).toBe(2);
    expect(prisma.earlyBirdArticleJob.findMany).toHaveBeenCalledWith({
      where: { status: 'failed', error: { contains: 'terminated', mode: 'insensitive' } },
      select: { id: true },
    });
    expect(queue.add).toHaveBeenNthCalledWith(1, 'process', { jobId: 'j1' }, expect.objectContaining({
      jobId: 'earlybird-article-recovery-j1-1000', delay: 10000,
    }));
    expect(queue.add).toHaveBeenNthCalledWith(2, 'process', { jobId: 'j2' }, expect.objectContaining({
      jobId: 'earlybird-article-recovery-j2-1000', delay: 11000,
    }));
  });

  it('requeues jobs excluded by the previous editorial policy', async () => {
    const prisma = {
      earlyBirdArticleJob: {
        findMany: vi.fn(async () => [{ id: 'j1' }, { id: 'j2' }]),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
    };
    const queue = { add: vi.fn(async () => {}) };

    const requeued = await enqueueLegacyEditorialJobs({ prisma, queue, now: () => 1000 });

    expect(requeued).toBe(2);
    expect(prisma.earlyBirdArticleJob.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['ignored', 'merged', 'held'] }, draft: null },
      select: { id: true },
    });
    expect(prisma.earlyBirdArticleJob.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['j1', 'j2'] } }, data: { status: 'detected', error: null },
    });
    expect(queue.add).toHaveBeenNthCalledWith(1, 'process', { jobId: 'j1' }, expect.objectContaining({
      jobId: 'earlybird-article-policy-retry-j1-1000', delay: 10000,
    }));
  });
});

describe('independent editorial review', () => {
  const job = { id: 'j-current', post: { postId: '101', authorUsername: 'openai', sourceUrl: 'https://x.com/openai/status/101', text: 'OpenAI 发布了一项新的代理能力。' }, source: { handle: 'openai' }, metadata: {} };
  const candidate = { id: 'j-related', post: { postId: '102', authorUsername: 'openai', sourceUrl: 'https://x.com/openai/status/102', text: '同一代理能力补充了开放范围。' }, source: { handle: 'openai' }, metadata: {} };

  it('rejects a merge that does not identify a real candidate task', () => {
    const decision = normalizeEditorialDecision({ decision: 'merge', contentType: 'event', relatedJobIds: ['missing'] }, { job, candidates: [candidate] });
    expect(decision.decision).toBe('rewrite');
    expect(decision.contentType).toBe('explainer');
    expect(decision.issues).toContain('合稿决定未给出可关联的候选内容');
  });

  it('requires an active research pass for explainer and event plans', () => {
    const decision = normalizeEditorialDecision({ decision: 'pass', contentType: 'explainer', qualityScore: 85, researchPlan: {} }, { job, candidates: [candidate] });
    expect(decision.researchPlan.xQueries).toHaveLength(1);
    expect(decision.researchPlan.webQueries).toHaveLength(1);
    expect(decision.researchPlan.webQueries[0].scope).toBe('official');
  });

  it('normalizes compatible-model five-point quality grades to the 100-point scale', () => {
    const decision = normalizeEditorialDecision({ decision: 'pass', contentType: 'brief', qualityScore: 5, issues: [] }, { job, candidates: [], phase: 'draft' });
    expect(decision.qualityScore).toBe(100);
    expect(decision.decision).toBe('pass');
  });

  it('keeps editor and draft review decisions separate', async () => {
    const client = { complete: vi.fn()
      .mockResolvedValueOnce({ decision: 'merge', contentType: 'event', qualityScore: 91, relatedJobIds: ['j-related'], visualPlan: [] })
      .mockResolvedValueOnce({ decision: 'pass', contentType: 'brief', qualityScore: 94, issues: [], visualPlan: [] }) };
    const reviewer = createEditorialReviewer({ client });
    const triage = await reviewer.triage({ job, candidates: [candidate] });
    expect(triage).toMatchObject({ decision: 'merge', contentType: 'event', relatedJobIds: ['j-related'] });
    const text = Array.from({ length: 4 }, () => '官方说明明确了产品范围、开发者接入方式和需要继续观察的开放节奏。'.repeat(3)).join('\n\n');
    const draft = await reviewer.reviewDraft({ job, article: { markdown: `![图](image.jpg)\n\n${text}` }, editorial: { contentType: 'brief' }, storyPosts: [job], assets: [{ kind: 'image', localPath: 'image.jpg' }], references: ['https://x.com/openai/status/101'] });
    expect(draft).toMatchObject({ decision: 'pass', qualityScore: 94 });
    expect(client.complete.mock.calls[0][0].system).toContain('总编辑');
    expect(client.complete.mock.calls[1][0].system).toContain('独立于写作 Agent');
  });

  it('removes malformed Unicode from editorial JSON while preserving valid emoji', () => {
    const decision = normalizeEditorialDecision({
      decision: 'pass', contentType: 'brief', qualityScore: 90,
      visualPlan: [{ query: `model demo \uD83D`, purpose: '说明能力', altText: '演示' }],
    }, { job, candidates: [] });

    expect(decision.visualPlan[0].query).toBe('model demo �');
    expect(sanitizeJsonUnicode({ nested: ['valid 😀', 'broken \uDC00'] })).toEqual({ nested: ['valid 😀', 'broken �'] });
    expect(JSON.stringify(decision)).not.toContain('\\ud83d');
  });

  it('flags a draft with insufficient body, images, or sources before model approval', () => {
    const issues = draftQualityIssues({ markdown: '很短的说明。', contentType: 'explainer', assets: [], references: [] });
    expect(issues).toEqual(expect.arrayContaining(['正文不足 1200 个中文字符', '需要至少 5 张可用正文图片', '缺少可核查的来源链接']));
  });

  it('lets the orchestrator select only evidence returned by its bounded research plan', async () => {
    const client = { complete: vi.fn(async () => ({
      decision: 'pass', contentType: 'explainer', qualityScore: 88,
      selectedResearchUrls: ['https://x.com/openai/status/200', 'https://not-returned.example/article'],
      visualPlan: [], researchPlan: { xQueries: [], webQueries: [] },
    })) };
    const orchestrator = createEditorialOrchestrator({ client });
    const research = {
      xEvidence: [{ kind: 'x', id: 'x:200', url: 'https://x.com/openai/status/200', author: 'openai', text: '官方补充了开放范围。' }],
      webEvidence: [{ kind: 'web', id: 'web:https://openai.com/blog', url: 'https://openai.com/blog', title: '官方说明', excerpt: '官方网页说明。', sourceDomain: 'openai.com' }],
      failures: [],
    };
    const decision = await orchestrator.coordinate({ job, candidates: [candidate], triage: { decision: 'rewrite' }, research });
    expect(decision.selectedResearchUrls).toEqual(['https://x.com/openai/status/200']);
    expect(client.complete.mock.calls[0][0].system).toContain('主动检索');
  });
});

describe('editorial research', () => {
  it('limits duplicate research queries and normalizes their shape', () => {
    const plan = normalizeResearchPlan({
      xQueries: ['OpenAI agent', 'OpenAI agent', 'query 2', 'query 3', 'query 4'],
      webQueries: [{ query: 'OpenAI official announcement', purpose: '核实事实' }, { query: 'query 2' }, { query: 'query 3' }, { query: 'query 4' }],
    });
    expect(plan.xQueries).toHaveLength(3);
    expect(plan.xQueries[0]).toEqual({ query: 'OpenAI agent', purpose: '', scope: 'official' });
    expect(plan.webQueries).toHaveLength(3);
  });

  it('collects read-only X and Tavily evidence with their query provenance', async () => {
    const tavilySearch = { configured: true, searchWeb: vi.fn(async () => [{ title: '官方公告', url: 'https://openai.com/news', sourceDomain: 'openai.com', excerpt: '官方说明了适用范围。', query: 'OpenAI agents official' }]) };
    const research = await gatherEditorialResearch({
      plan: { xQueries: [{ query: 'OpenAI agents', purpose: '寻找原始公告' }], webQueries: [{ query: 'OpenAI agents official', purpose: '核对范围' }] },
      source: { handle: 'openai', website: 'https://openai.com' },
      scraperFactory: async () => ({ searchTweets: vi.fn(async () => [{ id: 'x-1', text: '官方发布代理能力。', createdAt: '2026-09-11T00:00:00Z', author: { username: 'openai' }, media: [] }]) }),
      tavilySearch,
    });
    expect(research.xEvidence).toEqual([expect.objectContaining({ url: 'https://x.com/openai/status/x-1', query: 'OpenAI agents' })]);
    expect(research.webEvidence).toEqual([expect.objectContaining({ url: 'https://openai.com/news', sourceDomain: 'openai.com' })]);
    expect(research.webEvidence).toHaveLength(1);
    expect(tavilySearch.searchWeb).toHaveBeenCalledWith('OpenAI agents official', { count: 4, includeDomains: ['openai.com'] });
    const selected = selectEditorialResearch(research, ['https://openai.com/news']);
    expect(selected.xEvidence).toEqual([]);
    expect(selected.citations).toEqual([expect.objectContaining({ url: 'https://openai.com/news' })]);
  });

  it('falls back to browser X search when SearchTimeline is unavailable', async () => {
    const browserSearch = vi.fn(async () => [{ id: 'browser-1', text: '浏览器搜索到官方更新。', author: { username: 'openai' }, media: [] }]);
    const xSearch = createEditorialXSearch({
      scraperFactory: async () => ({ searchTweets: async () => { throw new Error('HTTP 404: Not Found'); } }),
      cookieLoader: async () => 'auth_token=test; ct0=test',
      browserSearch,
      logger: { warn: vi.fn() },
    });
    const result = await xSearch.search('from:openai', { source: { handle: 'openai' }, limit: 2 });
    expect(result).toMatchObject({ method: 'browser', tweets: [expect.objectContaining({ id: 'browser-1' })] });
    expect(browserSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'from:openai', limit: 2 }));
  });
});

describe('Tavily image sourcing', () => {
  it('normalizes searchable image metadata with both original and source page URLs', () => {
    expect(normalizeTavilyImageResult({ url: 'https://cdn.example/launch.png', title: '发布会图片', description: '产品发布配图' }, 'OpenAI launch', 'https://news.example/article')).toMatchObject({
      imageUrl: 'https://cdn.example/launch.png', sourcePageUrl: 'https://news.example/article', sourceDomain: 'news.example', description: '产品发布配图',
    });
  });

  it('uses the Tavily endpoint and records image attribution for downloaded assets', async () => {
    const searchFetch = vi.fn(async () => new Response(JSON.stringify({ images: [{ url: 'https://cdn.example/launch.png', title: '发布会图片', description: '产品发布配图' }] }), { status: 200 }));
    const search = createTavilyImageSearch({ apiKey: 'tavily-key', fetchImpl: searchFetch });
    await expect(search.search('OpenAI launch')).resolves.toHaveLength(1);
    expect(searchFetch.mock.calls[0][1].headers.authorization).toBe('Bearer tavily-key');
    expect(JSON.parse(searchFetch.mock.calls[0][1].body)).toMatchObject({ include_images: true, include_image_descriptions: true });
    const outputDir = await mkdtemp(join(tmpdir(), 'earlybird-tavily-'));
    const assets = await collectTavilyImages({
      search: { configured: true, search: async () => [{ imageUrl: 'https://cdn.example/launch.png', sourcePageUrl: 'https://news.example/article', sourceDomain: 'news.example', title: '发布会图片', query: 'OpenAI launch' }] },
      post: { id: 'p-tavily', postId: 'tavily-post' }, visualPlan: [{ query: 'OpenAI launch', purpose: '说明发布', altText: '发布会图片' }], needed: 1, outputDir,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    expect(assets[0]).toMatchObject({ kind: 'web-image', metadata: expect.objectContaining({ provider: 'tavily-search', sourcePageUrl: 'https://news.example/article', sourceDomain: 'news.example', attribution: '图片来源：news.example' }) });
  });
});

describe('managed WeChat draft replacement', () => {
  it('keeps both draft identifiers auditable when old-draft deletion fails', async () => {
    const replacements = { create: vi.fn(async () => ({ id: 'replacement-1' })), update: vi.fn(async () => ({})) };
    const drafts = { update: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) };
    const result = await replaceManagedDrafts({
      prisma: { earlyBirdDraftReplacement: replacements, earlyBirdDraft: drafts },
      wechatClient: { deleteDraft: vi.fn(async () => { throw new Error('wechat unavailable'); }) },
      primaryJob: { id: 'j-primary' },
      storyJobs: [{ id: 'j-primary', draft: { id: 'd-old', mediaId: 'old-media', deletedAt: null } }],
      draft: { media_id: 'new-media' }, verified: { media_id: 'new-media' }, requestSummary: { title: '新稿' },
    });
    expect(result.failure).toContain('old-media');
    expect(replacements.create).toHaveBeenCalledWith({ data: expect.objectContaining({ oldMediaId: 'old-media', newMediaId: 'new-media' }) });
    expect(replacements.update).toHaveBeenCalledWith({ where: { id: 'replacement-1' }, data: expect.objectContaining({ status: 'delete_failed' }) });
    expect(drafts.update).toHaveBeenCalledWith({ where: { id: 'd-old' }, data: expect.objectContaining({ deleteError: 'wechat unavailable' }) });
    expect(drafts.upsert).not.toHaveBeenCalled();
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
  it('does not let humanization collapse an event story into a summary', async () => {
    const markdown = `## 时间线\n\n${'官方消息提供了可核查的时间线与发布范围。'.repeat(70)}`;
    const result = await humanize({ client: { complete: async () => ({ markdown: '一句摘要。', score: 50 }) }, markdown, context: { editorial: { contentType: 'event' } } });
    expect(markdownBodyLength(result.markdown)).toBe(markdownBodyLength(markdown));
    expect(markdownHeadingCount(result.markdown)).toBe(markdownHeadingCount(markdown));
    expect(hasCompactPresentation(result.markdown)).toBe(true);
  });
  it('makes video posters and keyframes available as article evidence', () => {
    const visuals = articleVisualAssets([{ id: 'v1', kind: 'video', sourceUrl: 'https://x.com/video', metadata: { posterPath: 'poster.jpg', keyframes: ['frame-1.jpg', 'frame-2.jpg'] } }]);
    expect(visuals.map(item => item.localPath)).toEqual(['poster.jpg', 'frame-1.jpg', 'frame-2.jpg']);
  });
  it('keeps X post screenshots alongside downloaded media', () => {
    const visuals = articleVisualAssets([{ kind: 'x-post-evidence', sourceUrl: 'https://x.com/openai/status/1', localPath: 'post-evidence.png' }]);
    expect(visuals).toEqual([expect.objectContaining({ localPath: 'post-evidence.png', kind: 'x-post-evidence' })]);
  });
  it('reports missing long-form requirements and lets a final revision satisfy them', async () => {
    const evidence = ['post-evidence-1.png', 'post-evidence-2.png', 'post-evidence-3.png', 'post-evidence-4.png', 'post-evidence-5.png'];
    const paragraphs = Array.from({ length: 25 }, (_, index) => `第 ${index + 1} 项公开说明将事件披露、代理外部行动和后续治理放入一条可核查的事实链，也明确了读者需要继续观察的具体边界。`).join('\n\n');
    const complete = vi.fn()
      .mockResolvedValueOnce({ title: '短稿', digest: '摘要', markdown: '这是一段不完整的短稿。' })
      .mockResolvedValueOnce({ title: '仍然过短', digest: '摘要', markdown: '这是一段不完整的短稿。' })
      .mockResolvedValueOnce({ title: '完整稿', digest: '摘要', markdown: `开篇事实说明事件正在改变公开披露的边界。\n\n![原帖截图](${evidence[0]})\n\n## 披露口径正在变化\n\n${paragraphs.slice(0, 420)}\n\n![产品说明](${evidence[1]})\n\n## 代理行动的边界\n\n${paragraphs.slice(420, 850)}\n\n![治理材料](${evidence[2]})\n\n## 接下来观察什么\n\n${paragraphs.slice(850)}\n\n![适用范围](${evidence[3]})\n\n![后续官方说明](${evidence[4]})` });
    const writer = createArticleWriter({ client: { complete } });
    const article = await writer.write({
      post: { text: '官方说明', sourceUrl: 'https://x.com/openai/status/1' },
      analysis: { facts: [] }, editorial: { contentType: 'explainer' },
      assets: evidence.map(localPath => ({ kind: 'x-post-evidence', localPath, sourceUrl: 'https://x.com/openai/status/1' })),
    });
    expect(complete).toHaveBeenCalledTimes(3);
    for (const [request] of complete.mock.calls) {
      expect(request.system).toContain('早鸟公众号图文写作');
      expect(request.system).toContain('Humanizer-zh: 去除 AI 写作痕迹');
      expect(request.system).toContain('五张是底线');
      expect(request.images).toHaveLength(5);
    }
    expect(editorialStructureIssues(article.markdown, 'explainer', articleVisualAssets(evidence.map(localPath => ({ kind: 'x-post-evidence', localPath }))))).toEqual([]);
  });
  it('removes Markdown emphasis and breaks article paragraphs into readable lengths', () => {
    const markdown = `- **启动阶段（Day 0）**：__系统先从零开始建立形式化陈述网络__，并逐步验证每一个可以复核的推理节点。${'系统先从零开始建立形式化陈述网络，并逐步验证每一个可以复核的推理节点。'.repeat(5)}`;
    const compact = compactEditorialMarkdown(markdown);

    expect(compact).not.toContain('**');
    expect(compact).not.toContain('__');
    expect(compact).not.toContain('\n* ');
    expect(hasCompactPresentation(compact)).toBe(true);
    expect(compact.split('\n').every(line => !line.trim() || /^[-#]/.test(line) || line.length <= MAX_PARAGRAPH_LENGTH)).toBe(true);
  });

  it('removes collection metrics and rounds timestamps down to minutes', () => {
    const cleaned = sanitizeEditorialMarkdown('原始数据记录为 1，192 次点赞、19，212 次浏览。\n\n截图 OCR 中还可见 45。3 万查看等互动项。\n\nOpenAI 于 2026 年 9 月 4 日 20：13：05 发布更新。');
    expect(cleaned).not.toMatch(/原始数据|OCR|点赞|浏览|查看|互动项/);
    expect(cleaned).toContain('20：13');
    expect(cleaned).not.toContain('20：13：05');
  });

  it('keeps English sentence punctuation and version numbers intact', () => {
    expect(fullWidthPunctuation('Image 2.0 delivers better continuity.')).toBe('Image 2.0 delivers better continuity.');
    expect(fullWidthPunctuation('模型已经上线.')).toBe('模型已经上线。');
    expect(fullWidthPunctuation('Grok Image 2.0 模型上线, 并支持多场景.')).toBe('Grok Image 2.0 模型上线，并支持多场景。');
  });
  it('alternates two-sentence and one-sentence body paragraphs', () => {
    const first = `第一句交代官方发布的核心背景和读者需要了解的信息范围，以保证段落具备足够的信息密度。第二句补充这个变化对现有使用流程的具体影响，而不只是重复官方的宣传用语。`;
    const second = `第一句继续解释新能力如何连接到实际场景，使读者能够看到它与旧版本之间的清晰区别。第二句将可以继续观察的问题留给读者，让结尾不会成为空洞的总结。`;
    const varied = varyEditorialParagraphs(`${first}\n\n${second}`);
    expect(varied).toContain(first);
    expect(varied).toContain('第一句继续解释新能力如何连接到实际场景，使读者能够看到它与旧版本之间的清晰区别。\n\n第二句将可以继续观察的问题留给读者，让结尾不会成为空洞的总结。');
  });
  it('merges adjacent fragments into a complete reading paragraph', () => {
    const compact = compactEditorialMarkdown('第一句话只交代了背景。\n\n第二句话补足了读者理解这件事所需的关键事实。');
    expect(compact).toBe('第一句话只交代了背景。第二句话补足了读者理解这件事所需的关键事实。');
  });
});

describe('Graphite renderer', () => {
  it('renders a compliant section without forbidden tags', async () => {
    const html = await renderGzhMarkdown('# 标题\n\n## 事件事实\n\n这是一段需要标记关键词的中文内容。', { title: '标题', digest: '摘要' });
    expect(html.startsWith('<section')).toBe(true);
    expect(html).not.toMatch(/<div|<style|<script|position:\s*(absolute|fixed|sticky)/i);
    expect(html).toContain('leaf=');
  });

  it('does not repeat the article title as the first body line', async () => {
    const html = await renderGzhMarkdown('OpenAI 发布新模型\n\n正文从一条可核查的事实开始。', { title: 'OpenAI 发布新模型', digest: 'OpenAI 发布新模型' });
    expect(html.match(/OpenAI 发布新模型/g)).toHaveLength(1);
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
  it('renders dynamic third-level headings and keeps sources only in a final reference list', async () => {
    const html = await renderGzhMarkdown('事实钩子。\n\n### 第一段\n\n[官网材料](https://openai.com/inside) 支持这项事实。\n\n### 第二段\n\n后续问题。', { references: ['https://x.com/source', 'https://openai.com/inside'] });
    expect(html).toContain('>01<');
    expect(html).toContain('>02<');
    expect(html).toContain('参考资料：');
    expect(html).toContain('https://x.com/source');
    expect(html).toContain('https://openai.com/inside');
    expect(html).not.toContain('查看 X 原文');
    expect(html).not.toContain('<a ');
  });
  it('does not render raw Markdown symbols or oversized body paragraphs', async () => {
    const markdown = `## 推进过程\n\n- **启动阶段（Day 0）**：${'系统先从零开始建立形式化陈述网络，并逐步验证每一个可以复核的推理节点。'.repeat(5)}`;
    const html = await renderGzhMarkdown(markdown, { title: '测试标题' });

    expect(html).not.toContain('**');
    expect(() => assertGzhTypography(html)).not.toThrow();
    await expect(validateGzhHtml(html, { run: async () => '完全合规' })).resolves.toBe('完全合规');
  });
  it('uses semantic highlights sparingly instead of underlining every paragraph', async () => {
    const html = await renderGzhMarkdown('这是一段普通的承接文字，用来交代事情仍在发展。\n\nOpenAI 表示将建立 AI 失配事件披露框架。\n\n这也是一段普通说明，帮助读者理解前后语境。', { contentType: 'explainer' });
    expect((html.match(/border-bottom:2px/g) || []).length).toBe(1);
    expect(html).toContain('AI 失配事件');
  });
  it('blocks raw Markdown emphasis that reaches the final HTML', async () => {
    await expect(validateGzhHtml('<section><p style="font-size:15px;">**不应出现**</p></section>', { run: async () => '完全合规' })).rejects.toThrow('raw Markdown emphasis');
  });

  it('puts the fixed end-card after references', async () => {
    const html = await renderGzhMarkdown('事实解释。', {
      references: ['https://x.com/openai/status/1'],
      endVisuals: [{ src: 'https://wechat.test/endcard.png', alt: '早鸟 Pulse 文末品牌图' }],
    });
    expect(html.indexOf('参考资料：')).toBeLessThan(html.indexOf('endcard.png'));
  });
});

describe('fixed end visuals', () => {
  it('uses the fixed image only when it is available', async () => {
    await expect(availableFixedEndVisuals({ mediaDir: 'E:/EarlyBird/media', exists: async () => true })).resolves.toEqual([
      expect.objectContaining({ fileName: 'earlybird-endcard.png' }),
    ]);
    await expect(availableFixedEndVisuals({ mediaDir: 'E:/EarlyBird/media', exists: async () => false })).resolves.toEqual([]);
  });
});

describe('controlled evidence', () => {
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
});

describe('editorial article pipeline', () => {
  it('routes an underspecified single post to manual review instead of creating a weak draft', async () => {
    const originalThreadWait = process.env.EARLYBIRD_THREAD_WAIT_MS;
    process.env.EARLYBIRD_THREAD_WAIT_MS = '0';
    const post = { id: 'p1', postId: '1', authorUsername: 'openai', sourceUrl: 'https://x.com/openai/status/1', text: 'A reply with a small product update.', rawData: { id: '1', text: 'A reply with a small product update.', inReplyTo: { id: '0' } }, createdAt: new Date('2026-09-05T00:00:00Z') };
    const job = { id: 'j1', status: 'ignored', metadata: {}, detectedAt: new Date('2026-09-05T00:20:00Z'), postId: post.id, sourceId: 's1', post, source: { handle: 'openai', website: 'https://openai.com' }, draft: null };
    const updates = [];
    const fixturePath = fileURLToPath(new URL('./earlybird.test.js', import.meta.url));
    const videoAsset = { id: 'a1', postId: post.id, kind: 'video', sourceUrl: 'https://x.com/video', localPath: fixturePath, metadata: { posterPath: fixturePath, keyframes: [fixturePath, 'missing-frame.jpg'] } };
    const unrelatedImage = { id: 'a2', postId: post.id, kind: 'image', sourceUrl: 'https://pbs.twimg.com/media/unrelated.jpg', localPath: 'unrelated.jpg', metadata: { tweetId: '999' } };
    const prisma = {
      earlyBirdArticleJob: {
        findUnique: vi.fn(async () => job),
        update: vi.fn(async ({ data }) => { updates.push(data); return { ...job, ...data }; }),
      },
      earlyBirdPost: {
        update: vi.fn(async () => post),
      },
      earlyBirdAsset: {
        findMany: vi.fn(async ({ where }) => where.postId === post.id ? [videoAsset, unrelatedImage] : []),
      },
    };
    const collect = vi.fn(async ({ post: target }) => []);
    const evidence = vi.fn(async () => { throw new Error('X post card timed out'); });
    const analyze = vi.fn(async () => ({ translation: '中文翻译', digest: '一条小更新也会独立成稿。', facts: ['官方回复中确认了一项产品更新。'] }));
    let writerVisuals = [];
    const llmClient = { complete: vi.fn(async ({ system, user }) => {
      if (user.includes('"availableVisuals"')) writerVisuals = JSON.parse(user).availableVisuals;
      const detail = '这条官方回复确认了产品正在推进的一项新变化，并说明用户可以继续关注后续可用范围、具体上线节奏以及实际使用中的反馈。';
      const markdown = `${detail}\n\n${detail}`;
      if (system.includes('Humanizer-zh')) return { markdown, score: 48 };
      return { title: '一条小更新也会成稿', digest: '每条新内容独立进入公众号写作。', markdown };
    }) };
    const pipeline = createArticlePipeline({
      prisma,
      scraperFactory: async () => ({ scrapeFullThread: async () => [post.rawData] }),
      llmClient,
      wechatClient: null,
      mediaPipeline: { collect },
      evidence,
      analyze,
    });

    try {
      const result = await pipeline.process(job.id);

      expect(result.status).toBe('manual_review');
      expect(collect).toHaveBeenCalledWith(expect.objectContaining({ post }));
      expect(prisma.earlyBirdAsset.findMany).toHaveBeenCalledWith({ where: { postId: post.id, localPath: { not: null } } });
      expect(updates).toContainEqual(expect.objectContaining({
        status: 'editorial_review',
      }));
      expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ tweetUrl: post.sourceUrl, postId: post.postId }));
      expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ evidencePath: undefined }));
      expect(writerVisuals.map(asset => asset.localPath)).not.toContain('unrelated.jpg');
      expect(writerVisuals.map(asset => asset.localPath)).not.toContain('missing-frame.jpg');
    } finally {
      if (originalThreadWait === undefined) delete process.env.EARLYBIRD_THREAD_WAIT_MS;
      else process.env.EARLYBIRD_THREAD_WAIT_MS = originalThreadWait;
    }
  });

  it('re-enters writing as an event story when independent review finds a related task', async () => {
    const originalThreadWait = process.env.EARLYBIRD_THREAD_WAIT_MS;
    process.env.EARLYBIRD_THREAD_WAIT_MS = '0';
    const mediaDir = await mkdtemp(join(tmpdir(), 'earlybird-event-'));
    const imagePaths = await Promise.all([1, 2, 3].map(async index => {
      const path = join(mediaDir, `event-${index}.png`);
      await writeFile(path, `image-${index}`);
      return path;
    }));
    const primaryPost = { id: 'p-event-1', postId: 'event-1', authorUsername: 'openai', sourceUrl: 'https://x.com/openai/status/event-1', text: 'OpenAI 宣布代理能力的第一项进展。', rawData: { id: 'event-1', text: 'OpenAI 宣布代理能力的第一项进展。' }, createdAt: new Date('2026-09-05T00:00:00Z') };
    const relatedPost = { id: 'p-event-2', postId: 'event-2', authorUsername: 'openai', sourceUrl: 'https://x.com/openai/status/event-2', text: 'OpenAI 补充代理能力的开放范围。', rawData: { id: 'event-2', text: 'OpenAI 补充代理能力的开放范围。' }, createdAt: new Date('2026-09-05T00:10:00Z') };
    const primary = { id: 'j-event-1', status: 'detected', metadata: {}, detectedAt: primaryPost.createdAt, postId: primaryPost.id, sourceId: 's-event', post: primaryPost, source: { handle: 'openai' }, draft: null };
    const related = { id: 'j-event-2', status: 'detected', metadata: {}, detectedAt: relatedPost.createdAt, postId: relatedPost.id, sourceId: 's-event', post: relatedPost, source: { handle: 'openai' }, draft: null };
    const updates = [];
    const prisma = {
      earlyBirdArticleJob: {
        findUnique: vi.fn(async () => primary),
        findMany: vi.fn(async () => [related]),
        update: vi.fn(async ({ where, data }) => { updates.push({ where, data }); return { ...primary, ...data }; }),
      },
      earlyBirdPost: { update: vi.fn(async () => ({})) },
    };
    const briefText = Array.from({ length: 8 }, () => '官方披露把产品范围、可用方式和后续观察重点说得更具体，读者可以据此判断这一轮变化的实际边界。').join('\n\n');
    const eventParagraphs = Array.from({ length: 12 }, () => '第一条公告交代了代理能力的基础范围，第二条公告补上开放条件和时间顺序，第三条公告则把接下来可验证的产品动作留给读者继续观察。'.repeat(3));
    const eventText = `![事件图一](${imagePaths[0]})\n\n## 第一条消息确认了什么\n\n${eventParagraphs.slice(0, 4).join('\n\n')}\n\n![事件图二](${imagePaths[1]})\n\n## 第二条消息补上了哪些边界\n\n${eventParagraphs.slice(4, 8).join('\n\n')}\n\n![事件图三](${imagePaths[2]})\n\n## 这条时间线接下来指向哪里\n\n${eventParagraphs.slice(8).join('\n\n')}`;
    const llmClient = { complete: vi.fn(async ({ system, user }) => {
      const input = JSON.parse(user);
      if (system.includes('Humanizer-zh')) return { markdown: input.markdown, score: 48 };
      return input.editorial?.contentType === 'event'
        ? { title: '代理能力的两条公告如何连起来', digest: '两条官方消息补齐了同一能力的时间线。', markdown: eventText }
        : { title: '代理能力更新', digest: '官方公布了新的代理能力信息。', markdown: `![快讯图](${imagePaths[0]})\n\n${briefText}` };
    }) };
    const reviewer = {
      triage: vi.fn(async () => ({ decision: 'pass', contentType: 'brief', qualityScore: 90, issues: [], rewriteInstructions: '', relatedJobIds: [], visualPlan: [] })),
      reviewDraft: vi.fn()
        .mockResolvedValueOnce({ decision: 'merge', contentType: 'event', qualityScore: 72, issues: ['两条公告应合成时间线'], rewriteInstructions: '按时间线合稿', relatedJobIds: [related.id], visualPlan: [] })
        .mockResolvedValueOnce({ decision: 'pass', contentType: 'event', qualityScore: 93, issues: [], rewriteInstructions: '', relatedJobIds: [related.id], visualPlan: [] }),
    };
    const pipeline = createArticlePipeline({
      prisma, reviewer, llmClient, wechatClient: null,
      scraperFactory: async () => ({ scrapeFullThread: async post => [post] }),
      mediaPipeline: { collect: vi.fn(async ({ post }) => post.id === primaryPost.id ? imagePaths.map((localPath, index) => ({ id: `a-${index}`, kind: 'image', sourceUrl: `https://image.example/${index}`, localPath, metadata: { tweetId: primaryPost.postId } })) : []) },
      evidence: vi.fn(async () => { throw new Error('evidence unavailable'); }),
      analyze: vi.fn(async () => ({ translation: '', digest: '官方披露代理能力更新。', facts: ['两条公告来自同一产品更新。'] })),
      notifier: null,
    });
    try {
      await expect(pipeline.process(primary.id)).resolves.toMatchObject({ status: 'rendered' });
      expect(reviewer.reviewDraft).toHaveBeenCalledTimes(2);
      expect(updates).toContainEqual(expect.objectContaining({ where: { id: related.id }, data: expect.objectContaining({ status: 'merged' }) }));
    } finally {
      if (originalThreadWait === undefined) delete process.env.EARLYBIRD_THREAD_WAIT_MS;
      else process.env.EARLYBIRD_THREAD_WAIT_MS = originalThreadWait;
    }
  });
});

describe('WeChat client', () => {
  it('converts non-JPG/PNG media before a WeChat image upload', async () => {
    const calls = [];
    const prepared = await prepareWechatUpload('source.webp', {
      tempRoot: await mkdtemp(join(tmpdir(), 'earlybird-wechat-upload-')),
      run: vi.fn(async (command, args) => { calls.push({ command, args }); }),
    });
    expect(calls[0]).toMatchObject({ command: 'ffmpeg', args: expect.arrayContaining(['-i', 'source.webp', '-frames:v', '1']) });
    expect(prepared.path).toMatch(/image\.jpg$/);
    await prepared.cleanup();
  });

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
    await client.deleteDraft('m1');
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes('/cgi-bin/token'))).toHaveLength(1);
    expect(calls.some(call => call.url.includes('/draft/add'))).toBe(true);
    expect(calls.some(call => call.url.includes('/draft/delete'))).toBe(true);
  });
});

describe('multimodal fallback', () => {
  it('skips missing video keyframes instead of failing an article analysis', async () => {
    const client = { complete: vi.fn(async () => ({ translation: '译文', facts: [] })) };
    await analyzePost({
      client,
      post: { text: '视频发布' },
      assets: [{ kind: 'video', metadata: { keyframes: ['C:/missing-frame.jpg'] } }],
    });
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({ images: [] }));
  });

  it('uses the backup OpenAI-compatible provider after the primary provider fails', async () => {
    const fetchImpl = vi.fn(async url => {
      if (url.startsWith('https://primary.test')) return new Response(JSON.stringify({ error: { message: 'primary unavailable' } }), { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"publish":true}' } }] }), { status: 200 });
    });
    const client = createMultimodalClient({
      apiKey: 'primary-key', baseUrl: 'https://primary.test/v1', model: 'primary-model',
      fallbackApiKey: 'backup-key', fallbackBaseUrl: 'https://backup.test/v1', fallbackModel: 'backup-model',
      fetchImpl, maxAttempts: 1,
    });

    await expect(client.complete({ system: 'system', user: 'user' })).resolves.toEqual({ publish: true });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://primary.test/v1/chat/completions',
      'https://backup.test/v1/chat/completions',
    ]);
  });
});

describe('WeChat cover generation', () => {
  it('keeps the required odd 900x383 size by encoding JPEG in 4:4:4', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'earlybird-cover-normalize-'));
    const outputPath = join(outputDir, 'cover.jpg');
    const run = vi.fn(async () => { await writeFile(outputPath, 'normalized-cover'); });

    await normalizeCoverImage({ sourcePath: join(outputDir, 'source.png'), outputPath, run });

    expect(run).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining([
      '-vf', `scale=${WECHAT_COVER_SIZE.width}:${WECHAT_COVER_SIZE.height}:force_original_aspect_ratio=increase,crop=${WECHAT_COVER_SIZE.width}:${WECHAT_COVER_SIZE.height}`,
      '-pix_fmt', 'yuvj444p',
    ]), { windowsHide: true });
  });

  it('writes a pure-visual prompt and uses the fallback image model after the primary model fails', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'earlybird-cover-'));
    const normalize = vi.fn(async ({ outputPath }) => { await writeFile(outputPath, 'normalized-cover'); return outputPath; });
    const calls = [];
    const fetchImpl = vi.fn(async (_url, options = {}) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      if (request.model === 'primary-model') return new Response(JSON.stringify({ error: { message: 'primary unavailable' } }), { status: 503 });
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }] }), { status: 200 });
    });
    const generator = createCoverImageGenerator({
      apiKey: 'primary-key', baseUrl: 'https://images.test/v1', model: 'primary-model',
      fallbackModel: 'fallback-model', outputDir, fetchImpl, normalize,
    });

    const cover = await generator.generate({ postId: '123', title: '模型发布新功能', digest: '官方公布了新的模型能力。', analysis: { facts: ['新功能面向开发者开放。'] }, editorial: { contentType: 'brief' } });

    expect(calls.map(call => call.model)).toEqual(['primary-model', 'fallback-model']);
    expect(cover).toMatchObject({ status: 'generated', model: 'fallback-model', width: 900, height: 383, aspect: '2.35:1' });
    expect(normalize).toHaveBeenCalledWith(expect.objectContaining({ outputPath: cover.localPath }));
    await expect(readFile(cover.promptPath, 'utf8')).resolves.toContain('text = none');
    await expect(readFile(cover.promptPath, 'utf8')).resolves.toContain('900x383px');
  });

  it('accepts an image URL response and reuses an existing generated cover', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'earlybird-cover-'));
    const normalize = vi.fn(async ({ outputPath }) => { await writeFile(outputPath, 'normalized-cover'); return outputPath; });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/cover.png' }] }), { status: 200 });
      if (url === 'https://cdn.test/cover.png') return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });
    const generator = createCoverImageGenerator({ apiKey: 'key', baseUrl: 'https://images.test/v1', outputDir, fetchImpl, normalize });

    const cover = await generator.generate({ postId: '456', title: '新进展', editorial: { contentType: 'event' } });
    const reused = await generator.generate({ postId: '456', title: '新进展', editorial: { contentType: 'event' }, previous: cover });

    expect(reused).toMatchObject({ localPath: cover.localPath, reused: true });
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it('uses a topic-specific visual prompt without asking the image model to render text', () => {
    const prompt = buildCoverPrompt({ title: 'AI 代理进入生产环境', digest: '官方发布新的代理能力。', analysis: { facts: ['支持工具调用和审计。'] }, editorial: { contentType: 'explainer' } });
    expect(prompt).toContain(`exact cinematic ${WECHAT_COVER_SIZE.aspect}`);
    expect(prompt).toContain('AI 代理进入生产环境');
    expect(prompt).toContain('Do not include any text');
  });
});

function draftPipelineFixture(coverImageGenerator) {
  const fixturePath = fileURLToPath(new URL('./earlybird.test.js', import.meta.url));
  const post = { id: 'p-cover', postId: 'cover-post', authorUsername: 'thsottiaux', sourceUrl: 'https://x.com/thsottiaux/status/cover-post', text: 'Codex now supports the new ChatGPT model.', rawData: { id: 'cover-post', text: 'Codex now supports the new ChatGPT model.' }, createdAt: new Date('2026-09-05T00:00:00Z') };
  const job = { id: 'j-cover', status: 'detected', metadata: {}, detectedAt: new Date('2026-09-05T00:05:00Z'), postId: post.id, sourceId: 's-cover', post, source: { handle: 'thsottiaux', website: 'https://openai.com' }, draft: null };
  const sourceImage = { id: 'a-cover', postId: post.id, kind: 'image', sourceUrl: 'https://pbs.twimg.com/media/cover.jpg', localPath: fixturePath, metadata: { tweetId: post.postId } };
  const updates = [];
  const prisma = {
    earlyBirdArticleJob: {
      findUnique: vi.fn(async () => job),
      update: vi.fn(async ({ data }) => { updates.push(data); return { ...job, ...data }; }),
    },
    earlyBirdPost: { update: vi.fn(async () => post) },
    earlyBirdAsset: { findMany: vi.fn(async () => [sourceImage]), update: vi.fn(async () => sourceImage) },
    earlyBirdDraft: { upsert: vi.fn(async ({ create }) => create) },
  };
  const body = `这是一段经过核查的官方技术更新，说明新能力覆盖的产品范围、开发者接入方式以及用户能够立即确认的使用边界。它没有把产品承诺写成已经发生的结果，而是把官方说明与当前可用状态分开交代。\n\n![官方素材](${fixturePath})\n\n${'后续最值得观察的是该能力的实际开放范围、稳定性反馈和官方是否补充更具体的技术细节。'.repeat(8)}`;
  const llmClient = { complete: vi.fn(async ({ system }) => {
    if (system.includes('Humanizer-zh')) return { markdown: body, score: 48 };
    return { title: '官方发布新能力', digest: '官方公布了新的技术能力。', markdown: body };
  }) };
  const wechatClient = {
    uploadPermanentMaterial: vi.fn(async () => ({ media_id: 'thumb-media' })),
    uploadArticleImage: vi.fn(async () => ({ url: 'https://wechat.test/article-image' })),
    addDraft: vi.fn(async () => ({ media_id: 'draft-media' })),
    getDraft: vi.fn(async () => ({ media_id: 'draft-media' })),
    deleteDraft: vi.fn(async () => ({})),
  };
  const reviewer = {
    triage: vi.fn(async () => ({ decision: 'rewrite', contentType: 'brief', qualityScore: 76, issues: ['需要按事实钩子重写'], rewriteInstructions: '保留官方事实，重写开篇和段落节奏。', relatedJobIds: [], visualPlan: [] })),
    reviewDraft: vi.fn(async () => ({ decision: 'pass', contentType: 'brief', qualityScore: 92, issues: [], rewriteInstructions: '', relatedJobIds: [], visualPlan: [] })),
  };
  return {
    pipeline: createArticlePipeline({
      prisma,
      scraperFactory: async () => ({ scrapeFullThread: async () => [post.rawData] }),
      llmClient,
      wechatClient,
      mediaPipeline: { collect: vi.fn(async () => [sourceImage]) },
      evidence: vi.fn(async () => ({})),
      analyze: vi.fn(async () => ({ translation: '官方公告', digest: '官方公布了新的技术能力。', facts: ['新能力已经发布。'] })),
      coverImageGenerator,
      notifier: null,
      reviewer,
    }),
    wechatClient,
    updates,
    sourceImage,
    reviewer,
  };
}

describe('cover image pipeline integration', () => {
  it('uses the generated cover only for the WeChat thumbnail and stores its metadata', async () => {
    const generatedCover = 'C:/generated-cover.jpg';
    const coverImageGenerator = { generate: vi.fn(async () => ({ status: 'generated', localPath: generatedCover, model: 'primary-model', width: 900, height: 383 })) };
    const { pipeline, wechatClient, updates } = draftPipelineFixture(coverImageGenerator);
    const originalWait = process.env.EARLYBIRD_THREAD_WAIT_MS;
    process.env.EARLYBIRD_THREAD_WAIT_MS = '0';
    try {
      await expect(pipeline.process('j-cover')).resolves.toMatchObject({ status: 'verified' });
      expect(wechatClient.uploadPermanentMaterial).toHaveBeenCalledWith(generatedCover, 'thumb');
      expect(wechatClient.uploadArticleImage).not.toHaveBeenCalledWith(generatedCover);
      expect(wechatClient.addDraft.mock.calls[0][0].content).not.toContain(generatedCover);
      expect(updates.some(update => update.metadata?.cover?.localPath === generatedCover)).toBe(true);
    } finally {
      if (originalWait === undefined) delete process.env.EARLYBIRD_THREAD_WAIT_MS;
      else process.env.EARLYBIRD_THREAD_WAIT_MS = originalWait;
    }
  });

  it('falls back to the original post image when cover generation fails', async () => {
    const coverImageGenerator = { generate: vi.fn(async () => { throw new Error('both image models unavailable'); }) };
    const { pipeline, wechatClient, sourceImage, updates } = draftPipelineFixture(coverImageGenerator);
    const originalWait = process.env.EARLYBIRD_THREAD_WAIT_MS;
    process.env.EARLYBIRD_THREAD_WAIT_MS = '0';
    try {
      await expect(pipeline.process('j-cover')).resolves.toMatchObject({ status: 'verified' });
      expect(wechatClient.uploadPermanentMaterial).toHaveBeenCalledWith(sourceImage.localPath, 'thumb');
      expect(updates.some(update => update.metadata?.cover?.status === 'source-fallback')).toBe(true);
    } finally {
      if (originalWait === undefined) delete process.env.EARLYBIRD_THREAD_WAIT_MS;
      else process.env.EARLYBIRD_THREAD_WAIT_MS = originalWait;
    }
  });

  describe('code review bug fixes', () => {
    it('renders code blocks in markdown without throwing TypeError', async () => {
      const markdown = '前文说明。\n\n```python\nprint("Hello World")\n```\n\n后文继续分析。';
      const html = await renderGzhMarkdown(markdown, { title: '代码示例', digest: '代码分析' });
      expect(html).toContain('print(&quot;Hello World&quot;)');
      expect(html).toContain('background:#27272A');
    });

    it('renders level 4 headings cleanly without raw hashes leaking', async () => {
      const markdown = '## 主标题\n\n#### 子标题\n\n详细说明文字。';
      const html = await renderGzhMarkdown(markdown, { title: '测试标题', digest: '测试摘要' });
      expect(html).not.toContain('####');
      expect(html).toContain('子标题');
    });

    it('pairs Chinese quotation marks correctly for double and single quotes', () => {
      expect(fullWidthPunctuation('"测试内容"发布了"新模型"')).toBe('“测试内容”发布了“新模型”');
      expect(fullWidthPunctuation('\'核心能力\'')).toBe('‘核心能力’');
      expect(fullWidthPunctuation('English text "quoted" and don\'t change.')).toBe('English text "quoted" and don\'t change.');
    });

    it('matches Windows backslash asset paths against forward slash markdown paths', () => {
      const visualAssets = [{ localPath: 'data\\earlybird\\media\\test.jpg', kind: 'image', sourceUrl: 'https://x.com/img' }];
      const markdown = `这是第一段内容，详细说明技术更新的来龙去脉与具体影响。${'这是正文文字。'.repeat(30)}\n\n![测试图片](data/earlybird/media/test.jpg)`;
      const issues = editorialStructureIssues(markdown, 'brief', visualAssets);
      expect(issues.some(issue => issue.includes('真实素材图片'))).toBe(false);
    });
  });
});
