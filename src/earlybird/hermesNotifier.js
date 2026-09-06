import { readFile } from 'node:fs/promises';

function compact(value, maximum = 300) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

export function createHermesNotifier({
  prisma,
  url = process.env.EARLYBIRD_HERMES_RELAY_URL,
  token = process.env.EARLYBIRD_HERMES_RELAY_TOKEN,
  tokenFile = process.env.EARLYBIRD_HERMES_RELAY_TOKEN_FILE,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = Number(process.env.EARLYBIRD_HERMES_TIMEOUT_MS || 45000),
  hostMediaDir = process.env.EARLYBIRD_HOST_MEDIA_DIR || '',
} = {}) {
  const store = prisma?.earlyBirdNotification;
  let loadedToken = token || null;

  async function resolveToken() {
    if (loadedToken || !tokenFile) return loadedToken || '';
    loadedToken = (await readFile(tokenFile, 'utf8')).trim();
    return loadedToken;
  }

  async function updateDelivery(dedupeKey, data) {
    if (!store) return { dedupeKey, ...data };
    return store.upsert({
      where: { dedupeKey },
      update: data,
      create: { dedupeKey, ...data },
    });
  }

  async function deliver({ kind, dedupeKey, subject, message, payload }) {
    const existing = store ? await store.findUnique({ where: { dedupeKey } }) : null;
    if (existing?.status === 'sent') return existing;
    const record = { kind, status: 'pending', payload: { subject, message, ...payload }, error: null };
    if (!url) return updateDelivery(dedupeKey, { ...record, status: 'skipped', error: 'EarlyBird Hermes relay is not configured' });
    try {
      const secret = await resolveToken();
      if (!secret) throw new Error('EarlyBird Hermes relay token is not configured');
      await updateDelivery(dedupeKey, record);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ subject, message }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const detail = await response.text();
      if (!response.ok) throw new Error(`Hermes relay returned ${response.status}: ${compact(detail, 180)}`);
      return updateDelivery(dedupeKey, { ...record, status: 'sent', sentAt: now() });
    } catch (error) {
      await updateDelivery(dedupeKey, { ...record, status: 'failed', error: compact(error.message, 500) });
      throw error;
    }
  }

  return {
    draftReady({ job, draft, source, post, manualVideoFiles = [] }) {
      const title = draft?.requestSummary?.title || '新公众号草稿';
      const contentType = job?.metadata?.editorial?.contentType || 'article';
      const handle = source?.handle || post?.authorUsername || 'unknown';
      const videos = [...new Set(manualVideoFiles.filter(Boolean))];
      const videoNotice = videos.length
        ? `\n视频未自动上传至微信素材库，请审核后手动上传。\n目录：${hostMediaDir || '请在 EARLYBIRD_HOST_MEDIA_DIR 中配置宿主机目录'}\n文件：${videos.join('、')}`
        : '';
      return deliver({
        kind: 'draft_ready',
        dedupeKey: `draft:${job.id}`,
        subject: 'EarlyBird：公众号草稿已就绪',
        message: `标题：${title}\n来源：@${handle}\n类型：${contentType}\n状态：已创建并通过微信草稿回读校验。${videoNotice}`,
        payload: { jobId: job.id, postId: post?.postId, source: handle, mediaId: draft?.mediaId, manualVideoFiles: videos },
      });
    },
    dailySummary(summary) {
      return deliver({
        kind: 'daily_summary',
        dedupeKey: `daily-summary:${summary.day}`,
        subject: `EarlyBird 日报｜${summary.day}`,
        message: summary.message,
        payload: { date: summary.day, detectedPosts: summary.detectedPosts, verifiedDrafts: summary.verifiedDrafts },
      });
    },
  };
}
