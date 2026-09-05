import express from 'express';
import Bull from 'bull';
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
