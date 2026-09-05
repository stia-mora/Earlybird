import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { cacheScraperFactory, configuredXCookies, createSourceMonitor, mergeCookieHeaders, retryAtFromRateLimit } from '../src/earlybird/sourceMonitor.js';
import { startupPollDelay } from '../src/earlybird/sourcePollTiming.js';
import { createMultimodalClient } from '../src/earlybird/aiPipeline.js';
import { assembleThread } from '../src/earlybird/threadAssembler.js';
import { humanize, scoreHumanized } from '../src/earlybird/humanizer.js';
import { assertGzhTypography, renderGzhMarkdown, validateGzhHtml } from '../src/earlybird/gzhRenderer.js';
import { createWeChatClient } from '../src/earlybird/wechatClient.js';
import { DEFAULT_SOURCES } from '../src/earlybird/utils.js';
import { classifyEditorial, normalizeEditorialDecision } from '../src/earlybird/editorialClassifier.js';
import { isOfficialUrl, normalizeSearchQueries, officialHosts } from '../src/earlybird/researchBrowser.js';
import { assertTweetEvidence, xBrowserCookies } from '../src/earlybird/evidenceCapture.js';
import { createArticlePipeline } from '../src/earlybird/pipeline.js';
import { articleVisualAssets, compactEditorialMarkdown, createArticleWriter, editorialStructureIssues, hasCompactPresentation, markdownBodyLength, markdownHeadingCount, MAX_PARAGRAPH_LENGTH } from '../src/earlybird/articleWriter.js';
import { enqueueInterruptedJobs } from '../src/earlybird/jobRecovery.js';

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
});

