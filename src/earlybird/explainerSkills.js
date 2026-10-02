/**
 * @author nich (@nichxbt)
 * @license Apache-2.0
 */
import { readFile } from 'node:fs/promises';

export const EXPLAINER_NARRATIVE_RULES = `解读面向对 AI 感兴趣的普通中文读者。先确定读者正在做的事、遇到的困难，以及这次事件改变了哪一步。用来源中可核实的动作、场景、反差或结果开篇，尽早回答这件事与读者有什么关系；资料没有真实场景时，可以用明确标成“例如”“如果”的假设说明，不能编造亲历、采访、用户反应、情绪或实测。
围绕一个读者问题推进：具体变化、背后的原因或机制、证据、实际影响与仍待解决的问题。每节提供新信息，技术名词先用具体动作解释，再交代准确含义和条件。允许有依据的编辑判断并标明推断，不写公告式功能罗列、宏大意义、空泛利弊和时代宣言。长短句按思路自然变化，不机械规定单句与双句的比例，不为制造节奏拆散因果。润色要重建读者视角和段落衔接，不能只换几个词。`;

export const EXPLAINER_VISUAL_RULES = `解读正文至少五张不同的有效配图，五张是底线，不是完成目标或上限。先按故事节点记录要支持的论点，再分别寻找结果、实际操作、机制、对比或条件、影响等有信息增量的图；节点随故事调整，不固定套五段。逐项完成视觉检索计划，达到五张后仍继续寻找未覆盖节点和更好的证据。有用的更多图片继续加入正文，不以固定数量截断；同图重复、同一画面的重复关键帧、无关装饰、封面和栏目尾图不能凑数。
官网、论文、报告用于正式结果和机制；当事实是发言、现场演示或争议回应时去 X 等原始发布渠道，结合 researchPlan 找原帖和附件。图片搜索只是线索，文件 CDN 不是原出处；出处或版本未核验时如实标明，不把描述或搜索摘要当成已看过画面。AI 概念图不能代替证据；缺证据或可用图不足时转人工审核。
每张图紧邻所支撑的段落。Markdown 图片 alt 写成真实图下注释：图中可见内容、读图提示、支持的论点和必要条件，来源名称可写在图注，来源 URL 由排版器补充。不要用“产品图”“图一”代替解释，不在正文和图注重复长段限定。对照实际提供的图片判断内容、版本、坐标与手机可读性，不能凭文件名编造图注。`;

// Keep the runtime independent of any developer's globally installed skills.
export async function loadExplainerSkills() {
  const root = new URL('../../vendor/references/earlybird-wechat-story/', import.meta.url);
  const files = ['SKILL.md', 'references/writing-and-layout.md', 'references/image-sourcing.md'];
  const texts = await Promise.all(files.map(file => readFile(new URL(file, root), 'utf8')));
  const humanizer = await readFile(new URL('../../vendor/references/humanizer-zh/SKILL.md', import.meta.url), 'utf8');
  return `执行 earlybird-wechat-story 与 Humanizer-zh 两个 skill。以下为本地规则全文：\n${texts.join('\n\n')}\n\n${humanizer}\n\n流水线执行约定（优先于参考中的通用交付方式）：只返回调用方要求的 JSON；使用已提供的真实图片路径，不能生成待补图占位或虚构图像；来源 URL 交给排版器；Markdown 强调交给排版器；不套用参考中的篇幅或主题模板。\n${EXPLAINER_NARRATIVE_RULES}\n${EXPLAINER_VISUAL_RULES}`;
}
