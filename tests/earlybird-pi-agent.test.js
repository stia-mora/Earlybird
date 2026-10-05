// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEarlyBirdTools,
  createFetchTweetThreadTool,
  createSearchWebResearchTool,
  createCaptureTweetEvidenceTool,
  createRenderGzhDraftTool,
  createSearchXPostsTool,
  createPiStreamFn,
  createAuthorAgent,
  createCriticAgent,
  createArticlePipeline,
} from '../src/earlybird/index.js';

describe('EarlyBird Pi Agent Architecture', () => {
  describe('Tool Abstractions (工具化)', () => {
    it('fetch_tweet_thread tool scrapes thread and returns formatted tweets', async () => {
      const scraper = {
        scrapeFullThread: vi.fn(async () => [
          { id: '100', text: '主推文：发布新版本', author: { username: 'techlead' }, createdAt: '2026-10-01T10:00:00Z' },
          { id: '101', text: '补充回复：跑分提升3倍', author: { username: 'techlead' }, createdAt: '2026-10-01T10:05:00Z' },
        ]),
      };
      const tool = createFetchTweetThreadTool({ defaultScraper: scraper });
      expect(tool.name).toBe('fetch_tweet_thread');
      expect(tool.parameters).toBeDefined();

      const result = await tool.execute('call-1', { postId: '100', author: 'techlead' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('[#1 @techlead]: 主推文：发布新版本');
      expect(result.content[0].text).toContain('[#2 @techlead]: 补充回复：跑分提升3倍');
      expect(result.details.count).toBe(2);
      expect(scraper.scrapeFullThread).toHaveBeenCalledWith('100');
    });

    it('search_web_research tool searches Tavily and formats citations', async () => {
      const searcher = {
        search: vi.fn(async query => [
          { title: '官方公告', url: 'https://official.example/blog', snippet: 'V3 正式发布，性能提升 200%' },
        ]),
      };
      const tool = createSearchWebResearchTool({ imageSearch: searcher });
      expect(tool.name).toBe('search_web_research');

      const result = await tool.execute('call-2', { query: 'DeepSeek V3 benchmark' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('[官方公告](https://official.example/blog)');
      expect(result.content[0].text).toContain('V3 正式发布');
      expect(result.details.results).toHaveLength(1);
    });

    it('capture_tweet_evidence tool captures browser screenshot and returns markdown path', async () => {
      const mediaDir = await mkdtemp(join(tmpdir(), 'eb-tool-evidence-'));
      const evidence = vi.fn(async ({ outputPath }) => {
        await writeFile(outputPath, 'fake-png-data');
      });
      const tool = createCaptureTweetEvidenceTool({ evidence, mediaDir });
      expect(tool.name).toBe('capture_tweet_evidence');

      const result = await tool.execute('call-3', {
        tweetUrl: 'https://x.com/tech/status/999',
        postId: '999',
        translation: '测试译文',
      });
      expect(result.isError).toBeFalsy();
      expect(result.details.localPath).toContain('999-evidence.png');
      expect(result.content[0].text).toContain('![推文证据截图]');
      expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ postId: '999', translation: '测试译文' }));
    });

    it('render_gzh_draft tool renders Graphite HTML and validates compliance', async () => {
      const tool = createRenderGzhDraftTool({ runValidator: vi.fn(async () => 'OK') });
      expect(tool.name).toBe('render_gzh_draft');

      const result = await tool.execute('call-4', {
        title: '测试标题',
        digest: '测试导读摘要内容',
        markdown: '这是一篇测试排版的正文段落。短句口语化，节奏明快。',
        contentType: 'brief',
      });
      expect(result.details.isValid).toBe(true);
      expect(result.details.htmlLength).toBeGreaterThan(50);
      expect(result.content[0].text).toContain('合规校验状态：通过');
    });

    it('search_x_posts tool queries X platform for discussions and updates', async () => {
      const xSearch = {
        search: vi.fn(async () => [
          { id: 'x-201', text: '行业大V评测：速度确实快', author: { username: 'expert_ai' }, url: 'https://x.com/expert_ai/status/x-201' },
        ]),
      };
      const tool = createSearchXPostsTool({ xSearch });
      expect(tool.name).toBe('search_x_posts');

      const result = await tool.execute('call-5', { query: 'from:expert_ai' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('@expert_ai');
      expect(result.content[0].text).toContain('速度确实快');
      expect(result.details.results).toHaveLength(1);
    });

    it('createEarlyBirdTools bundles all 5 standard tools', () => {
      const tools = createEarlyBirdTools();
      expect(tools).toHaveLength(5);
      const names = tools.map(t => t.name);
      expect(names).toContain('fetch_tweet_thread');
      expect(names).toContain('search_web_research');
      expect(names).toContain('capture_tweet_evidence');
      expect(names).toContain('render_gzh_draft');
      expect(names).toContain('search_x_posts');
    });
  });

  describe('Stream Function Adapter (agentStream)', () => {
    it('dispatches tool calls and receives execution results in agent loop', async () => {
      let callCount = 0;
      const mockClient = {
        complete: vi.fn(async ({ user }) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              tool_calls: [{
                id: 'call-tool-1',
                function: {
                  name: 'search_web_research',
                  arguments: JSON.stringify({ query: 'DeepSeek news' }),
                },
              }],
            };
          }
          return {
            title: 'DeepSeek 重磅发布！',
            markdown: '正文根据搜索结果完成撰写。',
          };
        }),
      };

      const streamFn = createPiStreamFn({ client: mockClient });
      const tools = createEarlyBirdTools({
        imageSearch: {
          search: vi.fn(async () => [{ title: '发布新闻', url: 'https://news.example', snippet: '重磅更新' }]),
        },
      });

      const { Agent } = await import('@earendil-works/pi-agent-core');
      const agent = new Agent({
        streamFn,
        initialState: {
          model: { id: 'test-model', name: 'Test', api: 'openai-completions', provider: 'test' },
          tools,
          systemPrompt: 'You are an autonomous reporter.',
        },
      });

      await agent.prompt('Write a story on DeepSeek');
      expect(callCount).toBe(2);
      const toolResults = agent.state.messages.filter(m => m.role === 'toolResult');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolName).toBe('search_web_research');
    });
  });

  describe('Closed-Loop Author Agent (闭环写作代理)', () => {
    it('autonomously writes an article with candidate titles and 新智元 style', async () => {
      const mockClient = {
        complete: vi.fn(async () => ({
          title: '一夜之间暴涨10倍！开源社区直接炸锅了',
          candidateTitles: [
            '一夜之间暴涨10倍！开源社区直接炸锅了',
            'DeepSeek新突破：彻底干翻英伟达显存？',
            '这是少有的降维打击：新模型正式发布',
          ],
          digest: '最新开源模型发布，实测性能全面刷新基准。',
          markdown: '![原帖截图](data/evidence.png)\n\n这波属实离谱。凌晨时分，全新模型正式开源，实测跑分直接拉满。\n\n关键参数指标公布，不仅推理速度翻倍，显存占用还直接暴降八成。'.repeat(8),
        })),
      };

      const author = createAuthorAgent({ client: mockClient });
      const post = {
        postId: 'p-deepseek',
        authorUsername: 'deepseek_ai',
        sourceUrl: 'https://x.com/deepseek_ai/status/12345',
        text: 'DeepSeek-V3 is now open source!',
      };
      const assets = [{ kind: 'image', localPath: 'data/evidence.png' }];

      const article = await author.write({
        post,
        editorial: { contentType: 'brief' },
        assets,
      });

      expect(article.title).toBe('一夜之间暴涨10倍！开源社区直接炸锅了');
      expect(article.candidateTitles).toHaveLength(3);
      expect(article.digest).toContain('最新开源模型发布');
      expect(article.markdown).toContain('这波属实离谱');
    });
  });

  describe('Independent Adversarial Critic Agent (独立对抗审校代理)', () => {
    it('critic verifies claims, cross-checks with tools, and selects best candidate title', async () => {
      const mockSearcher = {
        search: vi.fn(async () => [
          { title: '官方公告证实性能翻倍', url: 'https://official.example/verified', snippet: '确实性能翻倍' },
        ]),
      };
      const tools = createEarlyBirdTools({ imageSearch: mockSearcher });

      const mockClient = {
        complete: vi.fn(async () => ({
          decision: 'pass',
          qualityScore: 95,
          title: 'DeepSeek新突破：彻底干翻英伟达显存？',
          issues: [],
          verifiedFacts: ['性能翻倍与显存降低属实'],
          reason: '经搜索核验官方博客，核心数据属实；首句强钩子，无公文腔。',
        })),
      };

      const critic = createCriticAgent({ client: mockClient, tools });
      const p1 = '这波属实离谱。凌晨时分，全新模型正式开源，实测跑分直接拉满。不仅推理速度翻倍，显存占用还直接暴降八成，直接把英伟达显存干爆了。开源社区直接沸腾。';
      const p2 = '核心技术架构完全公开，社区开发者纷纷表示震惊。各项评测基准数据表明，该模型在代码和数学推理任务上刷新了此前记录，引发业界广泛讨论与实测复现。';
      const p3 = '团队负责人公开回应质疑，强调完全基于自研算力训练，并将继续保持全面开放的原则推进后续优化迭代，为开发者提供更低门槛的本地部署体验。';
      const p4 = '这一轮技术突破彻底改变了开源模型生态，未来几天预计将有更多实测数据和第三方复现结果出炉，值得持续保持追踪与观察。';
      const p5 = '在多任务基准测评中，推理延迟大幅缩短，上下文处理能力全面提升，为本地部署与工业落地提供了切实可能。';
      const p6 = '业内专家普遍认为，这种高效算法设计展示了新的技术路径，将推动更多开发者参与到开放生态建设中来。';
      const body = [p1, p2, p3, p4, p5, p6].join('\n\n');
      const article = {
        title: '初始标题',
        candidateTitles: [
          '初始标题',
          'DeepSeek新突破：彻底干翻英伟达显存？',
          '平淡的科技快讯',
        ],
        markdown: `![原帖截图](data/evidence.png)\n\n${body}`,
      };

      const review = await critic.reviewDraft({
        job: { id: 'j-critic', post: { postId: 'p-1', text: 'V3 is out' } },
        article,
        editorial: { contentType: 'brief' },
        assets: [{ kind: 'image', localPath: 'data/evidence.png' }],
        references: ['https://official.example/verified'],
      });

      expect(review.decision).toBe('pass');
      expect(review.title).toBe('DeepSeek新突破：彻底干翻英伟达显存？');
      expect(review.qualityScore).toBe(95);
    });

    it('critic flags hallucinations and returns rewrite decision with surgical instructions', async () => {
      const mockClient = {
        complete: vi.fn(async () => ({
          decision: 'rewrite',
          qualityScore: 60,
          issues: ['第2段断言融资100亿缺少任何信源支撑', '首句过于平淡，缺乏新智元式钩子'],
          rewriteInstructions: '删除关于100亿融资的未经证实传闻；开头改用跑分对比直接制造冲突。',
          hallucinations: ['100亿融资'],
        })),
      };

      const critic = createCriticAgent({ client: mockClient });
      const review = await critic.reviewDraft({
        job: { id: 'j-crit-2', post: { postId: 'p-2', text: 'Rumor post' } },
        article: { title: '某公司融资传闻', markdown: '在当今科技圈，又有新消息了。据称融资100亿。' },
        editorial: { contentType: 'brief' },
      });

      expect(review.decision).toBe('rewrite');
      expect(review.qualityScore).toBeLessThan(80);
      expect(review.issues).toContain('第2段断言融资100亿缺少任何信源支撑');
      expect(review.rewriteInstructions).toContain('删除关于100亿融资');
    });
  });

  describe('Full Pipeline Integration with Pi Agent', () => {
    it('executes closed-loop pipeline with Author Agent drafting and Critic Agent reviewing', async () => {
      const post = {
        id: 'p-pi-job',
        postId: 'pi-1',
        authorUsername: 'deepseek',
        sourceUrl: 'https://x.com/deepseek/status/pi-1',
        text: 'DeepSeek-V3 architecture paper is released.',
        rawData: { id: 'pi-1', text: 'DeepSeek-V3 architecture paper is released.' },
        createdAt: new Date(),
      };
      const job = {
        id: 'j-pi-job',
        status: 'detected',
        metadata: {},
        detectedAt: new Date(),
        postId: post.id,
        sourceId: 's-pi',
        post,
        source: { handle: 'deepseek' },
        draft: null,
      };

      const updates = [];
      const prisma = {
        earlyBirdArticleJob: {
          findUnique: vi.fn(async () => job),
          findMany: vi.fn(async () => []),
          update: vi.fn(async ({ data }) => {
            updates.push(data);
            return { ...job, ...data };
          }),
        },
        earlyBirdPost: { update: vi.fn(async () => ({})) },
        earlyBirdEditorialReview: { create: vi.fn(async ({ data }) => data) },
      };

      const validBody = '开源社区直接沸腾！DeepSeek 凌晨发布全新架构论文，彻底公开核心训练秘密。\n\n' +
        '论文明确披露，新架构在多项核心基准测试上均取得优异成绩，推理效率更是大幅跃升。\n\n' +
        '不仅如此，团队还直接公布了多项关键技术参数，为后续开源生态发展奠定了坚实基础。';

      const authorAgent = {
        write: vi.fn(async () => ({
          title: '凌晨突发！DeepSeek架构论文公开：彻底不装了',
          candidateTitles: [
            '凌晨突发！DeepSeek架构论文公开：彻底不装了',
            '架构完全公开：DeepSeek最新论文引爆全网',
          ],
          digest: 'DeepSeek 正式公开全新架构论文细节。',
          markdown: `![架构图](data/paper.png)\n\n${validBody}`,
        })),
      };

      const criticAgent = {
        screen: vi.fn(async () => ({ newsworthy: 9, hasConcreteFact: true, reason: '架构论文重磅发布' })),
        triage: vi.fn(async () => ({ decision: 'pass', contentType: 'brief', qualityScore: 90, issues: [], rewriteInstructions: '', relatedJobIds: [], visualPlan: [] })),
        reviewDraft: vi.fn(async () => ({
          decision: 'pass',
          contentType: 'brief',
          qualityScore: 96,
          title: '凌晨突发！DeepSeek架构论文公开：彻底不装了',
          issues: [],
          rewriteInstructions: '',
          relatedJobIds: [],
          visualPlan: [],
        })),
      };

      const originalWait = process.env.EARLYBIRD_THREAD_WAIT_MS;
      process.env.EARLYBIRD_THREAD_WAIT_MS = '0';
      try {
        const llmClient = {
          complete: vi.fn(async ({ system }) => {
            if (system.includes('Humanizer-zh')) return { markdown: validBody, score: 50 };
            return { title: 'DeepSeek架构论文', markdown: validBody };
          }),
        };

        const pipeline = createArticlePipeline({
          prisma,
          scraperFactory: async () => ({ scrapeFullThread: async () => [post.rawData] }),
          mediaPipeline: { collect: vi.fn(async () => [{ kind: 'image', localPath: 'data/paper.png' }]) },
          evidence: vi.fn(async () => ({})),
          analyze: vi.fn(async () => ({ translation: '', digest: '论文发布', facts: ['架构公开'] })),
          wechatClient: null,
          llmClient,
          authorAgent,
          criticAgent,
        });

        const result = await pipeline.process(job.id);
        expect(result.status).toBe('rendered');
        expect(criticAgent.screen).toHaveBeenCalled();
        expect(criticAgent.triage).toHaveBeenCalled();
        expect(authorAgent.write).toHaveBeenCalled();
        expect(criticAgent.reviewDraft).toHaveBeenCalled();
        expect(result.html).toContain('凌晨突发！DeepSeek架构论文公开');
        expect(result.markdown).toContain('开源社区直接沸腾');
      } finally {
        if (originalWait === undefined) delete process.env.EARLYBIRD_THREAD_WAIT_MS;
        else process.env.EARLYBIRD_THREAD_WAIT_MS = originalWait;
      }
    });
  });
});
