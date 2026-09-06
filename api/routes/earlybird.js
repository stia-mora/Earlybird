import express from 'express';
import Bull from 'bull';
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth.js';
import { createArticlePipeline } from '../../src/earlybird/pipeline.js';
import { createWeChatClient } from '../../src/earlybird/wechatClient.js';
import { defaultScraperFactory } from '../../src/earlybird/sourceMonitor.js';

const router = express.Router();
const prisma = new PrismaClient();
let articleQueue;
function getArticleQueue() {
  articleQueue ||= new Bull('earlybird-articles', process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
  return articleQueue;
}

async function enqueueArticleProcess(jobId) {
  const queue = getArticleQueue();
  const queueJobId = `earlybird-article-${jobId}`;
  const existing = await queue.getJob(queueJobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed') {
      await existing.retry();
      return;
    }
    if (['active', 'waiting', 'delayed', 'paused'].includes(state)) return;
    await existing.remove();
  }
  await queue.add('process', { jobId }, { jobId: queueJobId, removeOnComplete: 100, removeOnFail: 100 });
}
function startOfToday() {
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  const value = new Date(Date.now() + shanghaiOffsetMs);
  value.setUTCHours(0, 0, 0, 0);
  return new Date(value.getTime() - shanghaiOffsetMs);
}

function serviceStatus(lastPolledAt, pollIntervalSeconds) {
  if (!lastPolledAt) return { state: 'waiting', label: '等待首次轮询' };
  const ageMs = Date.now() - new Date(lastPolledAt).getTime();
  const staleAfterMs = Math.max(60_000, Number(pollIntervalSeconds || 60) * 2_000);
  if (ageMs > staleAfterMs) return { state: 'stale', label: '轮询已变慢' };
  return { state: 'healthy', label: '采集正常' };
}

function dashboardJobNote(job) {
  if (job.status === 'ignored') return '已由选题规则筛选，未创建草稿。';
  if (job.status === 'merged') return '已并入关联事件的主稿。';
  if (job.status === 'held') return '正在等待关联官方消息以决定是否合并。';
  if (job.status === 'manual_review') return '自动审稿未通过，需要人工复核。';
  if (job.status === 'failed') return '流水线未完成，请登录后在任务详情中查看原因或重试。';
  if (job.status === 'verified') return '已创建并通过微信草稿回读校验。';
  return '正在推进到下一个写作或排版阶段。';
}

