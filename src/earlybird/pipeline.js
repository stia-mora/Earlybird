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
import { collectTavilyImages, createTavilyImageSearch } from './tavilyImageSearch.js';
import { contentStandard, createEditorialOrchestrator, reviewInputHash } from './editorialReview.js';
import { emptyEditorialResearch, gatherEditorialResearch, hasResearchPlan, selectEditorialResearch } from './editorialResearch.js';
import { createEditorialXSearch } from './xResearchSearch.js';
import { sanitizeJsonUnicode } from './utils.js';

const MAX_REWRITE_ATTEMPTS = 3;

function jobMetadata(job) {
  return job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
}

function configuredNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function reviewWindowMs() {
  return Math.max(1, configuredNumber('EARLYBIRD_EDITORIAL_BATCH_MINUTES', 30)) * 60 * 1000;
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
  const available = await Promise.all((assets || []).map(async asset => {
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

async function collectAssets({ prisma, mediaPipeline, post, thread }) {
  const collected = await mediaPipeline.collect({ post, thread });
  const threadPostIds = new Set([post.postId, post.rawData?.id, ...thread.map(item => item?.id || item?.id_str)].filter(Boolean).map(String));
  const belongsToThread = asset => !asset.metadata?.tweetId || threadPostIds.has(String(asset.metadata.tweetId));
  const threadAssets = (collected || []).filter(belongsToThread);
  if (!prisma?.earlyBirdAsset?.findMany) return existingAssets(threadAssets);
  const stored = await prisma.earlyBirdAsset.findMany({ where: { postId: post.id, localPath: { not: null } } });
  const known = new Set(threadAssets.map(asset => asset.id || `${asset.sourceUrl}:${asset.localPath}`));
  return existingAssets([...threadAssets, ...stored.filter(asset => belongsToThread(asset) && !known.has(asset.id || `${asset.sourceUrl}:${asset.localPath}`))]);
}

function postEvidenceAsset(post, localPath) {
  return { kind: 'x-post-evidence', localPath, sourceUrl: post.sourceUrl, metadata: { altText: `@${post.authorUsername || 'unknown'} 的 X 原帖截图` } };
}

function articleReferences(storyPosts, assets, research = {}) {
  return [...new Set([
    ...storyPosts.map(post => post.sourceUrl),
    ...(assets || []).map(asset => asset.metadata?.sourcePageUrl),
    ...(research.citations || []).map(citation => citation.url),
    ...(research.xEvidence || []).map(evidence => evidence.url),
  ].filter(Boolean))];
}

function videoPosterPath(assets) {
  const video = assets.find(asset => asset.kind === 'video');
  return video?.metadata?.posterPath || video?.metadata?.keyframes?.find(Boolean);
}

async function capturePostEvidence({ evidence, post, assets, outputPath, thread, translation, logger }) {
  try {
    await evidence({ tweetUrl: post.sourceUrl, postId: post.postId, translation, mediaPosterPath: videoPosterPath(assets), outputPath, thread });
    return true;
  } catch (error) {
    logger.warn?.('EarlyBird X evidence was unavailable; continuing without a screenshot', post.postId, error.message);
    return false;
  }
}

function metadataWithReview(metadata, editorial, review) {
  return sanitizeJsonUnicode({
    ...metadata,
    editorial: { ...editorial, decision: review.decision, qualityScore: review.qualityScore, issues: review.issues, relatedJobIds: review.relatedJobIds, selectedResearchUrls: review.selectedResearchUrls, researchPlan: review.researchPlan, visualPlan: review.visualPlan },
    review: { decision: review.decision, qualityScore: review.qualityScore, issues: review.issues, rewriteInstructions: review.rewriteInstructions, at: new Date().toISOString() },
  });
}

function externalStoryPost(evidence) {
  return {
    id: evidence.id,
    postId: evidence.id,
    authorUsername: evidence.author || evidence.sourceDomain || 'source',
    sourceUrl: evidence.url,
    createdAt: evidence.createdAt || null,
    text: evidence.text || evidence.excerpt || evidence.title || '',
    rawData: evidence,
  };
}

function externalStoryJob(evidence) {
  const post = externalStoryPost(evidence);
  return { id: evidence.id, post, source: { handle: post.authorUsername }, metadata: { analysis: { digest: evidence.excerpt || evidence.text || '' } } };
}

async function saveReview(prisma, job, phase, attempt, decision, input) {
  const safeDecision = sanitizeJsonUnicode(decision);
  const data = {
    jobId: job.id, phase, attempt, decision: safeDecision.decision, contentType: safeDecision.contentType,
    qualityScore: safeDecision.qualityScore, issues: safeDecision.issues, rewriteInstructions: safeDecision.rewriteInstructions || null,
    visualPlan: safeDecision.visualPlan, relatedJobIds: safeDecision.relatedJobIds, inputHash: reviewInputHash(input), output: safeDecision,
  };
  return prisma?.earlyBirdEditorialReview?.create ? prisma.earlyBirdEditorialReview.create({ data }) : data;
}

async function candidateJobs(prisma, job, { dailyReview = false, now = new Date() } = {}) {
  if (!prisma?.earlyBirdArticleJob?.findMany) return [];
  const chinaParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const start = dailyReview ? new Date(`${chinaParts.year}-${chinaParts.month}-${chinaParts.day}T00:00:00+08:00`) : new Date(job.detectedAt || now);
  const end = dailyReview ? now : new Date(start.getTime() + reviewWindowMs());
  return prisma.earlyBirdArticleJob.findMany({
    where: { id: { not: job.id }, status: { in: dailyReview ? ['detected', 'verified'] : ['detected'] }, detectedAt: { gte: start, lte: end } },
    include: { post: true, source: true, draft: true }, orderBy: { detectedAt: 'asc' }, take: 30,
  });
}

async function buildStoryMaterial({ storyJob, prisma, scraperFactory, mediaPipeline, evidence, logger }) {
  const scraper = await scraperFactory(storyJob.source);
  const thread = await assembleThread({
    scraper, post: storyJob.post, waitMs: Math.max(0, configuredNumber('EARLYBIRD_THREAD_WAIT_MS', 90000)),
    timeoutMs: Math.max(1000, configuredNumber('EARLYBIRD_THREAD_TIMEOUT_MS', 60000)),
  });
  await prisma.earlyBirdPost.update({ where: { id: storyJob.postId }, data: { threadData: thread } });
  const assets = await collectAssets({ prisma, mediaPipeline, post: storyJob.post, thread });
  const evidencePath = join(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', `${storyJob.post.postId}-evidence.png`);
  const hasEvidence = await capturePostEvidence({ evidence, post: storyJob.post, assets, outputPath: evidencePath, thread, translation: '', logger });
  return { ...storyJob, thread, assets, evidencePath, hasEvidence };
}

function imageAttributions(visualAssets, assetUrls) {
  return visualAssets.map(asset => {
    const sourceUrl = asset.metadata?.sourcePageUrl;
    if (!sourceUrl) return null;
    return { src: assetUrls.get(asset.localPath) || asset.localPath, label: asset.metadata?.attribution || `图片来源：${asset.metadata?.sourceDomain || ''}`, sourceUrl, sourceDomain: asset.metadata?.sourceDomain };
  }).filter(Boolean);
}

export async function replaceManagedDrafts({ prisma, wechatClient, primaryJob, storyJobs, draft, verified, requestSummary }) {
  const active = storyJobs.map(job => ({ job, draft: job.draft?.mediaId && !job.draft.deletedAt ? job.draft : null })).filter(item => item.draft);
  const deleted = [];
  for (const item of active) {
    const record = prisma?.earlyBirdDraftReplacement?.create
      ? await prisma.earlyBirdDraftReplacement.create({ data: { jobId: item.job.id, oldMediaId: item.draft.mediaId, newMediaId: draft.media_id, status: 'pending' } })
      : { id: `replace-${item.job.id}` };
    try {
      await wechatClient.deleteDraft(item.draft.mediaId);
      if (prisma?.earlyBirdDraftReplacement?.update) await prisma.earlyBirdDraftReplacement.update({ where: { id: record.id }, data: { status: 'deleted', error: null } });
      deleted.push(item);
    } catch (error) {
      if (prisma?.earlyBirdDraftReplacement?.update) await prisma.earlyBirdDraftReplacement.update({ where: { id: record.id }, data: { status: 'delete_failed', error: error.message } });
      if (prisma?.earlyBirdDraft?.update) await prisma.earlyBirdDraft.update({ where: { id: item.draft.id }, data: { deleteError: error.message } });
      return { failure: `新草稿 ${draft.media_id} 已创建，但旧草稿 ${item.draft.mediaId} 删除失败：${error.message}` };
    }
  }
  const stored = await prisma.earlyBirdDraft.upsert({
    where: { jobId: primaryJob.id },
    update: { mediaId: draft.media_id, verification: verified, verified: true, failureReason: null, deletedAt: null, deleteError: null, requestSummary },
    create: { jobId: primaryJob.id, mediaId: draft.media_id, verification: verified, verified: true, requestSummary },
  });
  for (const item of deleted.filter(item => item.job.id !== primaryJob.id)) {
    if (prisma?.earlyBirdDraft?.update) await prisma.earlyBirdDraft.update({ where: { id: item.draft.id }, data: { verified: false, deletedAt: new Date(), deleteError: null, failureReason: `已并入任务 ${primaryJob.id} 的草稿 ${draft.media_id}` } });
  }
  return { stored };
}

export function createArticlePipeline({
  prisma, scraperFactory, llmClient = createMultimodalClient(), reviewClient, orchestrator, reviewer,
  wechatClient = createWeChatClient(), mediaPipeline = createMediaPipeline({ prisma }), evidence = captureEvidence,
  analyze = analyzePost, notifier = createHermesNotifier({ prisma }), coverImageGenerator = createCoverImageGenerator(),
  imageSearch = createTavilyImageSearch(), xSearch, collectWebImages = collectTavilyImages, logger = console, now = () => new Date(),
} = {}) {
  const writer = createArticleWriter({ client: llmClient });
  const editorialOrchestrator = orchestrator || reviewer || createEditorialOrchestrator({ client: reviewClient || llmClient });
  const editorialXSearch = xSearch || createEditorialXSearch({ scraperFactory, logger });

  async function manualReview(job, metadata, reason) {
    const updated = await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'manual_review', error: reason, metadata } });
    try { await notifier?.manualReview?.({ job: { ...job, ...updated, metadata }, reason }); } catch (error) { logger.warn?.('EarlyBird manual-review notification failed', job.id, error.message); }
    return updated;
  }

  async function markMerged(primaryJob, relatedJobs) {
    await Promise.all(relatedJobs.map(item => prisma.earlyBirdArticleJob.update({
      where: { id: item.id }, data: { status: 'merged', error: null, metadata: { ...jobMetadata(item), mergeTargetJobId: primaryJob.id, mergedAt: now().toISOString() } },
    })));
  }

  let processJob;
  processJob = async (jobId, { force = false, dailyReview = false, preselectedDecision = null, mergeDepth = 0 } = {}) => {
      const job = await prisma.earlyBirdArticleJob.findUnique({ where: { id: jobId }, include: { post: true, source: true, draft: true } });
      if (!job) throw new Error(`EarlyBird job not found: ${jobId}`);
      if (job.status === 'merged') return job;
      if (job.draft?.mediaId && job.status === 'verified' && !force) return job;
      const priorMetadata = jobMetadata(job);
      try {
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'editorial_review', attempts: { increment: 1 }, error: null } });
        const candidates = await candidateJobs(prisma, job, { dailyReview, now: now() });
        let triage = preselectedDecision || await editorialOrchestrator.triage({ job, candidates });
        let metadata = metadataWithReview(priorMetadata, triage, triage);
        await saveReview(prisma, job, dailyReview ? 'daily_triage' : 'triage', 1, triage, JSON.stringify({ current: job.id, candidates: candidates.map(item => item.id) }));
        let research = emptyEditorialResearch(triage.researchPlan);
        if (hasResearchPlan(triage.researchPlan)) {
          await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'researching', metadata } });
          research = await gatherEditorialResearch({ plan: triage.researchPlan, xSearch: editorialXSearch, source: job.source, tavilySearch: imageSearch, logger });
          const coordinated = typeof editorialOrchestrator.coordinate === 'function'
            ? await editorialOrchestrator.coordinate({ job, candidates, triage, research })
            : triage;
          triage = coordinated;
          metadata = metadataWithReview({ ...metadata, editorialResearch: research }, triage, triage);
          await saveReview(prisma, job, 'research_coordination', 1, triage, JSON.stringify(research));
        }
        if (triage.decision === 'manual_review') return manualReview(job, metadata, triage.issues.join('；') || '总编辑要求人工审核');
        if (!['pass', 'rewrite', 'merge'].includes(triage.decision)) return manualReview(job, metadata, triage.issues.join('；') || '总编辑返回了无法执行的审核决定');

        const relatedJobs = candidates.filter(item => triage.relatedJobIds.includes(item.id));
        const storyJobs = [job, ...relatedJobs];
        const selectedResearch = selectEditorialResearch(research, triage.selectedResearchUrls);
        if (dailyReview && job.status === 'verified' && triage.decision === 'pass' && !relatedJobs.length && job.markdown) {
          const storedAssets = await collectAssets({ prisma, mediaPipeline, post: job.post, thread: Array.isArray(job.post.threadData) ? job.post.threadData : [job.post.rawData] });
          const existingQuality = await editorialOrchestrator.reviewDraft({
            job,
            article: { markdown: job.markdown },
            editorial: triage,
            storyPosts: [job],
            assets: storedAssets,
            references: articleReferences([job.post], storedAssets, selectedResearch),
            attempt: 1,
          });
          metadata = metadataWithReview(metadata, triage, existingQuality);
          await saveReview(prisma, job, 'daily_draft', 1, existingQuality, job.markdown);
          if (existingQuality.decision === 'pass') {
            return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'verified', error: null, metadata } });
          }
        }
        const materials = [];
        for (const storyJob of storyJobs) materials.push(await buildStoryMaterial({ storyJob, prisma, scraperFactory, mediaPipeline, evidence, logger }));
        const storyPosts = [...materials.map(item => item.post), ...selectedResearch.xEvidence.map(externalStoryPost)];
        const qualityStoryJobs = [...storyJobs, ...selectedResearch.xEvidence.map(externalStoryJob)];
        const sourceAssets = materials.flatMap(item => item.assets);
        const evidenceAssets = materials.filter(item => item.hasEvidence).map(item => postEvidenceAsset(item.post, item.evidencePath));
        const standard = contentStandard(triage.contentType);
        const initialVisuals = articleVisualAssets([...sourceAssets, ...evidenceAssets]);
        const webAssets = await collectWebImages({ search: imageSearch, prisma, post: job.post, visualPlan: triage.visualPlan, needed: Math.max(0, standard.minVisuals - initialVisuals.length), logger });
        const allAssets = [...sourceAssets, ...webAssets];
        const articleAssets = [...allAssets, ...evidenceAssets];
        const visualAssets = articleVisualAssets(articleAssets);
        if (visualAssets.length < standard.minVisuals) return manualReview(job, metadata, `正文可用图片仅 ${visualAssets.length} 张，${triage.contentType} 至少需要 ${standard.minVisuals} 张`);

        const root = materials[0];
        const analysisPost = { ...job.post.rawData, text: job.post.text, storyPosts: storyPosts.map(item => ({ author: item.authorUsername, createdAt: item.createdAt, url: item.sourceUrl, text: item.text })) };
        const analysis = await analyze({ client: llmClient, post: analysisPost, thread: root.thread, assets: allAssets, evidencePath: root.hasEvidence ? root.evidencePath : undefined });
        if (root.hasEvidence) await capturePostEvidence({ evidence, post: job.post, assets: root.assets, outputPath: root.evidencePath, thread: root.thread, translation: analysis.translation, logger });
        const references = articleReferences(storyPosts, allAssets, selectedResearch);
        const editorial = { ...triage, publish: true };
        metadata = { ...metadata, analysis, research: { citations: selectedResearch.citations, xEvidence: selectedResearch.xEvidence, queries: research.plan, failures: research.failures } };
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'analyzed', metadata } });

        let article;
        let lastHash = '';
        for (let attempt = 1; attempt <= MAX_REWRITE_ATTEMPTS; attempt += 1) {
          await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: attempt === 1 ? 'writing' : 'revising' } });
          try {
            article = await writer.write({ post: job.post, thread: root.thread, analysis, editorial, storyPosts, research: { citations: selectedResearch.citations, xEvidence: selectedResearch.xEvidence, assets: allAssets.filter(asset => ['image', 'web-image'].includes(asset.kind)).map(asset => ({ path: asset.localPath, sourceUrl: asset.sourceUrl, altText: asset.metadata?.altText || '' })) }, assets: articleAssets, sourceUrl: job.post.sourceUrl, previousMarkdown: article?.markdown || '', revisionInstructions: attempt === 1 ? '' : metadata.review?.rewriteInstructions || '' });
          } catch (error) {
            return manualReview(job, metadata, `自动写作未达到结构标准：${error.message}`);
          }
          await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'written', markdown: article.markdown } });
          const polished = await humanize({ client: llmClient, markdown: article.markdown, context: { postId: job.post.postId, analysis, editorial } });
          const candidate = { ...article, markdown: polished.markdown };
          await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'quality_review', markdown: candidate.markdown, humanizerScore: polished.score } });
          const quality = await editorialOrchestrator.reviewDraft({ job, article: candidate, editorial, storyPosts: qualityStoryJobs, candidates, assets: articleAssets, references, attempt });
          metadata = metadataWithReview(metadata, editorial, quality);
          await saveReview(prisma, job, 'draft', attempt, quality, candidate.markdown);
          const hash = reviewInputHash(candidate.markdown);
          if (quality.decision === 'pass') { article = candidate; break; }
          if (quality.decision === 'merge') {
            if (quality.relatedJobIds.length && mergeDepth < 1) {
              return processJob(job.id, { force: true, dailyReview, preselectedDecision: quality, mergeDepth: mergeDepth + 1 });
            }
            return manualReview(job, metadata, quality.issues.join('；') || '成稿审核建议增加关联内容合稿，但未找到可用关联任务');
          }
          if (quality.decision === 'manual_review' || attempt === MAX_REWRITE_ATTEMPTS || hash === lastHash) return manualReview(job, metadata, quality.issues.join('；') || (hash === lastHash ? '自动改写未产生实质变化' : '自动改写三轮后仍未通过审核'));
          lastHash = hash;
          article = candidate;
        }
        if (!article || metadata.review?.decision !== 'pass') return manualReview(job, metadata, '审核未返回可发布结论');

        const endVisuals = await availableFixedEndVisuals();
        const assetUrls = new Map();
        if (!wechatClient) {
          const html = await renderGzhMarkdown(article.markdown, { title: article.title, digest: article.digest, contentType: editorial.contentType, references, endVisuals, imageAttributions: imageAttributions(visualAssets, assetUrls) });
          await validateGzhHtml(html);
          if (relatedJobs.length) await markMerged(job, relatedJobs);
          return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html, markdown: article.markdown, metadata } });
        }
        let cover;
        try { cover = await coverImageGenerator.generate({ postId: job.post.postId, title: article.title, digest: article.digest, analysis, editorial, previous: metadata.cover }); }
        catch (error) { logger.warn?.('EarlyBird cover generation failed; using a verified article visual', job.id, error.message); }
        const thumbPath = cover?.localPath || visualAssets[0]?.localPath;
        if (!thumbPath) return manualReview(job, metadata, '没有可用于公众号封面的已验证图片');
        const thumb = await wechatClient.uploadPermanentMaterial(thumbPath, 'thumb');
        for (const asset of [...visualAssets, ...endVisuals]) {
          const uploaded = await wechatClient.uploadArticleImage(asset.localPath);
          if (uploaded.url) assetUrls.set(asset.localPath, uploaded.url);
          if (asset.assetId) await prisma.earlyBirdAsset.update({ where: { id: asset.assetId }, data: { wechatUrl: uploaded.url, status: 'uploaded' } });
        }
        const manualVideos = allAssets.filter(item => item.kind === 'video' && item.localPath);
        for (const asset of manualVideos) await prisma.earlyBirdAsset.update({ where: { id: asset.id }, data: { wechatMediaId: null, status: 'manual_upload_required' } });
        const markdownForRender = [...assetUrls.entries()].reduce((value, [localPath, url]) => {
          return value.replaceAll(localPath, url).replaceAll(localPath.replace(/\\/g, '/'), url);
        }, article.markdown);
        const renderedEndVisuals = endVisuals.map(asset => ({ ...asset, src: assetUrls.get(asset.localPath) || asset.localPath }));
        metadata = { ...metadata, cover: cover || { status: 'source-fallback', reason: 'cover image generation failed' } };
        const html = await renderGzhMarkdown(markdownForRender, { title: article.title, digest: article.digest, contentType: editorial.contentType, references, endVisuals: renderedEndVisuals, imageAttributions: imageAttributions(visualAssets, assetUrls) });
        await validateGzhHtml(html);
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html, markdown: article.markdown, metadata } });
        const draft = await wechatClient.addDraft({ title: article.title.slice(0, 64), author: process.env.WECHAT_AUTHOR || '', digest: article.digest?.slice(0, 120), content: html, content_source_url: '', thumb_media_id: thumb?.media_id || '' });
        const verified = await wechatClient.getDraft(draft.media_id);
        if (!verified?.news_item && !verified?.media_id) throw new Error('WeChat draft verification returned no article');
        const requestSummary = { title: article.title, sourceUrl: job.post.sourceUrl, contentType: editorial.contentType, reviewScore: metadata.review?.qualityScore, cover: { status: metadata.cover.status, model: metadata.cover.model, width: metadata.cover.width, height: metadata.cover.height } };
        const replacement = await replaceManagedDrafts({ prisma, wechatClient, primaryJob: job, storyJobs, draft, verified, requestSummary });
        if (replacement.failure) return manualReview(job, metadata, replacement.failure);
        if (relatedJobs.length) await markMerged(job, relatedJobs);
        const completed = await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'verified', error: null, metadata } });
        try { await notifier?.draftReady({ job: { ...job, ...completed, metadata }, draft: replacement.stored, source: job.source, post: job.post, manualVideoFiles: manualVideos.map(asset => basename(asset.localPath)) }); }
        catch (error) { logger.warn?.('EarlyBird draft notification failed', job.id, error.message); }
        return completed;
      } catch (error) {
        logger.error?.('EarlyBird article failed', jobId, error);
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'failed', error: error.message } });
        throw error;
      }
  };
  return { process: processJob };
}
