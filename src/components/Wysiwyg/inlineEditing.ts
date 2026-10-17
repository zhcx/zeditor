/**
 * 内联目标的编辑辅助：把内联弹窗提交的字段还原成 Markdown 源码。
 *
 * 与 `InlinePopup` / `ImagePropertiesModal` 的字段一一对应，弹窗本身不做任何 Markdown 拼装，
 * 因此这两处既有组件不需要为所见即所得模式改动。
 */
import {
  formatFootnoteReference,
  formatLinkMarkdown,
  formatWikiLinkMarkdown,
  type InlineTarget,
} from '../../utils/inlineTargets';
import { formatImageMarkdown, type ImageSpec } from '../../utils/imageSyntax';
import type { InlinePopupFields } from '../Editor/InlinePopup';

/** 内联弹窗字段 → 替换该目标所需的 Markdown 源码。 */
export function inlineTargetMarkdown(target: InlineTarget, fields: InlinePopupFields): string {
  switch (target.kind) {
    case 'link':
      return formatLinkMarkdown(fields.label ?? target.label?.text ?? '', fields.url ?? '');
    case 'wikilink':
      return formatWikiLinkMarkdown(fields.target ?? target.target?.text ?? '', fields.label);
    case 'footnote':
      return formatFootnoteReference(fields.name ?? target.name ?? '');
    case 'math': {
      const latex = (fields.latex ?? target.latex ?? '').trim();
      return fields.display === 'block' ? `$$\n${latex}\n$$` : `$${latex}$`;
    }
    case 'image':
    default:
      return formatImageMarkdown({
        alt: fields.alt ?? target.alt?.text ?? '',
        src: fields.src ?? target.src?.text ?? '',
        ...(fields.title ?? target.title ? { title: (fields.title ?? target.title) as string } : {}),
      });
  }
}

/** 图片属性弹窗的规格 → Markdown（保留原属性后缀）。 */
export function imageSpecMarkdown(spec: ImageSpec): string {
  return formatImageMarkdown(spec);
}
