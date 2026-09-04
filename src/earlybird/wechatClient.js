import { readFile } from 'node:fs/promises';

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
    const form = new FormData();
    form.append('media', new Blob([await readFile(filePath)]), filePath.split(/[\\/]/).pop());
    for (const [key, value] of Object.entries(extra)) form.append(key, value);
    const response = await fetchImpl(`${apiBase}${path}?access_token=${encodeURIComponent(await accessToken())}`, { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok || data.errcode) throw new Error(`WeChat upload error ${data.errcode || response.status}: ${data.errmsg || response.statusText}`);
    return data;
  }
  return {
    accessToken,
    uploadArticleImage(filePath) { return upload('/cgi-bin/media/uploadimg', filePath); },
    uploadPermanentMaterial(filePath, type = 'thumb', options = {}) { return upload('/cgi-bin/material/add_material', filePath, { type, ...(options.description ? { description: JSON.stringify(options.description) } : {}) }); },
    addDraft(article) { return jsonRequest('/cgi-bin/draft/add', { articles: [{ article_type: 'news', need_open_comment: 0, only_fans_can_comment: 0, ...article }] }); },
    getDraft(mediaId) { return jsonRequest('/cgi-bin/draft/get', { media_id: mediaId }); },
  };
}
