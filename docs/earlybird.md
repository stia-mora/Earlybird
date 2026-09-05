# EarlyBird X -> 微信公众号草稿流水线

## 启动

1. 复制 `.env.example` 为 `.env`，填写 `DATABASE_URL`、`X_COOKIES`、多模态模型和 `WECHAT_APP_ID/WECHAT_APP_SECRET`。
2. 执行 `npx prisma migrate deploy`。
3. 启动 API：`npm start`；启动独立采集/文章 worker：`node src/earlybird/worker.js`。
4. Docker Compose 会分别启动 `api`、原有 `worker` 和 `earlybird-worker`，媒体文件保存在 `earlybird_media` volume。

首次 worker 启动会创建已配置的 AI 官方来源并建立基线，基线中的历史帖子不会生成草稿。默认每 60 秒轮询；根帖触发后默认等待 90 秒合并完整线程。可用 `EARLYBIRD_THREAD_WAIT_MS=0` 在测试环境跳过等待。

每条新帖先由选题判别器决定 `ignore`、`brief`、`explainer` 或 `event`：回复、评论和缺少独立新闻价值的内容会直接忽略。当前快讯仅允许 `@thsottiaux` 关于 Codex 重置或 Codex 适配 ChatGPT 新模型的消息；其他 Tibo 消息暂不成稿。解释型候选默认暂存一小时（`EARLYBIRD_EVENT_WINDOW_MINUTES=60`），后续官方动态若与其构成同一事件，可合并为事件追踪稿；未合并的候选在窗口结束后再生成解释稿。

## API

所有接口都需要现有 XActions 登录态：

- `GET/POST/PATCH/DELETE /api/earlybird/sources`
- `GET /api/earlybird/jobs`、`GET /api/earlybird/jobs/:id`
- `GET /api/earlybird/jobs/:id/preview`
- `POST /api/earlybird/jobs/:id/retry`
- `POST /api/earlybird/jobs/:id/create-draft`

`create-draft` 只创建微信公众号草稿，不执行群发。草稿回读验证通过后，job 才进入 `verified`。Humanizer 总分低于 45 会停在 `manual_review`，不会调用微信接口。

## 媒体和合规

图片会下载、hash 去重并通过 `media/uploadimg` 上传；首图作为封面通过 `material/add_material` 上传。视频转码为 H.264/AAC，生成封面和关键帧，视频永久素材 `media_id` 会保存到 `EarlyBirdAsset`；正文使用封面、摘要/转写和公开链接，不生成不稳定的 `<video>` 标签。

排版读取固定的 `vendor/references` 快照，输出只包含公众号可粘贴的 `<section>` 片段。校验命令：

```bash
python scripts/validate_gzh_html.py output.html
```

证据截图使用环境变量中的 X Cookie 打开原帖；只有找到对应帖子卡片且未检测到 403／登录拒绝页时才会生成草稿。截图失败会使任务失败，不会把错误页当作证据上传。

解释型和事件追踪稿可由模型给出最多三个检索词，受控浏览器仅从已配置官方站点域名的搜索结果中提取资料和图片。检索结果、页面跳转和下载图片都再次执行 HTTPS 官方域名校验；网页文本只作为不可信事实资料，不能改变任务指令。可通过 `EARLYBIRD_RESEARCH_ENABLED=false` 关闭。

X Cookie、微信密钥和模型密钥只从环境变量读取，不写入 Prisma 或日志。转载前仍需人工确认 X、微信平台规则及原作者授权。
