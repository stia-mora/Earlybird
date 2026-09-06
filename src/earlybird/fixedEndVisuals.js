import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export const FIXED_END_VISUALS = [
  { fileName: 'earlybird-endcard-signal.png', alt: 'EarlyBird Pulse 官方 AI 动态追踪' },
  { fileName: 'earlybird-endcard-observe.png', alt: 'EarlyBird Pulse 持续关注后续进展' },
];

async function fileExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function availableFixedEndVisuals({ mediaDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', exists = fileExists } = {}) {
  const visuals = FIXED_END_VISUALS.map(item => ({ ...item, localPath: join(mediaDir, 'fixed-end', item.fileName) }));
  const available = await Promise.all(visuals.map(item => exists(item.localPath)));
  // The two images are designed as one closing set; never insert a partial set.
  return available.every(Boolean) ? visuals : [];
}
