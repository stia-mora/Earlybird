// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { articleVisualAssets, editorialStructureIssues, prepareEditorialMarkdown } from '../src/earlybird/articleWriter.js';
import { contentStandard, draftQualityIssues, normalizeEditorialDecision, normalizeVisualPlan } from '../src/earlybird/editorialReview.js';
import { loadExplainerSkills } from '../src/earlybird/explainerSkills.js';
import { renderGzhMarkdown, validateGzhHtml } from '../src/earlybird/gzhRenderer.js';
import { collectTavilyImages, createTavilyImageSearch } from '../src/earlybird/tavilyImageSearch.js';

describe('explainer reading and visual standards', () => {
  it('loads both complete skills, including narrative, sourcing and humanizer scoring', async () => {
    const rules = await loadExplainerSkills();
    expect(rules).toContain('早鸟公众号图文写作');
    expect(rules).toContain('在 X 找证据');
    expect(rules).toContain('Humanizer-zh: 去除 AI 写作痕迹');
    expect(rules).toContain('真实性');
    expect(rules).toContain('总分 50');
    expect(rules).toContain('五张是底线');
    expect(rules).toContain('不能只换几个词');
  });

  it('requires five distinct inserted visuals and rejects paths outside the supplied assets', () => {
    const visuals = ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'].map(localPath => ({ kind: 'image', localPath }));
    const repeated = Array.from({ length: 5 }, () => '![同一画面](one.png)').join('\n\n');
    expect(editorialStructureIssues(repeated, 'explainer', visuals)).toContain('需要插入至少 5 张不同的真实素材图片');
    const inserted = visuals.map(asset => `![画面中的证据与条件](${asset.localPath})`).join('\n\n');
    expect(editorialStructureIssues(inserted, 'explainer', visuals)).not.toContain('需要插入至少 5 张不同的真实素材图片');
    expect(editorialStructureIssues(`${inserted}\n\n![](unknown.png)`, 'explainer', visuals)).toEqual(expect.arrayContaining(['存在未提供的正文图片路径', '每张解读配图必须有图下注释']));
    expect(contentStandard('explainer').minVisuals).toBe(5);
    expect(contentStandard('event').minVisuals).toBe(3);
    expect(draftQualityIssues({ contentType: 'explainer', humanizerScore: 44 })).toContain('去 AI 味评分未达到 45／50，需要实质改写');
    expect(draftQualityIssues({ contentType: 'explainer', humanizerScore: 45 })).not.toContain('去 AI 味评分未达到 45／50，需要实质改写');
    expect(articleVisualAssets([{ ...visuals[0], sha256: 'same' }, { ...visuals[1], sha256: 'same' }])).toHaveLength(1);
  });

  it('keeps the author’s paragraph structure and plans beyond the minimum image count', () => {
    const markdown = '先让读者看清正在发生的动作。再解释这一步为什么难。\n\n原因与后果属于同一段。这里不应被机械拆成两行。';
    expect(prepareEditorialMarkdown(markdown, 'explainer')).toBe(markdown);
    const plan = normalizeVisualPlan([], { job: { post: { text: '机器人厨房演示' } }, contentType: 'explainer' });
    expect(plan.length).toBeGreaterThan(5);
    expect(new Set(plan.map(item => item.query)).size).toBe(plan.length);
    expect(new Set(plan.map(item => item.purpose)).size).toBe(plan.length);
  });

  it('keeps draft-review supplementation targeted instead of repeating the default searches', () => {
    const job = { post: { text: '机器人厨房演示' } };
    const ready = normalizeEditorialDecision({ decision: 'pass', contentType: 'explainer', qualityScore: 90 }, { job, phase: 'draft' });
    expect(ready.visualPlan).toEqual([]);
    const missing = normalizeEditorialDecision({ decision: 'rewrite', contentType: 'explainer', visualPlan: [{ query: 'robot task success rate figure', purpose: '补足测试条件' }] }, { job, phase: 'draft' });
    expect(missing.visualPlan).toHaveLength(1);
    expect(missing.visualPlan[0].purpose).toBe('补足测试条件');
  });

  it('keeps one concise image note and moves full source URLs into the final references', async () => {
    const caption = '橙色柱表示位置误差，数值越低越好。';
    const references = Array.from({ length: 8 }, (_, index) => `https://example.org/report/${index}`);
    const html = await renderGzhMarkdown(`![${caption}](figure.png)`, {
      contentType: 'explainer',
      references,
      imageAttributions: [{ src: 'figure.png', sourceUrl: 'https://example.org/paper', label: '图片来源：原论文' }],
    });
    const note = html.match(/<img[^>]+>\s*<p[^>]+><span leaf="">([^<]*)<\/span><\/p>/)?.[1];
    expect(note).toBe(`${caption}来源：原论文`);
    expect(note).not.toContain('https://');
    expect(html.indexOf('https://example.org/paper')).toBeGreaterThan(html.indexOf('参考资料：'));
    expect(html).not.toContain('图片来源：原论文：https://example.org/paper');
    expect(html.match(new RegExp(caption, 'g'))).toHaveLength(2); // accessible alt and visible caption
    await validateGzhHtml(html);
  });
});

describe('complete visual-plan collection over HTTP', () => {
  it('searches all story nodes beyond five images, even with five existing assets', async () => {
    const names = ['claude', 'deepseek', 'gemini', 'gpt', 'grok', 'logo', 'icon-192', 'icon-512'];
    // Valid 1x1 transparent PNG payload used to serve unique test image responses
    const MINIMAL_PNG_BYTES = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex'
    );
    const buffers = names.map((_name, index) => Buffer.concat([MINIMAL_PNG_BYTES, Buffer.from([index])]));
    const queries = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/search') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { query } = JSON.parse(Buffer.concat(chunks).toString());
        queries.push(query);
        const index = Number(query.split('-')[1]) * 2;
        const base = `http://127.0.0.1:${server.address().port}`;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ images: [0, index, index + 1].map(value => ({ url: `${base}/media/${value}`, description: names[value] })), results: [] }));
        return;
      }
      const index = Number(request.url.split('/').at(-1));
      response.setHeader('content-type', 'image/png');
      response.end(buffers[index]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const outputDir = await mkdtemp(join(tmpdir(), 'earlybird-complete-plan-'));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const search = createTavilyImageSearch({ apiKey: 'local-test', endpoint: `${base}/search` });
      const visualPlan = Array.from({ length: 4 }, (_, index) => ({ query: `node-${index}`, purpose: `阅读节点 ${index}` }));
      const input = { search, post: { id: 'local', postId: 'local' }, visualPlan, needed: 5, completePlan: true, outputDir };
      const assets = await collectTavilyImages(input);
      expect(queries).toEqual(visualPlan.map(item => item.query));
      expect(assets).toHaveLength(8);
      expect(new Set(assets.map(asset => asset.sha256)).size).toBe(8);
      expect(assets.every(asset => asset.metadata.sourceStatus === 'original-page-missing')).toBe(true);
      for (const asset of assets) expect(createHash('sha256').update(await readFile(asset.localPath)).digest('hex')).toBe(asset.sha256);
      queries.length = 0;
      const more = await collectTavilyImages({ ...input, needed: 0, existingAssets: assets.slice(0, 5) });
      expect(queries).toEqual(visualPlan.map(item => item.query));
      expect(more).toHaveLength(3);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