describe('EarlyBird source timing', () => {
  it('spreads rate-limited sources over a five-minute recovery window', () => {
    const source = { pollIntervalSeconds: 300, lastError: 'X rate limited until 2026-09-05T09:00:00.000Z' };
    expect(startupPollDelay(source, { index: 0, total: 10, now: Date.parse('2026-09-05T08:55:00.000Z'), random: () => 0 })).toBe(300000);
    expect(startupPollDelay(source, { index: 9, total: 10, now: Date.parse('2026-09-05T08:55:00.000Z'), random: () => 0.5 })).toBe(585000);
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
    const evidence = 'post-evidence.png';
    const paragraphs = Array.from({ length: 30 }, () => 'OpenAI 的公开说明把事件披露、代理外部行动和后续治理放在同一条可核查的事实链中。').join('\n\n');
    const complete = vi.fn()
      .mockResolvedValueOnce({ title: '短稿', digest: '摘要', markdown: '这是一段不完整的短稿。' })
      .mockResolvedValueOnce({ title: '仍然过短', digest: '摘要', markdown: '这是一段不完整的短稿。' })
      .mockResolvedValueOnce({ title: '完整稿', digest: '摘要', markdown: `开篇事实说明事件正在改变公开披露的边界。\n\n![原帖截图](${evidence})\n\n${paragraphs}\n\n## 披露口径正在变化\n\n${paragraphs}\n\n## 代理行动的边界\n\n${paragraphs}\n\n## 接下来观察什么\n\n${paragraphs}` });
    const writer = createArticleWriter({ client: { complete } });
    const article = await writer.write({
      post: { text: '官方说明', sourceUrl: 'https://x.com/openai/status/1' },
      analysis: { facts: [] }, editorial: { contentType: 'explainer' },
      assets: [{ kind: 'x-post-evidence', localPath: evidence, sourceUrl: 'https://x.com/openai/status/1' }],
    });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(editorialStructureIssues(article.markdown, 'explainer', articleVisualAssets([{ kind: 'x-post-evidence', localPath: evidence }]))).toEqual([]);
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

  it('recognizes Tibo by the actual post author when a source uses an internal alias', () => {
    const decision = normalizeEditorialDecision(
      { publish: true, contentType: 'brief', newsworthiness: 90, reason: '配额补偿' },
      { post: { ...tiboPost, text: 'A banked reset lands today.' }, source: { ...source, handle: 'ebtibo' } },
    );
    expect(decision).toMatchObject({ contentType: 'brief', publish: true });
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
    expect(client.complete.mock.calls[0][0].system).toContain('判别必须自洽');
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
  it('processes a requeued held job, merges an eligible candidate, and collects every story asset', async () => {
    const originalThreadWait = process.env.EARLYBIRD_THREAD_WAIT_MS;
    process.env.EARLYBIRD_THREAD_WAIT_MS = '0';
    const post = { id: 'p1', postId: '1', authorUsername: 'openai', sourceUrl: 'https://x.com/openai/status/1', text: 'Primary announcement', rawData: { id: '1', text: 'Primary announcement' }, createdAt: new Date('2026-09-05T00:00:00Z') };
    const related = { id: 'p2', postId: '2', authorUsername: 'geminiapp', sourceUrl: 'https://x.com/geminiapp/status/2', text: 'Related official detail', rawData: { id: '2', text: 'Related official detail' }, createdAt: new Date('2026-09-05T00:10:00Z'), source: { handle: 'geminiapp', website: 'https://gemini.google.com' }, jobs: [] };
    const job = { id: 'j1', status: 'held', metadata: { editorial: { holdUntil: '2099-01-01T00:00:00.000Z' } }, detectedAt: new Date('2026-09-05T00:20:00Z'), postId: post.id, sourceId: 's1', post, source: { handle: 'openai', website: 'https://openai.com' }, draft: null };
    const updates = [];
    const videoAsset = { id: 'a1', postId: post.id, kind: 'video', sourceUrl: 'https://x.com/video', localPath: 'video.mp4', metadata: { posterPath: 'poster.jpg', keyframes: ['frame-1.jpg'] } };
    const unrelatedImage = { id: 'a2', postId: post.id, kind: 'image', sourceUrl: 'https://pbs.twimg.com/media/unrelated.jpg', localPath: 'unrelated.jpg', metadata: { tweetId: '999' } };
    const primaryEvidence = join(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', '1-evidence.png');
    const relatedEvidence = join(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', '2-evidence.png');
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
      earlyBirdAsset: {
        findMany: vi.fn(async ({ where }) => where.postId === post.id ? [videoAsset, unrelatedImage] : []),
      },
    };
    const collect = vi.fn(async ({ post: target }) => []);
    const evidence = vi.fn(async () => ({ path: 'evidence.png' }));
    let writerVisuals = [];
    const llmClient = { complete: vi.fn(async ({ system, user }) => {
      if (system.includes('微信公众号总编辑')) return { publish: true, contentType: 'event', newsworthiness: 90, relatedPostIds: ['p2'], reason: '同一发布事件', searchQueries: [] };
      if (user.includes('"availableVisuals"')) writerVisuals = JSON.parse(user).availableVisuals;
      const detail = '两条官方动态构成同一事件，并提供了明确的发布范围与后续观察线索。'.repeat(35);
      const markdown = `事实钩子。\n\n## 第一条线索\n\n${detail}\n\n![主帖截图](${primaryEvidence})\n\n### 发布范围\n\n${detail}\n\n![相关帖截图](${relatedEvidence})\n\n## 接下来要看什么\n\n${detail}\n\n![视频封面](poster.jpg)`;
      if (system.includes('Humanizer-zh')) return { markdown, score: 48 };
      return { title: '合并后的官方动态', digest: '两条官方动态构成同一事件。', markdown };
    }) };
    const pipeline = createArticlePipeline({
      prisma,
      scraperFactory: async () => ({ scrapeFullThread: async () => [post.rawData] }),
      llmClient,
      wechatClient: null,
      mediaPipeline: { collect },
      evidence,
      analyze: vi.fn(async () => ({ translation: '中文翻译', digest: '两条官方动态构成同一事件。', facts: ['两个官方账号先后发布关联信息。'] })),
    });

    try {
      const result = await pipeline.process(job.id);

      expect(result.status).toBe('rendered');
      expect(collect).toHaveBeenCalledWith(expect.objectContaining({ post }));
      expect(collect).toHaveBeenCalledWith(expect.objectContaining({ post: related }));
      expect(prisma.earlyBirdAsset.findMany).toHaveBeenCalledWith({ where: { postId: post.id, localPath: { not: null } } });
      expect(prisma.earlyBirdPost.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: new Date('2026-09-04T23:20:00Z'), lte: new Date('2026-09-05T00:20:00Z') } }),
      }));
      expect(prisma.earlyBirdArticleJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'merged' } }));
      expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ tweetUrl: related.sourceUrl, postId: related.postId, showTranslation: false }));
      expect(writerVisuals.map(asset => asset.localPath)).not.toContain('unrelated.jpg');
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
    await client.deleteDraft('m1');
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes('/cgi-bin/token'))).toHaveLength(1);
    expect(calls.some(call => call.url.includes('/draft/add'))).toBe(true);
    expect(calls.some(call => call.url.includes('/draft/delete'))).toBe(true);
  });
});

describe('multimodal fallback', () => {
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
