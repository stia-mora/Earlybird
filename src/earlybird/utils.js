import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

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

export async function isNonemptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export function compactText(value, maximum = 300) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

export function jsonParse(value, fallback = null) {
  if (value == null || typeof value === 'object') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function sanitizeUnicode(value) {
  const text = String(value ?? '');
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += text[index] + text[index + 1];
        index += 1;
      } else {
        result += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += '\uFFFD';
    } else {
      result += text[index];
    }
  }
  return result;
}

export function sanitizeJsonUnicode(value) {
  if (typeof value === 'string') return sanitizeUnicode(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonUnicode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJsonUnicode(item)]));
  }
  return value;
}

export function fullWidthPunctuation(text) {
  const value = String(text || '');
  const replacements = { ',': '，', '.': '。', '!': '！', '?': '？', ':': '：', ';': '；', '(': '（', ')': '）' };
  const isChinese = character => /[\u3400-\u9FFF]/.test(character || '');

  let doubleQuoteOpen = false;
  let singleQuoteOpen = false;

  return [...value].map((character, index) => {
    if (character === '"') {
      const inChineseContext = isChinese(value[index - 1]) || isChinese(value[index + 1]);
      if (!inChineseContext) return character;
      if (!doubleQuoteOpen) {
        doubleQuoteOpen = true;
        return '“';
      }
      doubleQuoteOpen = false;
      return '”';
    }
    if (character === "'") {
      const inChineseContext = isChinese(value[index - 1]) || isChinese(value[index + 1]);
      if (!inChineseContext) return character;
      if (!singleQuoteOpen) {
        singleQuoteOpen = true;
        return '‘';
      }
      singleQuoteOpen = false;
      return '’';
    }
    if (!replacements[character]) return character;
    // Preserve punctuation inside English prose, URLs, contractions, and versions such as Image 2.0.
    return isChinese(value[index - 1]) || isChinese(value[index + 1]) ? replacements[character] : character;
  }).join('').replace(/([，。！？；：])\s+(?=[\u3400-\u9FFF])/g, '$1');
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}
