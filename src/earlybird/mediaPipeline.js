// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { itemsFromTweet } from '../media/sources.js';
import { downloadAll } from '../media/download.js';
import { openArchive } from '../media/archive.js';
import { fileSha256, isNonemptyFile } from './utils.js';

const execFileAsync = promisify(execFile);

function mediaKind(item) {
  return String(item.mediaType || item.type || '').toLowerCase().includes('video') || /\.mp4(?:\?|$)/i.test(item.url || '') ? 'video' : 'image';
}

async function existingFile(path) {
  return await isNonemptyFile(path) ? path : null;
}

export function createMediaPipeline({ prisma, outputDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', publicBaseUrl = process.env.EARLYBIRD_PUBLIC_MEDIA_URL || '', ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', logger = console } = {}) {
  async function ffmpeg(args) {
    try { await execFileAsync(ffmpegPath, args, { windowsHide: true }); return true; }
    catch (error) { logger.warn?.('ffmpeg unavailable or failed', error.message); return false; }
  }
  return {
    async collect({ post, thread = [] }) {
      await mkdir(outputDir, { recursive: true });
      const items = thread.flatMap(tweet => itemsFromTweet(tweet).map(item => ({ ...item, kind: mediaKind(item) })));
      if (!items.length) return [];
      const archive = await openArchive(join(outputDir, '.archive.jsonl'));
      const downloaded = (await downloadAll(items, { outputDir, archive, concurrency: 3, retries: 2 })).results;
      const records = [];
      for (const item of downloaded) {
        if (!item.path) continue;
        const kind = mediaKind(item);
        const sha256 = await fileSha256(item.path);
        const base = join(outputDir, `${post.postId}-${records.length + 1}`);
        let localPath = item.path;
        const metadata = { tweetId: item.tweetId, width: item.width, height: item.height, altText: item.altText };
        if (kind === 'video') {
          const mp4 = `${base}.mp4`;
          const transcoded = await ffmpeg([
            '-y', '-i', item.path,
            '-vf', 'scale=min(854\\,iw):-2',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '28', '-maxrate', '1600k', '-bufsize', '3200k',
            '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', mp4,
          ]);
          if (transcoded) {
            localPath = mp4;
            const posterPath = `${base}-poster.jpg`;
            const audioPath = `${base}.mp3`;
            const keyframePaths = [`${base}-frame-01.jpg`, `${base}-frame-02.jpg`, `${base}-frame-03.jpg`];
            await ffmpeg(['-y', '-i', mp4, '-vf', 'thumbnail,scale=960:-2', '-frames:v', '1', posterPath]);
            await ffmpeg(['-y', '-i', mp4, '-vf', 'fps=1/5,scale=960:-2', '-frames:v', '3', `${base}-frame-%02d.jpg`]);
            await ffmpeg(['-y', '-i', mp4, '-vn', '-acodec', 'libmp3lame', audioPath]);
            const [poster, audio, ...keyframes] = await Promise.all([posterPath, audioPath, ...keyframePaths].map(existingFile));
            if (poster) metadata.posterPath = poster;
            if (audio) metadata.audioPath = audio;
            metadata.keyframes = keyframes.filter(Boolean);
          }
        }
        let publicUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(basename(localPath))}` : null;
        const data = { postId: post.id, kind, sourceUrl: item.url, localPath, publicUrl, sha256, mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg', status: 'ready', metadata };
        const record = prisma ? await prisma.earlyBirdAsset.upsert({ where: { postId_sourceUrl: { postId: post.id, sourceUrl: item.url } }, update: data, create: data }) : { ...data, id: `${post.id}-${records.length}` };
        records.push(record);
      }
      return records;
    },
    async exists(path) { try { await stat(path); return true; } catch { return false; } },
  };
}
