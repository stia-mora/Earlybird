import { join } from 'node:path';
import { assembleThread } from './threadAssembler.js';
import { analyzePost, createMultimodalClient } from './aiPipeline.js';
import { humanize } from './humanizer.js';
import { renderGzhMarkdown, validateGzhHtml } from './gzhRenderer.js';
import { captureEvidence } from './evidenceCapture.js';
import { createMediaPipeline } from './mediaPipeline.js';
import { articleVisualAssets, createArticleWriter } from './articleWriter.js';
import { createWeChatClient } from './wechatClient.js';
import { classifyEditorial } from './editorialClassifier.js';
import { collectResearchImages, researchOfficialSources } from './researchBrowser.js';

const MERGEABLE_STATUSES = ['detected', 'classified', 'held', 'captured', 'failed'];

function jobMetadata(job) {
  return job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
}

function eventWindowMs() {
  return Math.max(1, configuredNumber('EARLYBIRD_EVENT_WINDOW_MINUTES', 60)) * 60 * 1000;
}

function configuredNumber(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function collectAssets({ prisma, mediaPipeline, post, thread }) {
  const collected = await mediaPipeline.collect({ post, thread });
  const threadPostIds = new Set([
    post.postId,
    post.rawData?.id,
    ...thread.map(item => item?.id || item?.id_str),
  ].filter(Boolean).map(String));
  const belongsToThread = asset => !asset.metadata?.tweetId || threadPostIds.has(String(asset.metadata.tweetId));
  const threadAssets = collected.filter(belongsToThread);
  if (!prisma?.earlyBirdAsset?.findMany) return threadAssets;
  const stored = await prisma.earlyBirdAsset.findMany({ where: { postId: post.id, localPath: { not: null } } });
  const known = new Set(threadAssets.map(asset => asset.id || `${asset.sourceUrl}:${asset.localPath}`));
  return [...threadAssets, ...stored.filter(asset => belongsToThread(asset) && !known.has(asset.id || `${asset.sourceUrl}:${asset.localPath}`))];
}

function postEvidenceAsset(post, localPath) {
  return {
    kind: 'x-post-evidence',
    localPath,
    sourceUrl: post.sourceUrl,
    metadata: { altText: `@${post.authorUsername || 'unknown'} 的 X 原帖截图` },
  };
}

function articleReferences(storyPosts, research) {
  return [...new Set([
    ...storyPosts.map(post => post.sourceUrl),
    ...(research.citations || []).map(citation => citation.url),
  ].filter(Boolean))];
}

export function createArticlePipeline({ prisma, scraperFactory, llmClient = createMultimodalClient(), wechatClient = createWeChatClient(), mediaPipeline = createMediaPipeline({ prisma }), evidence = captureEvidence, analyze = analyzePost, logger = console } = {}) {
  const writer = createArticleWriter({ client: llmClient });
  return {
    async process(jobId, { force = false } = {}) {
      const job = await prisma.earlyBirdArticleJob.findUnique({ where: { id: jobId }, include: { post: true, source: true, draft: true } });
      if (!job) throw new Error(`EarlyBird job not found: ${jobId}`);
      if (job.draft?.mediaId || (job.status === 'verified' && !force)) return job;
      if (['ignored', 'merged'].includes(job.status) && !force) return job;
      const priorMetadata = jobMetadata(job);
      const priorEditorial = priorMetadata.editorial || {};
      if (job.status === 'held' && !force && Date.parse(priorEditorial.holdUntil || '') > Date.now()) return job;
      try {
        const scraper = await scraperFactory(job.source);
        const thread = await assembleThread({
          scraper,
          post: job.post,
          waitMs: job.status === 'held' ? 0 : Math.max(0, configuredNumber('EARLYBIRD_THREAD_WAIT_MS', 90000)),
          timeoutMs: Math.max(1000, configuredNumber('EARLYBIRD_THREAD_TIMEOUT_MS', 60000)),
        });
        await prisma.earlyBirdPost.update({ where: { id: job.postId }, data: { threadData: thread } });
        const detectedAt = job.detectedAt ? new Date(job.detectedAt) : new Date();
        const recentPosts = await prisma.earlyBirdPost.findMany({
          where: { id: { not: job.postId }, createdAt: { gte: new Date(detectedAt.getTime() - eventWindowMs()), lte: detectedAt } },
          include: { source: { select: { handle: true, website: true } }, jobs: { select: { id: true, status: true, metadata: true } } },
          orderBy: { createdAt: 'desc' },
          take: 40,
        });
        const editorial = await classifyEditorial({ client: llmClient, post: job.post, source: job.source, thread, recentPosts });
        const editorialMetadata = { ...priorMetadata, editorial };
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'classified', attempts: { increment: 1 }, error: null, metadata: editorialMetadata } });
        if (!editorial.publish) return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'ignored', metadata: editorialMetadata } });

        const firstHold = editorial.contentType === 'explainer' && !force && !priorEditorial.holdUntil;
        if (firstHold) {
          const heldEditorial = { ...editorial, holdUntil: new Date(Date.now() + eventWindowMs()).toISOString() };
          return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'held', metadata: { ...priorMetadata, editorial: heldEditorial } } });
        }

        const relatedPosts = recentPosts.filter(item => editorial.relatedPostIds.includes(item.id));
        const storyPosts = [job.post, ...relatedPosts];
        if (editorial.contentType === 'event' && relatedPosts.length) {
          await prisma.earlyBirdArticleJob.updateMany({
            where: { postId: { in: relatedPosts.map(item => item.id) }, status: { in: MERGEABLE_STATUSES } },
            data: { status: 'merged' },
          });
        }
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'captured', metadata: editorialMetadata } });
        const evidencePath = join(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', `${job.post.postId}-evidence.png`);
        const assets = await collectAssets({ prisma, mediaPipeline, post: job.post, thread });
        const relatedAssets = [];
        const relatedEvidenceAssets = [];
        for (const relatedPost of relatedPosts) {
          const relatedThread = Array.isArray(relatedPost.threadData) && relatedPost.threadData.length
            ? relatedPost.threadData
            : [relatedPost.rawData];
          relatedAssets.push(...await collectAssets({ prisma, mediaPipeline, post: relatedPost, thread: relatedThread }));
          const relatedEvidencePath = join(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', `${relatedPost.postId}-evidence.png`);
          try {
            await evidence({ tweetUrl: relatedPost.sourceUrl, postId: relatedPost.postId, translation: '', showTranslation: false, outputPath: relatedEvidencePath, thread: relatedThread });
            relatedEvidenceAssets.push(postEvidenceAsset(relatedPost, relatedEvidencePath));
          } catch (error) {
            logger.warn?.('EarlyBird related X evidence was unavailable', relatedPost.postId, error.message);
          }
        }
        const websites = [...new Set([...storyPosts.map(item => item.source?.website), job.source.website].filter(Boolean))];
        const research = editorial.contentType === 'brief'
          ? { citations: [], images: [], queries: [], allowedHosts: [] }
          : await researchOfficialSources({ queries: editorial.searchQueries, websites, logger });
        const researchAssets = await collectResearchImages({ research, post: job.post, prisma, logger });
        const allAssets = [...assets, ...relatedAssets, ...researchAssets];
        await evidence({ tweetUrl: job.post.sourceUrl, postId: job.post.postId, translation: '', outputPath: evidencePath, thread });
        const analysisPost = { ...job.post.rawData, text: job.post.text, storyPosts: storyPosts.map(item => ({ author: item.authorUsername, createdAt: item.createdAt, url: item.sourceUrl, text: item.text })) };
        const analysis = await analyze({ client: llmClient, post: analysisPost, thread, assets: allAssets, evidencePath });
        const analysisMetadata = { ...editorialMetadata, analysis, research: { citations: research.citations, queries: research.queries } };
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'analyzed', metadata: analysisMetadata } });
        await evidence({ tweetUrl: job.post.sourceUrl, postId: job.post.postId, translation: analysis.translation, outputPath: evidencePath, thread });
        const articleAssets = [...allAssets, postEvidenceAsset(job.post, evidencePath), ...relatedEvidenceAssets];
        const references = articleReferences(storyPosts, research);
        const article = await writer.write({ post: job.post, thread, analysis, editorial, storyPosts, research: { ...research, assets: allAssets.filter(asset => asset.kind === 'image').map(asset => ({ path: asset.localPath, sourceUrl: asset.sourceUrl, altText: asset.metadata?.altText || '' })) }, assets: articleAssets, sourceUrl: job.post.sourceUrl });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'written', markdown: article.markdown } });
        const polished = await humanize({ client: llmClient, markdown: article.markdown, context: { postId: job.post.postId, analysis, editorial, research: { queries: research.queries, citations: research.citations.map(citation => ({ title: citation.title, url: citation.url })) } } });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: polished.manualReview ? 'manual_review' : 'humanized', markdown: polished.markdown, humanizerScore: polished.score, metadata: analysisMetadata } });
        if (polished.manualReview) return prisma.earlyBirdArticleJob.findUnique({ where: { id: job.id } });
        const assetUrls = new Map();
        if (!wechatClient) {
          const html = await renderGzhMarkdown(polished.markdown, { title: article.title, digest: article.digest, contentType: editorial.contentType, references });
          await validateGzhHtml(html);
          return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html } });
        }
        const visualAssets = articleVisualAssets(articleAssets);
        let thumb = null;
        if (visualAssets[0]) thumb = await wechatClient.uploadPermanentMaterial(visualAssets[0].localPath, 'thumb');
        else thumb = await wechatClient.uploadPermanentMaterial(evidencePath, 'thumb');
        for (const asset of visualAssets) {
          const uploaded = await wechatClient.uploadArticleImage(asset.localPath);
          if (uploaded.url) assetUrls.set(asset.localPath, uploaded.url);
          if (asset.assetId) await prisma.earlyBirdAsset.update({ where: { id: asset.assetId }, data: { wechatUrl: uploaded.url, status: 'uploaded' } });
        }
        for (const asset of allAssets.filter(item => item.kind === 'video' && item.localPath)) {
          const uploaded = await wechatClient.uploadPermanentMaterial(asset.localPath, 'video', { description: { title: `X 视频 ${job.post.postId}`, introduction: 'EarlyBird 视频素材，仅供草稿编辑使用。' } });
          await prisma.earlyBirdAsset.update({ where: { id: asset.id }, data: { wechatMediaId: uploaded.media_id, status: 'uploaded' } });
        }
        const markdownForRender = [...assetUrls.entries()].reduce((value, [localPath, url]) => value.replaceAll(localPath, url), polished.markdown);
        const html = await renderGzhMarkdown(markdownForRender, { title: article.title, digest: article.digest, contentType: editorial.contentType, references });
        await validateGzhHtml(html);
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html } });
        const draft = await wechatClient.addDraft({ title: article.title.slice(0, 64), author: process.env.WECHAT_AUTHOR || '', digest: article.digest?.slice(0, 120), content: html, content_source_url: '', thumb_media_id: thumb?.media_id || '' });
        const verified = await wechatClient.getDraft(draft.media_id);
        if (!verified?.news_item && !verified?.media_id) throw new Error('WeChat draft verification returned no article');
        await prisma.earlyBirdDraft.upsert({ where: { jobId: job.id }, update: { mediaId: draft.media_id, verification: verified, verified: Boolean(verified?.news_item || verified?.media_id), requestSummary: { title: article.title, sourceUrl: job.post.sourceUrl } }, create: { jobId: job.id, mediaId: draft.media_id, verification: verified, verified: Boolean(verified?.news_item || verified?.media_id), requestSummary: { title: article.title, sourceUrl: job.post.sourceUrl } } });
        return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'verified' } });
      } catch (error) {
        logger.error?.('EarlyBird article failed', jobId, error);
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'failed', error: error.message } });
        throw error;
      }
    },
  };
}
