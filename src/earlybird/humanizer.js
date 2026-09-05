import { readFile } from 'node:fs/promises';
import { compactEditorialMarkdown, hasCompactPresentation, hasSufficientBody, markdownBodyLength, markdownHeadingCount, markdownImagePaths } from './articleWriter.js';

const DEFAULT_RULES = ['避免“值得注意的是”“不仅……而且……”等模板化句式', '删除空泛总结和过度分段', '保留事实、数字、引用和不确定性', '使用自然的中文短句，避免宣传腔'];

export async function loadHumanizerRules(root = new URL('../../vendor/references/humanizer-zh/SKILL.md', import.meta.url)) {
  try { return await readFile(root, 'utf8'); } catch { return DEFAULT_RULES.join('\n'); }
}

export function scoreHumanized(markdown) {
  const text = String(markdown || '');
  let score = 50;
  const penalties = [/值得注意的是/g, /综上所述/g, /不仅[^。]{0,40}而且/g, /总而言之/g, /在当今/g, /赋能/g, /生态/g];
  for (const pattern of penalties) score -= Math.min(2, (text.match(pattern) || []).length);
  if (text.length < 180) score -= 3;
  if ((text.match(/\n## /g) || []).length > 8) score -= 2;
  return Math.max(0, Math.min(50, score));
}

export async function humanize({ client, markdown, context = {}, rulesText } = {}) {
  const rules = rulesText || await loadHumanizerRules();
  if (!client) return { markdown, score: scoreHumanized(markdown), attempts: 0, manualReview: scoreHumanized(markdown) < 45 };
  let current = compactEditorialMarkdown(markdown);
  const contentType = context.editorial?.contentType;
  const originalLength = markdownBodyLength(markdown);
  const originalHeadings = markdownHeadingCount(markdown);
  const originalImages = markdownImagePaths(markdown).length;
  let score = 0;
  let attempts = 0;
  while (attempts <= 2) {
    const result = await client.complete({ system: `严格执行 Humanizer-zh 的 24 类 AI 痕迹检查。保留事实和来源，不改变数字、专名、链接和引用。不得把文章重写成固定六段式；保留现有动态小标题。contentType 为 brief 时不得新增小标题。正文必须保持短段落，每段不超过 96 个字符；禁止输出 **、*、__ 等 Markdown 强调或星号列表。规则摘录：\n${rules.slice(0, 12000)}\n只返回 JSON：markdown、score（总分 50）、changes。`, user: JSON.stringify({ markdown: current, context }) });
    const candidate = result?.markdown ? compactEditorialMarkdown(result.markdown) : null;
    const preservesDensity = candidate
      && hasSufficientBody(candidate, contentType)
      && hasCompactPresentation(candidate)
      && markdownBodyLength(candidate) >= Math.floor(originalLength * 0.75)
      && markdownHeadingCount(candidate) >= originalHeadings
      && markdownImagePaths(candidate).length >= originalImages;
    if (preservesDensity) current = candidate;
    score = preservesDensity ? (Number(result?.score) || scoreHumanized(current)) : scoreHumanized(current);
    attempts += 1;
    if (score >= 45) break;
  }
  return { markdown: current, score, attempts, manualReview: score < 45 };
}
