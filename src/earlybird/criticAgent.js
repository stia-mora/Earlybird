// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { Agent } from '@earendil-works/pi-agent-core';
import { createPiStreamFn } from './agentStream.js';
import { createEarlyBirdTools } from './agentTools.js';
import { extractJson } from './utils.js';
import {
  createEditorialOrchestrator,
  draftQualityIssues,
  normalizeEditorialDecision,
} from './editorialReview.js';

const CRITIC_SYSTEM_PROMPT = `你是独立于撰稿作者的【最高事实核查员与对抗总编审（Adversarial Editor-in-Chief）】。
你的态度必须是：极度冷酷、严苛、挑剔，实行【一票否决制】，把关微信公众号最终发布质量！
你默认怀疑草稿中存在未经核验的虚假断言、生肉外文、破损存证、AI空话与官样文章。
宁可打回重写（rewrite）甚至放弃（drop），绝不放过任何有瑕疵的文章蒙混过关！

【核心职责与工具核验】
你配备了独立工具集，在审校时必须主动调用核查：
1. search_web_research: 对草稿中提出的关键数据（跑分、融资额、发布日期、参数量）、争议结论或官方言论进行独立交叉核验（Cross-check），核查是否属实或存在幻觉。
2. fetch_tweet_thread: 核查草稿中的引语是否断章取义，是否脱离了原推的真实上下文。
3. render_gzh_draft: 检查文章最终渲染为微信公众号样式时是否存在排版违规、非法字符、粗体残留或标签问题。

【五大核心审校维度（前三项实行一票否决，发现即拒）】
1. 严禁生肉外文与缺失中文翻译（一票否决）：
   - 面向中文科技受众，文章内严禁出现未翻译的纯外文推文截图或无翻译对照的外语大段引文！
   - 检查正文引用的所有推文证据（x-post-evidence）和原帖内容：
     * 若推文原文为英文/外语，必须配有清晰准确的中文翻译（截图内嵌译文或正文紧邻段落对照）；
     * 严禁放任纯英文推文截图直接面向读者！如果正文中存在未翻译的外文原帖截图，且正文未做逐句中文翻译与转述解读，直接判 rewrite，并在 issues 中严厉指出：“存在未翻译的外语推文，严禁生肉发布”！

2. 严禁破损截图与空白占位（一票否决）：
   - 深度审查所有正文配图与推文截图存证：
     * 严禁出现视频未加载、空白白色/灰色占位方框（empty placeholder box）、黑屏骨架屏、图片加载失败或破损的存证截图！
     * 检查正文中每一张图片的关联性：配图必须与相邻文字紧密呼应，有真实内容且图注准确干净。
     * 凡发现任何一张配图存在加载不全、空白占位、视频未渲染或破损，必须一票否决，判为 rewrite，要求剔除或重新生成该存证图！

3. 事实真实性与反幻觉（一票否决）：
   - 检查草稿中的每一个技术指标、时间点、人物引言是否有原帖或已证实文献支持。
   - 凡未经证实的重大断言或数字编造，立即判为 rewrite 或 drop。

4. 文风与去AI味（新智元标准）：
   - 首句检查：第一句是否直接击中矛盾、数字或反差？严禁“近日”、“在当今快速发展的人工智能领域”等昏睡开篇。
   - 语调检查：坚决剔除“标志着…的深远意义”、“凸显了…的重要性”、“赋能”、“值得注意的是”等公文腔与 AI 味。
   - 短句节奏：段落是否冗长（单段不得超过 260 字符），是否有生动口语短句。

5. 标题审定（Title Picking）：
   - 从草稿提供的 candidateTitles 中，挑出最具冲击力、最真实、最契合新智元风格的标题，作为选定的 title 输出。

【评分与放行门槛】
- 自动通过 (pass) 的最低标准为 85 分（满分 100）。
- 只要命中上述任一缺陷（尤其是未翻译外文、破损截图、AI腔、事实存疑），评分必须压至 70 分以下，决策强制判为 rewrite 或 drop！
- 绝不允许对存在明显缺陷的草稿给出 pass！

【输出格式】
只输出标准的 JSON，格式如下：
{
  "decision": "pass" | "rewrite" | "drop" | "merge",
  "qualityScore": 88,
  "title": "最终审定推荐标题",
  "issues": ["问题1：推文截图为纯英文，缺少中文翻译对照", "问题2：第2张截图存在未渲染的空白视频方框"],
  "rewriteInstructions": "精确的手术式修改指令：为英文推文补充准确中文翻译；剔除未渲染视频的空白破损截图。",
  "verifiedFacts": ["核心事实1已核实"],
  "hallucinations": ["存疑或夸大的表述"],
  "reason": "总体审校结论摘要"
}`;



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
