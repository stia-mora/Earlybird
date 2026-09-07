/* Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0. */
(function () {
  'use strict';

  const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : '/api';
  const statusLabels = { detected: '已发现', classified: '已判别', held: '等待合并', captured: '已采集', analyzed: '已分析', written: '已写作', humanized: '已审稿', rendered: '已排版', draft_created: '已创建草稿', manual_review: '人工审核', verified: '已验证', merged: '已并入主稿', failed: '失败', ignored: '已忽略' };
  const pipelineSteps = [
    ['detected', '已发现', 'blue'],
    ['classified', '已判别', 'blue'],
    ['held', '等待合并', 'yellow'],
    ['captured', '已采集', 'orange'],
    ['analyzed', '已分析', 'orange'],
    ['written', '已写作', 'orange'],
    ['humanized', '已审稿', 'orange'],
    ['rendered', '已排版', 'orange'],
    ['draft_created', '已创建草稿', 'green'],
    ['manual_review', '人工审核', 'yellow'],
    ['verified', '已验证', 'green'],
    ['merged', '已并入主稿', 'muted'],
    ['failed', '失败', 'red'],
    ['ignored', '已忽略', 'muted'],
  ];
  const readiness = [['xCookies', 'X Cookie', '允许采集器读取来源'], ['llm', '多模态模型', '翻译、摘要和公众号写作'], ['coverImage', '封面图服务', '生成 900×383 公众号专属封面'], ['wechat', '微信公众号', '创建和回读草稿'], ['redis', 'Redis 队列', '调度采集与文章任务'], ['mediaDir', '媒体目录', '保存证据和视频素材']];
  let timer;

  const $ = id => document.getElementById(id);
  const setHidden = (id, value) => { $(id).hidden = value; };
  const escapeText = value => String(value || '').replace(/\s+/g, ' ').trim();
  const dateTime = value => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
  const initials = value => escapeText(value).replace(/^@/, '').slice(0, 2).toUpperCase() || '??';

  async function request(path, options) {
    const token = localStorage.getItem('authToken');
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { ...(options && options.headers), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (response.status === 401) { const error = new Error('需要登录'); error.code = 'AUTH'; throw error; }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  function renderOverview(data) {
    const systemStates = [data.system.api, data.system.worker];
    const hasError = systemStates.some(item => item.state === 'stale' || item.state === 'not_configured');
    const hasWaiting = systemStates.some(item => item.state === 'waiting');
    $('status-orb').className = `status-orb${hasError ? ' error' : hasWaiting ? ' warn' : ''}`;
    $('system-state').textContent = hasError ? '系统需要检查' : hasWaiting ? '系统已接通，正在等待采集器' : '系统正在运行';
    $('system-detail').textContent = `${data.system.api.label} · ${data.system.worker.label}`;
    $('last-updated').textContent = `更新于 ${dateTime(data.generatedAt)}`;
    $('refresh-copy').textContent = '自动刷新 · 30 秒';
    $('metric-sources').textContent = data.metrics.enabledSources;
    $('metric-sources-detail').textContent = `共 ${data.metrics.sources} 个来源`;
    $('metric-posts').textContent = data.metrics.postsToday;
    $('metric-jobs').textContent = data.metrics.jobsToday;
    $('metric-drafts').textContent = data.metrics.verifiedDrafts;
    $('metric-drafts-detail').textContent = `共 ${data.metrics.drafts} 个草稿`;

    const total = Object.values(data.pipeline).reduce((sum, count) => sum + Number(count || 0), 0);
    $('pipeline-total').textContent = `${total} 个任务`;
    $('pipeline').replaceChildren(...pipelineSteps.map(([key, label, tone]) => {
      const node = document.createElement('div'); node.className = 'pipeline-step'; node.dataset.tone = tone;
      const name = document.createElement('span'); name.textContent = label; const count = document.createElement('strong'); count.textContent = data.pipeline[key] || 0; node.append(name, count); return node;
    }));
    $('readiness-list').replaceChildren(...readiness.map(([key, label, detail]) => {
      const item = document.createElement('div'); item.className = 'readiness-item'; const dot = document.createElement('i'); dot.className = `readiness-dot${data.config[key] ? '' : ' off'}`; const title = document.createElement('strong'); title.textContent = label; const state = document.createElement('span'); state.textContent = data.config[key] ? '已就绪' : '未配置'; item.title = detail; item.append(dot, title, state); return item;
    }));
    renderSources(data.sources);
    renderAttention(data.attention);
    renderActivity(data);
  }

  function renderSources(sources) {
    $('source-meta').textContent = `${sources.filter(source => source.enabled).length} 个启用`;
    if (!sources.length) { $('source-list').innerHTML = '<p class="empty-state">还没有配置 X 来源。</p>'; return; }
    $('source-list').replaceChildren(...sources.map(source => {
      const row = document.createElement('div'); row.className = 'source-row'; const mark = document.createElement('span'); mark.className = 'source-mark'; mark.textContent = initials(source.handle); const main = document.createElement('div'); main.className = 'source-main'; const strong = document.createElement('strong'); strong.textContent = source.displayName || `@${source.handle}`; const small = document.createElement('small'); small.textContent = `@${source.handle} · 最近轮询 ${dateTime(source.lastPolledAt)}`; main.append(strong, small); const state = document.createElement('span'); state.className = `source-state ${source.status.state}`; state.textContent = source.status.label; row.append(mark, main, state); return row;
    }));
  }

  function renderAttention(items) {
    if (!items.length) { $('attention-list').innerHTML = '<p class="empty-state">目前没有卡住的任务，继续观察下一次轮询。</p>'; return; }
    $('attention-list').replaceChildren(...items.map(item => {
      const row = document.createElement('div'); row.className = 'attention-row'; const badge = document.createElement('span'); badge.className = `attention-badge ${item.status}`; badge.textContent = statusLabels[item.status] || item.status; const main = document.createElement('div'); main.className = 'attention-main'; const strong = document.createElement('strong'); strong.textContent = item.reason || `${item.source} 的任务尚未进入下一步`; const small = document.createElement('small'); small.textContent = `${item.source} · ${dateTime(item.updatedAt)}${item.postId ? ` · X 帖子 ${item.postId}` : ''}`; main.append(strong, small); row.append(badge, main); if (item.status === 'failed' && localStorage.getItem('authToken')) { const button = document.createElement('button'); button.className = 'button-secondary'; button.type = 'button'; button.dataset.retryJob = item.id; button.textContent = '重试'; row.append(button); } else if (item.status === 'failed') { const hint = document.createElement('span'); hint.className = 'retry-hint'; hint.textContent = '登录后可重试'; row.append(hint); } return row;
    }));
  }

  function renderActivity(data) {
    const jobs = data.jobs.map(job => ({ type: '任务', title: `${statusLabels[job.status] || job.status} · ${job.source?.displayName || job.source?.handle || '未知来源'}`, detail: job.note || '正在推进。', time: job.updatedAt }));
    const notes = data.notifications.map(note => ({ type: '通知', title: `${note.kind} · ${note.status}`, detail: '通知记录已写入', time: note.createdAt }));
    const items = [...jobs, ...notes].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 20);
    if (!items.length) { $('activity-list').innerHTML = '<p class="empty-state">还没有任务或通知记录。</p>'; return; }
    $('activity-list').replaceChildren(...items.map(item => { const row = document.createElement('div'); row.className = 'activity-row'; const type = document.createElement('span'); type.className = 'activity-type'; type.textContent = item.type === '任务' ? '↗' : '•'; const main = document.createElement('div'); main.className = 'activity-main'; const title = document.createElement('strong'); title.textContent = item.title; const detail = document.createElement('small'); detail.textContent = item.detail || '无附加信息'; main.append(title, detail); const time = document.createElement('time'); time.className = 'activity-time'; time.textContent = dateTime(item.time); row.append(type, main, time); return row; }));
  }

  async function load() {
    setHidden('error-state', true); $('refresh-copy').textContent = '正在刷新…';
    try { const data = await request('/earlybird/overview'); setHidden('auth-gate', true); setHidden('main-content', false); renderOverview(data); }
    catch (error) {
      if (error.code === 'AUTH') {
        setHidden('main-content', true);
        setHidden('auth-gate', false);
      } else {
        $('status-orb').className = 'status-orb error';
        $('system-state').textContent = '状态暂时不可用';
        $('last-updated').textContent = '—';
        const message = error.message === 'Failed to fetch' ? 'API 未启动或网络不可达。' : error.message;
        $('system-detail').textContent = message;
        $('error-message').textContent = message;
        setHidden('error-state', false);
      }
      $('refresh-copy').textContent = '连接失败';
    }
  }

  document.addEventListener('click', async event => { const button = event.target.closest('[data-retry-job]'); if (!button) return; button.disabled = true; button.textContent = '提交中'; try { await request(`/earlybird/jobs/${button.dataset.retryJob}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }); await load(); } catch (error) { button.disabled = false; button.textContent = '重试'; $('error-message').textContent = error.message === 'Failed to fetch' ? 'API 未启动或网络不可达。' : error.message; setHidden('error-state', false); } });
  $('refresh-button').addEventListener('click', load); $('retry-button').addEventListener('click', load); load(); timer = window.setInterval(load, 30_000); window.addEventListener('beforeunload', () => window.clearInterval(timer));
}());
