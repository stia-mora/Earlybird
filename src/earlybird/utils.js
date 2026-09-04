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
export const STAGES = ['detected', 'captured', 'analyzed', 'written', 'humanized', 'rendered', 'draft_created', 'verified', 'failed', 'manual_review'];

export function postUrl(post) {
  const username = post?.author?.username || post?.username || post?.authorUsername || 'i';
  const id = post?.id || post?.postId;
  return id ? `https://x.com/${username}/status/${id}` : '';
}

export function comparePosts(a, b) {
  const ad = Date.parse(a?.createdAt || '') || 0;
  const bd = Date.parse(b?.createdAt || '') || 0;
  if (ad !== bd) return ad - bd;
  try { return BigInt(a?.id || 0) < BigInt(b?.id || 0) ? -1 : 1; } catch { return String(a?.id || '').localeCompare(String(b?.id || '')); }
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
  return String(text || '')
    .replace(/,/g, '，').replace(/\./g, '。').replace(/!/g, '！').replace(/\?/g, '？')
    .replace(/:/g, '：').replace(/;/g, '；').replace(/\(/g, '（').replace(/\)/g, '）')
    .replace(/\"/g, '“').replace(/'/g, '’');
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}
