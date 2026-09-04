import { fullWidthPunctuation } from './utils.js';

export function createArticleWriter({ client } = {}) {
  return {
    async write({ post, thread = [], analysis = {}, evidencePath, sourceUrl }) {
      if (!client) return fallback({ post, thread, analysis, evidencePath, sourceUrl });
      const response = await client.complete({ system: '你是中文科技编辑。写作要自然、克制、具体，避免宣传腔。只返回 JSON，字段为 title、digest、markdown。Markdown 必须按：标题与摘要、原帖证据截图、截图下方中文翻译、事件事实与媒体叙事、影响分析、完整来源和转载说明。', user: JSON.stringify({ post, thread, analysis, evidencePath, sourceUrl }) });
      return response?.markdown ? response : fallback({ post, thread, analysis, evidencePath, sourceUrl });
    },
  };
}

function fallback({ post, thread, analysis, evidencePath, sourceUrl }) {
  const title = fullWidthPunctuation((analysis.facts?.[0] || post.text || 'AI 动态速递').slice(0, 32));
  const translation = fullWidthPunctuation(analysis.translation || post.text || '暂无中文翻译');
  const facts = (analysis.facts || []).map(item => `- ${fullWidthPunctuation(item)}`).join('\n') || `- ${fullWidthPunctuation(post.text || '暂无事实摘要')}`;
  const media = (analysis.imageDescriptions || []).map(item => `- ${fullWidthPunctuation(item)}`).join('\n');
  const markdown = `# ${title}\n\n> ${fullWidthPunctuation(analysis.digest || '来自 X 一线账号的最新消息。')}\n\n## 原帖证据\n\n![原帖证据](${evidencePath || ''})\n\n## 中文翻译\n\n${translation}\n\n## 事件事实与媒体叙事\n\n${facts}\n\n${media ? `${media}\n\n` : ''}## 影响分析\n\n这条消息的影响仍需结合后续官方信息观察，本文只整理目前可以核实的内容。\n\n## 来源与转载说明\n\n作者：@${post.author?.username || post.authorUsername || 'unknown'}。发布时间：${post.createdAt || '未知'}。原帖：[查看 X 原文](${sourceUrl || ''})。本文为信息整理与翻译，转载前请确认平台规则及版权授权。`;
  return { title, digest: analysis.digest || '来自 X 一线账号的最新消息。', markdown };
}
