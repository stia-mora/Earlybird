// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { Agent } from '@earendil-works/pi-agent-core';
import { createPiStreamFn } from './agentStream.js';
import { createEarlyBirdTools } from './agentTools.js';
import {
  createEditorialOrchestrator,
  draftQualityIssues,
  normalizeEditorialDecision,
} from './editorialReview.js';

const CRITIC_SYSTEM_PROMPT = `你是独立于撰稿作者的【资深事实核查员与对抗总编审（Adversarial Editor-in-Chief）】。
你的态度应当是：冷酷、严苛、挑剔，默认怀疑草稿中可能存在夸大、幻觉、移花接木与官样文章。

【核心职责与工具核验】
你配备了独立工具集：
1. search_web_research: 对草稿中提出的关键数据（跑分、融资额、发布日期、参数量）、争议结论或官方言论进行独立检索核验（Cross-check），核查是否属实或存在幻觉。
2. fetch_tweet_thread: 核查草稿中的引语是否断章取义，是否脱离了原推的真实上下文。
3. render_gzh_draft: 检查文章最终渲染为微信公众号样式时是否存在排版违规、非法字符或标签问题。

【四大审校维度】
1. 事实真实性与反幻觉（一票否决）：
   - 检查草稿中的每一个技术指标、时间点、人物引言是否有原帖或已证实文献支持。
   - 凡未经证实的重大断言或数字编造，立即判为 rewrite 或 drop。
2. 文风与去AI味（新智元标准）：
   - 首句检查：第一句是否直接击中矛盾或反差？严禁“近日”、“在当今快速发展的人工智能领域”等昏睡开篇。
   - 语调检查：坚决剔除“标志着…的深远意义”、“凸显了…的重要性”、“赋能”、“值得注意的是”等公文腔与 AI 味。
   - 短句节奏：段落是否冗长（单段不得超过 260 字符），是否有生动口语短句。
3. 标题审定（Title Picking）：
   - 从草稿提供的 candidateTitles 中，挑出最具冲击力、最真实、最契合新智元风格的标题，作为选定的 title 输出。
4. 配图与存证审查：
   - 检查正文中的插图是否真实存在、是否紧扣相邻文字，图注是否准确干净。

【输出格式】
只输出标准的 JSON，格式如下：
{
  "decision": "pass" | "rewrite" | "drop" | "merge",
  "qualityScore": 88,
  "title": "最终审定推荐标题",
  "issues": ["问题1：首句缺少抓人钩子", "问题2：第3段参数断言缺少来源支撑"],
  "rewriteInstructions": "精确的手术式修改指令：将开篇第一句改为突出突破性实测数据；删除第3段未证实的参数推测。",
  "verifiedFacts": ["核心事实1已核实"],
  "hallucinations": ["存疑或夸大的表述"],
  "reason": "总体审校结论摘要"
}`;

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return null;
  }
}

export function createCriticAgent({
  streamFn,
  client,
  tools = [],
  model = { id: process.env.EARLYBIRD_LLM_MODEL || 'gpt-4o-mini', name: 'Critic LLM', api: 'openai-completions', provider: 'earlybird' },
  logger = console,
} = {}) {
  const effectiveStreamFn = streamFn || createPiStreamFn({ client, model: model.id, logger });
  const effectiveTools = tools.length > 0 ? tools : createEarlyBirdTools({ logger });
  const fallbackOrchestrator = createEditorialOrchestrator({ client });

  return {
    async screen(params) {
      return fallbackOrchestrator.screen(params);
    },

    async triage(params) {
      return fallbackOrchestrator.triage(params);
    },

    async coordinate(params) {
      return fallbackOrchestrator.coordinate(params);
    },

    async reviewDraft({
      job,
      article,
      editorial = {},
      storyPosts = [],
      candidates = [],
      assets = [],
      references = [],
      humanizerScore,
      attempt = 1,
    } = {}) {
      const localIssues = draftQualityIssues({
        markdown: article?.markdown,
        contentType: editorial?.contentType,
        storyPosts,
        assets,
        references,
        humanizerScore,
      });

      const agent = new Agent({
        streamFn: effectiveStreamFn,
        initialState: {
          model,
          tools: effectiveTools,
          systemPrompt: CRITIC_SYSTEM_PROMPT,
        },
      });

      const promptPayload = {
        task: '独立事实核查与对抗审校',
        attempt,
        sourcePost: {
          author: job?.post?.authorUsername || job?.source?.handle,
          text: job?.post?.text || '',
          url: job?.post?.sourceUrl || '',
        },
        editorial: {
          contentType: editorial.contentType || 'brief',
          requirements: editorial.reason || '',
        },
        candidateTitles: article?.candidateTitles || [article?.title].filter(Boolean),
        currentTitle: article?.title,
        digest: article?.digest,
        markdown: article?.markdown,
        availableAssets: (assets || []).map(a => ({ localPath: a.localPath, sourceUrl: a.sourceUrl })),
        references,
        localIssues,
      };

      await agent.prompt(JSON.stringify(promptPayload));

      const messages = agent.state.messages;
      const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
      const textContent = (lastAssistantMsg?.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      const parsed = extractJson(textContent);
      const rawDecision = {
        decision: parsed?.decision || (localIssues.length > 0 ? 'rewrite' : 'pass'),
        contentType: editorial.contentType || 'brief',
        qualityScore: parsed?.qualityScore ?? (localIssues.length > 0 ? 65 : 88),
        issues: [...(localIssues || []), ...(parsed?.issues || [])],
        rewriteInstructions: parsed?.rewriteInstructions || '',
        title: parsed?.title || article?.title,
        reason: parsed?.reason || '',
        verifiedFacts: parsed?.verifiedFacts || [],
        hallucinations: parsed?.hallucinations || [],
        toolsExecuted: messages.filter(m => m.role === 'toolResult').map(m => m.toolName),
      };

      return normalizeEditorialDecision(rawDecision, {
        job,
        candidates,
        phase: 'draft',
        localIssues,
      });
    },
  };
}
