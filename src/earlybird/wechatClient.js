// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WECHAT_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

export async function prepareWechatUpload(filePath, { run = execFileAsync, tempRoot = process.env.TMPDIR || process.env.TEMP || '/tmp' } = {}) {
  const extension = extname(filePath).toLowerCase();
  if (WECHAT_IMAGE_EXTENSIONS.has(extension)) return { path: filePath, cleanup: async () => {} };
  const directory = await mkdtemp(join(tempRoot, 'earlybird-wechat-'));
  const outputPath = join(directory, 'image.jpg');
  try {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-i', filePath, '-frames:v', '1', '-q:v', '2', outputPath], { windowsHide: true });
    return { path: outputPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`WeChat requires JPG/PNG image uploads; conversion failed for ${filePath}: ${error.message}`);
  }
}

export function createWeChatClient({ appId = process.env.WECHAT_APP_ID, appSecret = process.env.WECHAT_APP_SECRET, fetchImpl = globalThis.fetch, apiBase = 'https://api.weixin.qq.com' } = {}) {
  let token = null;
  let tokenExpiresAt = 0;
  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    if (!appId || !appSecret) throw new Error('WECHAT_APP_ID and WECHAT_APP_SECRET are required');
    const response = await fetchImpl(`${apiBase}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`);
    const data = await response.json();
    if (data.errcode) throw new Error(`WeChat token error ${data.errcode}: ${data.errmsg}`);
    token = data.access_token;
    tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
    return token;
  }
  async function jsonRequest(path, body) {
    const response = await fetchImpl(`${apiBase}${path}?access_token=${encodeURIComponent(await accessToken())}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || data.errcode) throw new Error(`WeChat API error ${data.errcode || response.status}: ${data.errmsg || response.statusText}`);
    return data;
  }
  async function upload(path, filePath, extra = {}) {
    const prepared = await prepareWechatUpload(filePath);
    const form = new FormData();
    try {
      form.append('media', new Blob([await readFile(prepared.path)]), prepared.path.split(/[\\/]/).pop());
      for (const [key, value] of Object.entries(extra)) form.append(key, value);
      const response = await fetchImpl(`${apiBase}${path}?access_token=${encodeURIComponent(await accessToken())}`, { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok || data.errcode) throw new Error(`WeChat upload error ${data.errcode || response.status}: ${data.errmsg || response.statusText}`);
      return data;
    } finally {
      await prepared.cleanup();
    }
  }
  return {
    accessToken,
    uploadArticleImage(filePath) { return upload('/cgi-bin/media/uploadimg', filePath); },
    uploadPermanentMaterial(filePath, type = 'thumb', options = {}) { return upload('/cgi-bin/material/add_material', filePath, { type, ...(options.description ? { description: JSON.stringify(options.description) } : {}) }); },
    addDraft(article) { return jsonRequest('/cgi-bin/draft/add', { articles: [{ article_type: 'news', need_open_comment: 0, only_fans_can_comment: 0, ...article }] }); },
    getDraft(mediaId) { return jsonRequest('/cgi-bin/draft/get', { media_id: mediaId }); },
    deleteDraft(mediaId) { return jsonRequest('/cgi-bin/draft/delete', { media_id: mediaId }); },
  };
}
