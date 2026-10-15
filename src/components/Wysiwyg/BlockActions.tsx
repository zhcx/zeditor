/**
 * 块悬停操作条：只读块的主要入口（编辑源码），以及所有块的删除与「在下方插入段落」。
 * 它是块元素的兄弟节点且 contentEditable=false，不进入「DOM → 源码」的序列化范围。
 */
import { AppIcon } from '../Icons/AppIcon';

export interface BlockActionsProps {
  index: number;
  kind: string;
  editable: boolean;
  onEditSource: (index: number) => void;
  onDelete: (index: number) => void;
  onInsertAfter: (index: number) => void;
}

/** 这些块即使可序列化，源码弹窗也是主要编辑方式（表格与代码块尤其如此）。 */
const SOURCE_EDITABLE_KINDS = new Set(['table', 'fence', 'html', 'other']);

export function BlockActions({ index, kind, editable, onEditSource, onDelete, onInsertAfter }: BlockActionsProps) {
  const canEditSource = !editable || SOURCE_EDITABLE_KINDS.has(kind);
  return (
    <div className="wysiwyg-block-actions" contentEditable={false}>
      {canEditSource && (
        <button type="button" onClick={() => onEditSource(index)} title="编辑该块的 Markdown 源码">
          <AppIcon name="format" size={14} />
          <span>源码</span>
        </button>
      )}
      <button type="button" onClick={() => onInsertAfter(index)} title="在下方插入段落">
        <AppIcon name="plus" size={14} />
      </button>
      <button type="button" className="is-danger" onClick={() => onDelete(index)} title="删除该块">
        <AppIcon name="trash" size={14} />
      </button>
    </div>
  );
}
