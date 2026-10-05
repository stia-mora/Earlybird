// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { readFile } from 'node:fs/promises';
import { editorialImages, hasCompactPresentation, hasSufficientBody, markdownBodyLength, markdownHeadingCount, markdownImagePaths, prepareEditorialMarkdown } from './articleWriter.js';
import { loadExplainerSkills } from './explainerSkills.js';

const DEFAULT_RULES = [
  '避免“值得注意的是”“不仅……而且……”等模板化句式',
  '坚决删除“表明”“意味着”“凸显了”“彰显了”“迈出了坚实一步”等公文通稿套话',
  '删除空泛总结，允许单句成段制造冲击，不机械合并或拆碎段落',
  '保留事实、数字、引用和不确定性，鼓励口语化短句和有事实支撑的情绪判断',
];

export async function loadHumanizerRules(root = new URL('../../vendor/references/humanizer-zh/SKILL.md', import.meta.url)) {
  try { return await readFile(root, 'utf8'); } catch { return DEFAULT_RULES.join('\n'); }
}

export function scoreHumanized(markdown) {
  const text = String(markdown || '');
  let score = 50;
  const penalties = [
    /值得注意的是/g, /综上所述/g, /不仅[^。]{0,40}而且/g, /总而言之/g, /在当今/g, /赋能/g, /生态/g,
    /表明/g, /意味着/g, /凸显了/g, /彰显了/g, /迈出了坚实一步/g, /深远影响/g,
  ];
  for (const pattern of penalties) score -= Math.min(2, (text.match(pattern) || []).length);
  if (text.length < 180) score -= 3;
  if ((text.match(/(?:^|\n)## /g) || []).length > 8) score -= 2;
  return Math.max(0, Math.min(50, score));
}

export async function humanize({ client, markdown, context = {}, rulesText, visualAssets = [] } = {}) {
  const rules = rulesText || await loadHumanizerRules();
  if (!client) return { markdown, score: scoreHumanized(markdown), attempts: 0, manualReview: scoreHumanized(markdown) < 45 };
  const contentType = context.editorial?.contentType;
  const skillRules = contentType === 'explainer' ? await loadExplainerSkills() : '';
  const prepare = value => prepareEditorialMarkdown(value, contentType);
  let current = prepare(markdown);
  const originalLength = markdownBodyLength(markdown);
  const originalHeadings = markdownHeadingCount(markdown);
  const originalImages = new Set(markdownImagePaths(markdown).map(path => path.replace(/\\/g, '/')));
  let score = 0;
  let attempts = 0;
  while (attempts <= 2) {
    const result = await client.complete({ system: `严格执行去 AI 痕迹与去公文腔检查（保持新智元风格）。保留事实和来源，不改变数字、专名、链接和引用。严禁“值得注意的是”“赋能”“表明”“意味着”“凸显了”“彰显了”“迈出了坚实一步”“综上所述”等公文与 AI 套话。鼓励生动、口语化短句和有事实支撑的情绪判断，允许单句成段制造冲击，不要机械合并或拆碎段落。不得把文章重写成固定六段式；保留现有动态小标题。contentType 为 brief 时不得新增小标题。不得向读者解释原始数据、OCR 或采集过程，也不写阅读量、点赞、转发、收藏、回复、引用等互动指标；时间最多精确到分钟。保留每张图片的原路径、顺序和图注含义，不得合并、删除或替换图片，不得把图注改成泛泛的标签。中文句子使用中文标点，英文原句和版本号保留英文标点。禁止输出 **、*、__ 等 Markdown 强调或星号列表。规则摘录：\n${contentType === 'explainer' ? skillRules : rules}\n只返回 JSON：markdown、score（总分 50）、changes。`, user: JSON.stringify({ markdown: current, context, availableVisuals: visualAssets }), images: contentType === 'explainer' ? editorialImages(visualAssets) : [] });
    const candidate = result?.markdown ? prepare(result.markdown) : null;
    const preservesDensity = candidate
      && hasSufficientBody(candidate, contentType)
      && hasCompactPresentation(candidate)
      && markdownBodyLength(candidate) >= Math.floor(originalLength * 0.75)
      && markdownHeadingCount(candidate) >= originalHeadings
      && (contentType !== 'brief' || markdownHeadingCount(candidate) === 0)
      && [...originalImages].every(path => markdownImagePaths(candidate).some(candidatePath => candidatePath.replace(/\\/g, '/') === path));
    if (preservesDensity) current = candidate;
    score = preservesDensity ? (Number(result?.score) || scoreHumanized(current)) : scoreHumanized(current);
    attempts += 1;
    if (score >= 45) break;
  }
  return { markdown: current, score, attempts, manualReview: score < 45 };
}
