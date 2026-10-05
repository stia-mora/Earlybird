// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */
import { readFile } from 'node:fs/promises';

export const EXPLAINER_NARRATIVE_RULES = `解读面向对 AI 感兴趣的普通中文读者，风格对标新智元一线科技报道。
开篇必须用来源中可核实的反差、具体数字、剧烈冲突或核心颠覆结果直接起笔，尽早讲明这件事为什么引起行业震动、与读者有什么实际关系；坚决禁止“随着…的发展/提升”“在…的背景下”等公文式陈词滥调。
语言风格要生动、利落、说人话，多用短句。允许并鼓励基于已核实事实作出鲜明、有感染力的口语化情绪判断与点评（如“这波属实离谱”“这是马斯克少有的认怂时刻”），只要事实本身真实可核查，绝不空转。严禁“表明”“意味着”“凸显了”“彰显了”“迈出了坚实一步”等公文通稿套话。
段落长短交还给叙事起伏：允许极短单句成段（甚至“30.2%。”单个数字成段）制造情绪冲击，也允许深入展开事实机制。不要机械规定段落长短或拆碎句子。
围绕读者关心的核心冲突推进：具体变化、背后的原因与机制动作拆解、扎实证据、实际影响与仍待解决的问题。每节提供新信息，技术名词先用具体动作解释，再交代准确含义和条件。不写公告式功能罗列、宏大宣誓和空泛总结。润色要重建读者视角和段落衔接，不能只换几个词。`;

export const EXPLAINER_VISUAL_RULES = `解读正文至少五张不同的有效配图，五张是底线，不是完成目标或上限。先按故事节点记录要支持的论点，再分别寻找结果、实际操作、机制、对比或条件、影响等有信息增量的图；节点随故事调整，不固定套五段。逐项完成视觉检索计划，达到五张后仍继续寻找未覆盖节点和更好的证据。有用的更多图片继续加入正文，不以固定数量截断；同图重复、同一画面的重复关键帧、无关装饰、封面和栏目尾图不能凑数。
官网、论文、报告用于正式结果和机制；当事实是发言、现场演示或争议回应时去 X 等原始发布渠道，结合 researchPlan 找原帖和附件。图片搜索只是线索，文件 CDN 不是原出处；出处或版本未核验时如实标明，不把描述或搜索摘要当成已看过画面。AI 概念图不能代替证据；缺证据或可用图不足时转人工审核。
每张图紧邻所支撑的段落。不要额外添加解释性小字、编辑旁注、选图理由或层层免责声明。Markdown 图片 alt 只写一条必要的读图提示或画面信息，通常一句短话、15 至 35 字，不为凑字数扩写；复杂图只补理解它必需的条件。不要机械地逐图写齐“画面、论点、意义、边界”四项，也不复述正文。重要条件与未知项在对应正文论点旁交代，只有离开图注就会误读的条件才保留简短限定。来源由排版器合并在同一条图下注释中，alt 不重复写来源，完整链接集中在文末。不要用“产品图”“图一”代替必要信息。对照实际提供的图片判断内容、版本、坐标与手机可读性，不能凭文件名编造图注。`;

// Keep the runtime independent of any developer's globally installed skills.
export async function loadExplainerSkills() {
  const root = new URL('../../vendor/references/earlybird-wechat-story/', import.meta.url);
  const files = ['SKILL.md', 'references/writing-and-layout.md', 'references/image-sourcing.md'];
  const texts = await Promise.all(files.map(file => readFile(new URL(file, root), 'utf8')));
  const humanizer = await readFile(new URL('../../vendor/references/humanizer-zh/SKILL.md', import.meta.url), 'utf8');
  return `执行 earlybird-wechat-story 与 Humanizer-zh 两个 skill。以下为本地规则全文：\n${texts.join('\n\n')}\n\n${humanizer}\n\n流水线执行约定（优先于参考中的通用交付方式）：只返回调用方要求的 JSON；使用已提供的真实图片路径，不能生成待补图占位或虚构图像；来源 URL 交给排版器；Markdown 强调交给排版器；不套用参考中的篇幅或主题模板。\n${EXPLAINER_NARRATIVE_RULES}\n${EXPLAINER_VISUAL_RULES}`;
}
