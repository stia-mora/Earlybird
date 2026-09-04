import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { escapeHtml, fullWidthPunctuation } from './utils.js';

export async function captureEvidence({ tweetUrl, translation = '', outputPath, browser, launchOptions = {}, thread = [] } = {}) {
  if (!tweetUrl || !outputPath) throw new Error('tweetUrl and outputPath are required');
  await mkdir(dirname(outputPath), { recursive: true });
  const ownBrowser = browser || await puppeteer.launch({ headless: true, ...launchOptions });
  const page = await ownBrowser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 }).catch(() => {});
    const shot = await page.$('article[data-testid="tweet"]') || page;
    const raw = await shot.screenshot({ type: 'png' });
    const encoded = raw.toString('base64');
    const threadNote = thread.length > 1 ? `<p style="font-size:13px;color:#71717A;margin:12px 0 0;"><span leaf="">线程共 ${thread.length} 条，以下为根帖证据。</span></p>` : '';
    const html = `<section style="width:1280px;padding:32px;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#27272A;"><img src="data:image/png;base64,${encoded}" style="max-width:100%;height:auto;display:block;margin:0 auto;border:1px solid #E4E4E7;"><p style="font-size:18px;line-height:1.8;margin:24px 0 0;padding-top:20px;border-top:1px solid #E4E4E7;"><span leaf="">${escapeHtml(fullWidthPunctuation(translation || '暂无中文翻译'))}</span></p>${threadNote}</section>`;
    const composite = await ownBrowser.newPage();
    await composite.setContent(html, { waitUntil: 'load' });
    await composite.screenshot({ path: outputPath, fullPage: true, type: 'png' });
    await composite.close();
    return { path: resolve(outputPath), bytes: (await readFile(outputPath)).length, rawBytes: raw.length };
  } finally {
    await page.close().catch(() => {});
    if (!browser) await ownBrowser.close().catch(() => {});
  }
}
