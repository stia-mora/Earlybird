// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { Agent } from '@earendil-works/pi-agent-core';
import { createPiStreamFn } from './agentStream.js';
import { createEarlyBirdTools } from './agentTools.js';
import { extractJson, sanitizeUnicode } from './utils.js';
import {
  articleVisualAssets,
  prepareEditorialMarkdown,
} from './articleWriter.js';

const AUTHOR_SYSTEM_PROMPT = `你是中文科技深度报道资深主笔（风格对标新智元一线科技主笔）。
你的目标是：根据给定的核心推文、素材或修订意见，自主规划并调用工具获取完整事实证据，撰写一篇事实硬核、文风极具抓人力的微信公众号深度好文。

【工具使用自主规划原则】
你拥有以下标准工具，请根据当前材料的完整度自主决定是否调用：
1. fetch_tweet_thread: 当原帖信息单薄、属于长推文串（Thread）或作者在后续回复中给出了核心补充时，主动调用该工具获取完整上下文。
2. search_web_research: 当原帖缺乏官方博客链接、关键技术指标未说明、存在需要求证的行业背景或评测跑分时，主动检索官方或权威来源。
3. capture_tweet_evidence: 当需要对核心原帖进行视觉存证（作为文章插图），且现有素材中缺少该推文的高清截图时调用。
4. render_gzh_draft: 在完成初稿后，调用此工具排版并自查 HTML 合规性（是否残留粗体语法、单段字数超限、图片缺失等）。根据校验反馈及时调整。

【新智元式文风黄金法则】
1. 首句暴击（Hook）：开篇第一句绝不写背景铺陈（严禁“随着人工智能的发展…”、“近日…”），直接以重磅事实、反差或戏剧性冲突开局（如“这波属实离谱！”、“开源社区直接炸锅了！”、“一夜之间暴涨10倍，某某模型干翻全场！”）。
2. 口语短句，坚决拒绝公文腔：严禁“标志着团队研发战略的收拢”、“凸显了…的重要性”、“赋能各行各业”等假大空公文腔和典型 AI 腔（“值得注意的是”）。多用人话、对话感强的短句，段落控制在 3-4 行（150-250 字符）。
3. 事实硬核，情绪有据：情绪不是凭空吹捧，每一句惊叹都有硬核数字、论文图表或实测对比支撑。
4. 候选标题库（Candidate Titles）：必须生成 2-5 个不同风格的精选标题（事实冲击型、悬念反差型、冲突口语型、行业定性型），放在 candidateTitles 中，供主审挑选，并把最推荐的一个赋给 title。
5. 插图与外语翻译规范（严审铁律）：
   - 每张图片必须是真实素材路径，下方配简洁说明与来源（例如：来源：X 原帖截图）。
   - 【严禁生肉外语】：若引用或展示了外文原帖截图，必须在正文紧邻段落给出清晰的中文翻译与原意转述，绝不能让读者直接面对未经翻译的大段英文！
   - 【严禁破损与空白占位】：严禁引用视频未加载、空白白色方块、黑屏骨架或破损失效的存证图片。
6. 排版与篇幅：
   - brief（快讯）：350-700 字，至少 1 张图；
   - explainer（深度解读）：1200-1800 字，3-5 个叙事二级/三级标题，至少 5 张图；
   - event（事件合稿）：1800-2600 字，时间线串联，至少 3 张图。
   - 严禁 Markdown 加粗（**）、斜体（*、__）或星号列表，强调效果交由排版器处理。

【最终输出要求】
当你完成所有调研、写作与排版自查后，请直接输出最终的 JSON 格式（不要使用额外 Markdown 标记包裹）：
{
  "title": "选定的最佳主标题（64字以内）",
  "candidateTitles": [
    "候选标题1（数字/反差）",
    "候选标题2（口语冲突）",
    "候选标题3（事实冲击）"
  ],
  "digest": "吸引点击的摘要导读（12-60字）",
  "markdown": "完整排版好的 Markdown 正文（包含标题、插图和正文）",
  "references": ["引用的来源链接列表"]
}`;

export function createAuthorAgent({
  streamFn,
  client,
  tools = [],
  model = { id: process.env.EARLYBIRD_LLM_MODEL || 'gpt-4o-mini', name: 'Author LLM', api: 'openai-completions', provider: 'earlybird' },
  logger = console,
} = {}) {
  const effectiveStreamFn = streamFn || createPiStreamFn({ client, model: model.id, logger });
  const effectiveTools = tools.length > 0 ? tools : createEarlyBirdTools({ logger });

  return {
    async write({
      post,
      thread = [],
      analysis = {},
      editorial = {},
      storyPosts = [],
      research = {},
      assets = [],
      sourceUrl = post?.sourceUrl || '',
      previousMarkdown = '',
      revisionInstructions = '',
    } = {}) {
      const visualAssets = articleVisualAssets(assets);
      const agent = new Agent({
        streamFn: effectiveStreamFn,
        initialState: {
          model,
          tools: effectiveTools,
          systemPrompt: AUTHOR_SYSTEM_PROMPT,
        },
      });

      const promptPayload = {
        task: revisionInstructions ? '根据审校意见修改并优化文章' : '撰写全新科技深度报道',
        post: {
          id: post?.postId || post?.id,
          author: post?.authorUsername || post?.author,
          url: sourceUrl,
          text: sanitizeUnicode(post?.text || ''),
          createdAt: post?.createdAt,
        },
        thread: (thread || []).slice(0, 10).map(t => ({
          author: t.author?.username || t.user?.screen_name || post?.authorUsername,
          text: t.text || t.full_text || '',
        })),
        analysis,
        editorial: {
          contentType: editorial.contentType || 'brief',
          reason: editorial.reason || '',
        },
        storyPosts,
        availableVisuals: visualAssets,
        availableAssets: visualAssets,
        research,
        sourceUrl,
        previousMarkdown: previousMarkdown ? previousMarkdown.slice(0, 3000) : undefined,
        revisionInstructions: revisionInstructions || undefined,
      };

      await agent.prompt(JSON.stringify(promptPayload));

      const messages = agent.state.messages;
      const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
      const textContent = (lastAssistantMsg?.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      const parsed = extractJson(textContent);
      const prepare = md => prepareEditorialMarkdown(md, editorial.contentType);

      if (parsed && parsed.markdown && parsed.title) {
        const preparedMarkdown = prepare(parsed.markdown);
        return {
          title: parsed.title,
          candidateTitles: Array.isArray(parsed.candidateTitles) && parsed.candidateTitles.length
            ? parsed.candidateTitles
            : [parsed.title],
          digest: parsed.digest || '',
          markdown: preparedMarkdown,
          references: parsed.references || [],
          toolsExecuted: messages.filter(m => m.role === 'toolResult').map(m => m.toolName),
        };
      }

      if (textContent) {
        const preparedMarkdown = prepare(parsed?.markdown || textContent);
        return {
          title: parsed?.title || (textContent.split('\n')[0] || '深度解析').replace(/^#+\s*/, '').slice(0, 60),
          candidateTitles: parsed?.candidateTitles || [parsed?.title || '深度解析'],
          digest: parsed?.digest || textContent.slice(0, 80),
          markdown: preparedMarkdown,
          references: parsed?.references || [],
          toolsExecuted: messages.filter(m => m.role === 'toolResult').map(m => m.toolName),
        };
      }

      throw new Error('Author Agent completed run but produced no textual output');
    },
  };
}
