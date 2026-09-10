# EarlyBird X -> 微信公众号草稿流水线

## 启动

1. 复制 `.env.example` 为 `.env`，填写 `DATABASE_URL`、`X_COOKIES`、多模态模型和 `WECHAT_APP_ID/WECHAT_APP_SECRET`。
2. 执行 `npx prisma migrate deploy`。
3. 启动 API：`npm start`；启动独立采集/文章 worker：`node src/earlybird/worker.js`。
4. Docker Compose 会分别启动 `api`、原有 `worker` 和 `earlybird-worker`，媒体文件保存在宿主机的 `data/earlybird/media` 目录。

首次 worker 启动会创建已配置的 AI 官方来源并建立基线，基线中的历史帖子不会生成草稿。默认每 60 秒轮询；根帖触发后默认等待 90 秒合并完整线程。可用 `EARLYBIRD_THREAD_WAIT_MS=0` 在测试环境跳过等待。

基线完成后，新内容会等待下一个 30 分钟编辑批次（由 `EARLYBIRD_EDITORIAL_BATCH_MINUTES` 配置）。独立总编辑先决定快讯、解读或事件合稿：只有同一公司、产品或具体事件能够形成时间线的内容才会合稿，不能只因同属 AI 话题而合并。每个工作日的 09:00 与 17:00（Asia/Shanghai）会重新检查当日内容和 EarlyBird 管理的草稿，以发现晚到的关联信息。

快讯要求 350 至 700 个中文字符和至少一张正文图；解读要求 1200 至 1800 个中文字符、叙事标题和至少三张正文图；事件合稿要求 1800 至 2600 个中文字符、至少两条来源、时间线和至少三张正文图。写作后由与写作 Agent 分离的质量审核再次检查事实来源、故事线、自然度和图文对应；失败稿最多自动定向改写三轮，仍不合格或素材不足时停在 `manual_review`，不会创建微信草稿。

## API

所有接口都需要现有 XActions 登录态：

- `GET/POST/PATCH/DELETE /api/earlybird/sources`
- `GET /api/earlybird/jobs`、`GET /api/earlybird/jobs/:id`
- `GET /api/earlybird/jobs/:id/preview`
- `POST /api/earlybird/jobs/:id/retry`
- `POST /api/earlybird/jobs/:id/review`（重新运行当日编辑审核）
- `POST /api/earlybird/jobs/:id/create-draft`

`create-draft` 只创建微信公众号草稿，不执行群发。草稿回读验证通过后，job 才进入 `verified`。只有总编辑和质量审核均通过的稿件会调用微信接口。合稿或改稿会先创建并回读验证新草稿，再删除数据库中同一 EarlyBird 任务追踪的旧草稿；旧稿删除失败时会保留新旧 `media_id` 记录并转入 `manual_review`，不会触及公众号后台的人工草稿。

## 媒体和合规

图片会下载、hash 去重并通过 `media/uploadimg` 上传。正文优先使用原帖附件、线程媒体和证据截图；不足时配置 `EARLYBIRD_TAVILY_API_KEY`，通过 Tavily Search 检索全网图片，保存图片 URL、返回的标题/描述、来源域名、检索词和获取时间，并在图片下方和文末参考资料中标示来源。按当前产品决策，有出处的全网结果会自动采用，系统不保证第三方图片授权。无足够正文图时不会用封面冒充正文图，而会要求合稿或人工审核。

每篇通过审稿的文章会在创建草稿前生成一张 `900×383`（2.35:1）的纯视觉公众号封面，并通过 `material/add_material` 作为草稿封面上传；封面不插入正文。封面提示词和图片保存在 `data/earlybird/media/covers/<post-id>/`，重试会复用有效封面，避免再次调用图像模型。图像主模型由 `EARLYBIRD_COVER_IMAGE_MODEL` 配置，失败时自动改用 `EARLYBIRD_COVER_IMAGE_FALLBACK_MODEL`；两者都不可用时，流水线回退到已验证的正文视觉素材。视频转码为 H.264/AAC，生成封面和关键帧，但不再自动上传至微信素材库。原始 MP4 会保留在 `data/earlybird/media`，草稿通知会提示文件名供人工审核上传。正文仍使用原帖图片、关键帧和视频摘要，不生成不稳定的 `<video>` 标签。

文末紧跟在参考资料之后使用固定的栏目尾图。图片为 `data/earlybird/media/fixed-end/earlybird-endcard.png`，后续所有草稿会自动上传并插入文末。图片缺失时不会插入占位图。

排版读取固定的 `vendor/references` 快照，输出只包含公众号可粘贴的 `<section>` 片段。校验命令：

```bash
python scripts/validate_gzh_html.py output.html
```

证据截图使用环境变量中的 X Cookie 打开原帖。只有找到对应帖子卡片且未检测到 403／登录拒绝页时才会插入原帖截图；截图失败时会跳过该图片继续写作，不会把错误页当作证据上传。

X Cookie、微信密钥和模型密钥只从环境变量读取，不写入 Prisma 或日志。转载前仍需人工确认 X、微信平台规则及原作者授权。
