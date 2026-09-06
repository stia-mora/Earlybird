import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function compact(value, maximum = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, maximum) || '当前官方发布的核心信息';
}

export function buildEndVisualBrief({ title, digest, contentType, sourceHandle } = {}) {
  const topic = compact(title, 100);
  const context = compact(digest, 220);
  const source = sourceHandle ? `信息来源为 @${sourceHandle}的官方发布。` : '';
  return `# 文末辅助配图简报

适用稿件类型：${contentType || 'article'}

主题：${topic}

写作上下文：${context}

${source}

以下图片放在正文、证据图和参考资料之后，作为帮读者梳理事件的实质性视觉补充。不要生成可能误导的人物照、官方 Logo、QR 码或伪造的推文截图；也不要让生图模型绘制难以辨认的中英文。

## 配图 1：把核心变化讲清楚

参考内容：用一张视觉化的“发布前—发布后”图把本次产品、能力或策略变化讲清楚。重点是读者看完后能知道“什么变了”，不是展示品牌。

生图提示词：

\`\`\`
为中文 AI 科技公众号制作一张精致的知识图解，主题是“${topic}”。参考事实：${context}。使用深石墨灰、象牙白和克制的暖金色，以两个抽象的系统状态对比、清晰的流程线和可视化数据结构表达核心变化。平面编辑插画与低饱和 3D 质感结合，留白充分，构图紧凑。不要任何可读文字、数字、Logo、人脸、QR 码。竖版 4:5，高清。
\`\`\`

## 配图 2：还原读者能感知的场景

参考内容：用具体的使用场景拆解简报里的能力，比如多段分镜连贯、代码工作流或研究推理过程。这张图只讲实际价值，不把未公布的能力画成既成事实。

生图提示词：

\`\`\`
制作一张关于“${topic}”的科技编辑插画。围绕这段已知上下文构图：${context}。画面要像一个可视化的使用场景，以三个相连的空间或抽象屏幕表达“输入、协作、结果”。深灰色背景，点缀柔和的金色与青绿色光线，控制在冷静、信息感强的科技编辑风格，不要过度未来主义。不要任何可读文字、官方 Logo、人脸或伪造的界面。横版 16:9，高清。
\`\`\`

## 配图 3：文末回响卡

参考内容：借鉴你提供的参考图里的深色背景、星点和清晰中心视觉重心，但不复刻其品牌或引导关注的内容。这是一张收束阅读的“仍值得继续观察”氛围图，可在公众号后台手动叠加一行本号的简短标语。

生图提示词：

\`\`\`
设计一张中文 AI 科技公众号的文末氛围卡，主题是“${topic}”。较大的深石墨色空间里有细腻、克制的暖金色粒子与星点，从中央向外延伸成很轻的网络引力线，中间保留一块干净留白区供后期添加少量文字。精致、不夸张、编辑化，不要任何可读文字、Logo、QR 码、关注按钮或人物。横版 16:9，高清。
\`\`\`
`;
}

export async function writeEndVisualBrief({ mediaDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', postId, ...brief } = {}) {
  if (!postId) throw new Error('postId is required to write an end visual brief');
  await mkdir(mediaDir, { recursive: true });
  const path = join(mediaDir, `${postId}-visual-brief.md`);
  await writeFile(path, buildEndVisualBrief(brief), 'utf8');
  return path;
}
