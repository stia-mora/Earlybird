import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { assembleThread } from './threadAssembler.js';
import { analyzePost, createMultimodalClient } from './aiPipeline.js';
import { humanize } from './humanizer.js';
import { renderGzhMarkdown, validateGzhHtml } from './gzhRenderer.js';
import { captureEvidence } from './evidenceCapture.js';
import { createMediaPipeline } from './mediaPipeline.js';
import { articleVisualAssets, createArticleWriter } from './articleWriter.js';
import { createWeChatClient } from './wechatClient.js';
import { createHermesNotifier } from './hermesNotifier.js';
import { availableFixedEndVisuals } from './fixedEndVisuals.js';
import { createCoverImageGenerator } from './coverImage.js';

function jobMetadata(job) {
  return job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
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
  return existingAssets([...threadAssets, ...stored.filter(asset => belongsToThread(asset) && !known.has(asset.id || `${asset.sourceUrl}:${asset.localPath}`))]);
}

async function existingFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function existingAssets(assets) {
  const available = await Promise.all(assets.map(async asset => {
    if (!asset?.localPath || !(await existingFile(asset.localPath))) return null;
    if (asset.kind !== 'video') return asset;
    const metadata = { ...(asset.metadata || {}) };
    if (metadata.posterPath && !(await existingFile(metadata.posterPath))) delete metadata.posterPath;
    if (metadata.audioPath && !(await existingFile(metadata.audioPath))) delete metadata.audioPath;
    metadata.keyframes = (await Promise.all((metadata.keyframes || []).map(async path => (await existingFile(path)) ? path : null))).filter(Boolean);
    return { ...asset, metadata };
  }));
  return available.filter(Boolean);
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

function videoPosterPath(assets) {
  const video = assets.find(asset => asset.kind === 'video');
  return video?.metadata?.posterPath || video?.metadata?.keyframes?.find(Boolean);
}

export function createArticlePipeline({ prisma, scraperFactory, llmClient = createMultimodalClient(), wechatClient = createWeChatClient(), mediaPipeline = createMediaPipeline({ prisma }), evidence = captureEvidence, analyze = analyzePost, notifier = createHermesNotifier({ prisma }), coverImageGenerator = createCoverImageGenerator(), logger = console } = {}) {
  const writer = createArticleWriter({ client: llmClient });
  return {
    async process(jobId, { force = false } = {}) {
      const job = await prisma.earlyBirdArticleJob.findUnique({ where: { id: jobId }, include: { post: true, source: true, draft: true } });
      if (!job) throw new Error(`EarlyBird job not found: ${jobId}`);
      if (job.draft?.mediaId || (job.status === 'verified' && !force)) return job;
      const priorMetadata = jobMetadata(job);
      try {
        const scraper = await scraperFactory(job.source);
        const thread = await assembleThread({
          scraper,
          post: job.post,
          waitMs: Math.max(0, configuredNumber('EARLYBIRD_THREAD_WAIT_MS', 90000)),
          timeoutMs: Math.max(1000, configuredNumber('EARLYBIRD_THREAD_TIMEOUT_MS', 60000)),
        });
        await prisma.earlyBirdPost.update({ where: { id: job.postId }, data: { threadData: thread } });
        const editorial = {
          contentType: 'brief',
          publish: true,
          reason: '所有新捕获内容均直接进入公众号写作。',
          newsworthiness: null,
          relatedPostIds: [],
          searchQueries: [],
        };
        const editorialMetadata = { ...priorMetadata, editorial };
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'captured', attempts: { increment: 1 }, error: null, metadata: editorialMetadata } });
        const storyPosts = [job.post];
        const evidencePath = join(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', `${job.post.postId}-evidence.png`);
        const assets = await collectAssets({ prisma, mediaPipeline, post: job.post, thread });
        const research = { citations: [], images: [], queries: [], allowedHosts: [] };
        const allAssets = assets;
        await evidence({ tweetUrl: job.post.sourceUrl, postId: job.post.postId, translation: '', mediaPosterPath: videoPosterPath(assets), outputPath: evidencePath, thread });
        const analysisPost = { ...job.post.rawData, text: job.post.text, storyPosts: storyPosts.map(item => ({ author: item.authorUsername, createdAt: item.createdAt, url: item.sourceUrl, text: item.text })) };
        const analysis = await analyze({ client: llmClient, post: analysisPost, thread, assets: allAssets, evidencePath });
        const analysisMetadata = { ...editorialMetadata, analysis, research: { citations: research.citations, queries: research.queries } };
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'analyzed', metadata: analysisMetadata } });
        await evidence({ tweetUrl: job.post.sourceUrl, postId: job.post.postId, translation: analysis.translation, mediaPosterPath: videoPosterPath(assets), outputPath: evidencePath, thread });
        const articleAssets = [...allAssets, postEvidenceAsset(job.post, evidencePath)];
        const references = articleReferences(storyPosts, research);
        const article = await writer.write({ post: job.post, thread, analysis, editorial, storyPosts, research: { ...research, assets: allAssets.filter(asset => asset.kind === 'image').map(asset => ({ path: asset.localPath, sourceUrl: asset.sourceUrl, altText: asset.metadata?.altText || '' })) }, assets: articleAssets, sourceUrl: job.post.sourceUrl });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'written', markdown: article.markdown } });
        const polished = await humanize({ client: llmClient, markdown: article.markdown, context: { postId: job.post.postId, analysis, editorial, research: { queries: research.queries, citations: research.citations.map(citation => ({ title: citation.title, url: citation.url })) } } });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: polished.manualReview ? 'manual_review' : 'humanized', markdown: polished.markdown, humanizerScore: polished.score, metadata: analysisMetadata } });
        if (polished.manualReview) return prisma.earlyBirdArticleJob.findUnique({ where: { id: job.id } });
        const endVisuals = await availableFixedEndVisuals();
        const assetUrls = new Map();
        if (!wechatClient) {
          const html = await renderGzhMarkdown(polished.markdown, { title: article.title, digest: article.digest, contentType: editorial.contentType, references, endVisuals });
          await validateGzhHtml(html);
          return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html } });
        }
        const visualAssets = [...articleVisualAssets(articleAssets), ...endVisuals];
        let cover;
        try {
          cover = await coverImageGenerator.generate({ postId: job.post.postId, title: article.title, digest: article.digest, analysis, editorial, previous: analysisMetadata.cover });
        } catch (error) {
          logger.warn?.('EarlyBird cover generation failed; using the original media', job.id, error.message);
        }
        const coverMetadata = cover || { status: 'source-fallback', reason: 'cover image generation failed' };
        const metadataWithCover = { ...analysisMetadata, cover: coverMetadata };
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'humanized', metadata: metadataWithCover } });
        const thumbPath = cover?.localPath || visualAssets[0]?.localPath || evidencePath;
        const thumb = await wechatClient.uploadPermanentMaterial(thumbPath, 'thumb');
        for (const asset of visualAssets) {
          const uploaded = await wechatClient.uploadArticleImage(asset.localPath);
          if (uploaded.url) assetUrls.set(asset.localPath, uploaded.url);
          if (asset.assetId) await prisma.earlyBirdAsset.update({ where: { id: asset.assetId }, data: { wechatUrl: uploaded.url, status: 'uploaded' } });
        }
        const manualVideos = allAssets.filter(item => item.kind === 'video' && item.localPath);
        for (const asset of manualVideos) {
          await prisma.earlyBirdAsset.update({ where: { id: asset.id }, data: { wechatMediaId: null, status: 'manual_upload_required' } });
        }
        const markdownForRender = [...assetUrls.entries()].reduce((value, [localPath, url]) => value.replaceAll(localPath, url), polished.markdown);
        const renderedEndVisuals = endVisuals.map(asset => ({ ...asset, src: assetUrls.get(asset.localPath) || asset.localPath }));
        const html = await renderGzhMarkdown(markdownForRender, { title: article.title, digest: article.digest, contentType: editorial.contentType, references, endVisuals: renderedEndVisuals });
        await validateGzhHtml(html);
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html, metadata: metadataWithCover } });
        const draft = await wechatClient.addDraft({ title: article.title.slice(0, 64), author: process.env.WECHAT_AUTHOR || '', digest: article.digest?.slice(0, 120), content: html, content_source_url: '', thumb_media_id: thumb?.media_id || '' });
        const verified = await wechatClient.getDraft(draft.media_id);
        if (!verified?.news_item && !verified?.media_id) throw new Error('WeChat draft verification returned no article');
        const storedDraft = await prisma.earlyBirdDraft.upsert({ where: { jobId: job.id }, update: { mediaId: draft.media_id, verification: verified, verified: Boolean(verified?.news_item || verified?.media_id), requestSummary: { title: article.title, sourceUrl: job.post.sourceUrl, cover: { status: coverMetadata.status, model: coverMetadata.model, width: coverMetadata.width, height: coverMetadata.height } } }, create: { jobId: job.id, mediaId: draft.media_id, verification: verified, verified: Boolean(verified?.news_item || verified?.media_id), requestSummary: { title: article.title, sourceUrl: job.post.sourceUrl, cover: { status: coverMetadata.status, model: coverMetadata.model, width: coverMetadata.width, height: coverMetadata.height } } } });
        const completedJob = await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'verified' } });
        try {
          await notifier?.draftReady({ job: { ...job, ...completedJob, metadata: metadataWithCover }, draft: storedDraft, source: job.source, post: job.post, manualVideoFiles: manualVideos.map(asset => basename(asset.localPath)) });
        } catch (notificationError) {
          logger.warn?.('EarlyBird draft notification failed', job.id, notificationError.message);
        }
        return completedJob;
      } catch (error) {
        logger.error?.('EarlyBird article failed', jobId, error);
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'failed', error: error.message } });
        throw error;
      }
    },
  };
}