router.get('/overview', async (_req, res) => {
  try {
    const today = startOfToday();
    const [sources, postsToday, jobsToday, jobs, polls, notifications, jobGroups, drafts, verifiedDrafts] = await Promise.all([
      prisma.earlyBirdSource.findMany({ orderBy: { handle: 'asc' }, select: { id: true, handle: true, displayName: true, enabled: true, baselineComplete: true, pollIntervalSeconds: true, lastPolledAt: true, updatedAt: true } }),
      prisma.earlyBirdPost.count({ where: { capturedAt: { gte: today } } }),
      prisma.earlyBirdArticleJob.count({ where: { detectedAt: { gte: today } } }),
      prisma.earlyBirdArticleJob.findMany({ take: 30, orderBy: { updatedAt: 'desc' }, select: { id: true, status: true, updatedAt: true, source: { select: { handle: true, displayName: true } }, post: { select: { postId: true } }, draft: { select: { verified: true } } } }),
      prisma.earlyBirdPoll.findMany({ take: 20, orderBy: { polledAt: 'desc' }, select: { id: true, outcome: true, detectedCount: true, polledAt: true, source: { select: { handle: true, displayName: true } } } }),
      prisma.earlyBirdNotification.findMany({ take: 20, orderBy: { createdAt: 'desc' }, select: { kind: true, status: true, createdAt: true } }),
      prisma.earlyBirdArticleJob.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.earlyBirdDraft.count(),
      prisma.earlyBirdDraft.count({ where: { verified: true } }),
    ]);

    const enabledSources = sources.filter(source => source.enabled);
    const sourceStates = sources.map(source => ({
      id: source.id,
      handle: source.handle,
      displayName: source.displayName,
      enabled: source.enabled,
      baselineComplete: source.baselineComplete,
      pollIntervalSeconds: source.pollIntervalSeconds,
      lastPolledAt: source.lastPolledAt,
      updatedAt: source.updatedAt,
      status: source.enabled ? serviceStatus(source.lastPolledAt, source.pollIntervalSeconds) : { state: 'disabled', label: '已停用' },
    }));
    const activeStates = sourceStates.filter(source => source.enabled).map(source => source.status.state);
    const workerState = !enabledSources.length
      ? { state: 'not_configured', label: '尚未配置来源' }
      : activeStates.includes('stale')
        ? { state: 'stale', label: '需要检查采集器' }
        : activeStates.includes('waiting')
          ? { state: 'waiting', label: '等待采集器首次回报' }
          : { state: 'healthy', label: '采集器运行中' };

    const counts = Object.fromEntries(jobGroups.map(group => [group.status, group._count._all]));
    const attention = jobs
      .filter(job => ['failed', 'manual_review', 'held', 'detected', 'classified', 'captured', 'analyzed', 'written', 'humanized', 'rendered', 'draft_created', 'ignored'].includes(job.status))
      .slice(0, 8)
      .map(job => ({ id: job.id, status: job.status, reason: dashboardJobNote(job), source: job.source?.displayName || job.source?.handle || '未知来源', postId: job.post?.postId || '', updatedAt: job.updatedAt }));
    const safeJobs = jobs.map(job => ({ ...job, note: dashboardJobNote(job) }));
    const safePolls = polls.map(poll => ({
      id: poll.id,
      outcome: poll.outcome,
      detectedCount: poll.detectedCount,
      polledAt: poll.polledAt,
      source: poll.source,
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      system: { api: { state: 'healthy', label: 'API 在线' }, worker: workerState },
      config: {
        xCookies: Boolean(process.env.X_COOKIES || process.env.TWITTER_COOKIES || process.env.EARLYBIRD_X_COOKIES_FILE),
        llm: Boolean(process.env.EARLYBIRD_LLM_API_KEY || process.env.OPENAI_API_KEY),
        wechat: Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET),
        redis: Boolean(process.env.REDIS_URL || process.env.REDIS_HOST),
        mediaDir: existsSync(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media'),
      },
      metrics: { sources: sources.length, enabledSources: enabledSources.length, postsToday, jobsToday, drafts, verifiedDrafts },
      pipeline: counts,
      sources: sourceStates,
      jobs: safeJobs,
      polls: safePolls,
      notifications,
      attention,
    });
  } catch (error) {
    res.status(503).json({ error: `EarlyBird overview unavailable: ${error.message}` });
  }
});

// The overview is intentionally read-only and excludes source credentials, post bodies,
// detailed errors, notification payloads, and every control action. It is safe for the
// local operations screen; all management and retry routes below remain authenticated.
router.use(authMiddleware);

function validWebsite(value) {
  if (value == null || value === '') return true;
  try { return new URL(String(value)).protocol === 'https:'; } catch { return false; }
}

router.get('/sources', async (_req, res) => res.json(await prisma.earlyBirdSource.findMany({ orderBy: { handle: 'asc' } })));
router.post('/sources', async (req, res) => {
  try {
    const handle = String(req.body.handle || '').replace(/^@/, '').trim().toLowerCase();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return res.status(400).json({ error: 'handle must be 1-15 letters, digits, or underscores' });
    if (!validWebsite(req.body.website)) return res.status(400).json({ error: 'website must be an HTTPS URL' });
    const source = await prisma.earlyBirdSource.create({ data: { handle, displayName: req.body.displayName, website: req.body.website || null, enabled: req.body.enabled !== false, pollIntervalSeconds: Math.max(15, Number(req.body.pollIntervalSeconds || 300)) } });
    res.status(201).json(source);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
router.patch('/sources/:id', async (req, res) => {
  try {
    const data = {};
    for (const key of ['displayName', 'website', 'enabled', 'handle']) if (req.body[key] !== undefined) data[key] = key === 'handle' ? String(req.body[key]).replace(/^@/, '').trim().toLowerCase() : req.body[key];
    if (data.handle !== undefined && !/^[A-Za-z0-9_]{1,15}$/.test(data.handle)) return res.status(400).json({ error: 'handle must be 1-15 letters, digits, or underscores' });
    if (!validWebsite(data.website)) return res.status(400).json({ error: 'website must be an HTTPS URL' });
    if (req.body.pollIntervalSeconds !== undefined) data.pollIntervalSeconds = Math.max(15, Number(req.body.pollIntervalSeconds));
    res.json(await prisma.earlyBirdSource.update({ where: { id: req.params.id }, data }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
router.delete('/sources/:id', async (req, res) => { await prisma.earlyBirdSource.delete({ where: { id: req.params.id } }); res.status(204).end(); });
router.get('/polls', async (req, res) => {
  const where = {};
  if (req.query.sourceId) where.sourceId = String(req.query.sourceId);
  if (req.query.outcome) where.outcome = String(req.query.outcome);
  res.json(await prisma.earlyBirdPoll.findMany({ where, include: { source: true }, orderBy: { polledAt: 'desc' }, take: Math.min(200, Number(req.query.limit || 50)) }));
});
router.get('/notifications', async (req, res) => res.json(await prisma.earlyBirdNotification.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(100, Number(req.query.limit || 50)) })));
router.get('/jobs', async (req, res) => res.json(await prisma.earlyBirdArticleJob.findMany({ where: req.query.status ? { status: String(req.query.status) } : undefined, include: { source: true, post: true, draft: true }, orderBy: { updatedAt: 'desc' }, take: Math.min(100, Number(req.query.limit || 50)) })));
router.get('/jobs/:id', async (req, res) => {
  const job = await prisma.earlyBirdArticleJob.findUnique({ where: { id: req.params.id }, include: { source: true, post: { include: { assets: true } }, draft: true } });
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});
router.get('/jobs/:id/preview', async (req, res) => {
  const job = await prisma.earlyBirdArticleJob.findUnique({ where: { id: req.params.id }, select: { html: true, markdown: true, status: true } });
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (req.accepts('html')) return res.type('html').send(job.html || `<pre>${job.markdown || ''}</pre>`);
  res.json(job);
});
router.post('/jobs/:id/retry', async (req, res) => {
  const job = await prisma.earlyBirdArticleJob.update({ where: { id: req.params.id }, data: { status: 'detected', error: null } });
  await enqueueArticleProcess(job.id);
  res.status(202).json({ id: job.id, status: job.status, queued: true });
});
router.post('/jobs/:id/create-draft', async (req, res) => {
  try {
    const pipeline = createArticlePipeline({ prisma, scraperFactory: defaultScraperFactory, wechatClient: createWeChatClient() });
    const job = await pipeline.process(req.params.id, { force: true });
    res.status(201).json(job);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

export default router;
