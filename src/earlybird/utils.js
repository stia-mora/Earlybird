import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const DEFAULT_SOURCES = [
  { handle: 'openai', displayName: 'OpenAI', website: 'https://openai.com' },
  { handle: 'chatgpt', displayName: 'ChatGPT', website: 'https://chatgpt.com' },
  { handle: 'sama', displayName: 'Sam Altman', website: 'https://openai.com' },
  { handle: 'thsottiaux', displayName: 'Thomas Sottiaux', website: 'https://openai.com' },
  { handle: 'geminiapp', displayName: 'Google Gemini', website: 'https://gemini.google.com' },
  { handle: 'googledeepmind', displayName: 'Google DeepMind', website: 'https://deepmind.google' },
  { handle: 'claudeai', displayName: 'Claude', website: 'https://claude.ai' },
  { handle: 'anthropicai', displayName: 'Anthropic', website: 'https://www.anthropic.com' },
  { handle: 'grok', displayName: 'Grok', website: 'https://grok.com' },
  { handle: 'xai', displayName: 'xAI', website: 'https://x.ai' },
];
export const DEFAULT_HANDLES = DEFAULT_SOURCES.map(source => source.handle);
export const STAGES = ['detected', 'editorial_review', 'researching', 'writing', 'revising', 'quality_review', 'manual_review', 'merged', 'analyzed', 'written', 'rendered', 'verified', 'failed'];

export function postUrl(post) {
  const username = post?.author?.username || post?.username || post?.authorUsername || 'i';
  const id = post?.id || post?.postId;
  return id ? `https://x.com/${username}/status/${id}` : '';
}

export function comparePosts(a, b) {
  const ad = Date.parse(a?.createdAt || '') || 0;
  const bd = Date.parse(b?.createdAt || '') || 0;
  if (ad !== bd) return ad - bd;
  try {
    const aid = BigInt(a?.id || 0);
    const bid = BigInt(b?.id || 0);
    return aid === bid ? 0 : aid < bid ? -1 : 1;
  } catch {
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  }
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function fileSha256(path) {
  return sha256(await readFile(path));
}

export function jsonParse(value, fallback = null) {
  if (value == null || typeof value === 'object') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function fullWidthPunctuation(text) {
  const value = String(text || '');
  const replacements = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '(': '（', ')': '）', '"': '“', "'": '’' };
  const isChinese = character => /[\u3400-\u9FFF]/.test(character || '');

  return [...value].map((character, index) => {
    if (!replacements[character]) return character;
    // Preserve punctuation inside English prose, URLs, contractions, and versions such as Image 2.0.
    return isChinese(value[index - 1]) || isChinese(value[index + 1]) ? replacements[character] : character;
  }).join('').replace(/([，。！？；：])\s+(?=[\u3400-\u9FFF])/g, '$1');
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}
