import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { escapeHtml, fullWidthPunctuation } from './utils.js';
import { parseCookieString } from '../scrapers/twitter/http/auth.js';

const DENIED_PAGE = /access to x\.com was denied|http error 403|you don't have authorization/i;

export function xBrowserCookies(cookieString = process.env.X_COOKIES || process.env.TWITTER_COOKIES || '') {
  return Object.entries(parseCookieString(cookieString)).map(([name, value]) => ({ name, value, url: 'https://x.com/' }));
}

export function assertTweetEvidence({ pageText = '', articleText = '', hasExpectedStatusLink = true } = {}) {
  if (DENIED_PAGE.test(pageText) || DENIED_PAGE.test(articleText)) throw new Error('X denied access to the post page; evidence screenshot was not created');
  if (!articleText.trim()) throw new Error('X post card was empty; evidence screenshot was not created');
  if (!hasExpectedStatusLink) throw new Error('X post card did not contain the expected status link; evidence screenshot was not created');
}

export async function captureEvidence({ tweetUrl, postId, translation = '', outputPath, browser, launchOptions = {}, thread = [] } = {}) {
  if (!tweetUrl || !outputPath) throw new Error('tweetUrl and outputPath are required');
  if (postId && !/^\d+$/.test(String(postId))) throw new Error('postId must be a numeric X status ID');
  await mkdir(dirname(outputPath), { recursive: true });
  const sandboxArgs = process.env.PUPPETEER_NO_SANDBOX === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
  const ownBrowser = browser || await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    ...launchOptions,
    args: ['--disable-blink-features=AutomationControlled', ...sandboxArgs, ...(launchOptions.args || [])],
  });
  const page = await ownBrowser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    const cookies = xBrowserCookies();
    if (cookies.length) await page.setCookie(...cookies);
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const initialPageText = await page.evaluate(() => document.body?.innerText || '');
    assertTweetEvidence({ pageText: initialPageText, articleText: 'pending' });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    const cards = await page.$$('article[data-testid="tweet"]');
    let shot = cards[0];
    if (postId) {
      shot = null;
      for (const card of cards) {
        const statusLink = await card.$(`a[href*="/status/${postId}"]`);
        if (statusLink) {
          await statusLink.dispose().catch(() => {});
          shot = card;
          break;
        }
      }
    }
    if (!shot) throw new Error('X post card was not found; evidence screenshot was not created');
    const [pageText, articleText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || ''),
      shot.evaluate(element => element.innerText || ''),
    ]);
    assertTweetEvidence({ pageText, articleText });
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
