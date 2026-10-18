/**
 * 编辑区「显示」类设置的解析。
 *
 * 这些开关都影响排版而不是文档内容：限制行宽、折叠标题、折叠缩进、缩进参考线，
 * 以及状态栏的视图状态按钮。设置里缺省（旧版本保存的 settings.json）按开启处理，
 * 与 Obsidian 的默认值一致；因此统一在这里归一化，组件里不再各自写 `!== false`。
 */

/** 各编辑框自身宽度的百分比，100% 时铺满可用区域。 */
export const DEFAULT_LINE_WIDTH = 80;
export const LINE_WIDTH_MIN = 40;
export const LINE_WIDTH_MAX = 100;
export const LINE_WIDTH_STEP = 1;

export function lineWidthAfterWheel(width: number, steps: number): number {
  return Math.max(LINE_WIDTH_MIN, Math.min(LINE_WIDTH_MAX, normalizeLineWidth(width) + steps * 2));
}

/** 小触控板增量累加；100px、约3行或1页视为一档。 */
export function createLineWidthWheelAccumulator() {
  let pixels = 0;
  return (delta: number, mode = 0): number => {
    if (!Number.isFinite(delta)) return 0;
    pixels += delta * (mode === 1 ? 40 : mode === 2 ? 100 : 1);
    const steps = Math.trunc(pixels / 100);
    pixels -= steps * 100;
    return steps === 0 ? 0 : -steps;
  };
}

export interface EditorDisplaySettings {
  readable_line_length?: boolean;
  line_width?: number;
  fold_headings?: boolean;
  fold_indentation?: boolean;
  indent_guides?: boolean;
  show_view_state_button?: boolean;
}

export interface EditorDisplay {
  /** 文档区域占各自编辑框的百分比（包含排版留白）。 */
  readableLineLength: boolean;
  lineWidth: number;
  /** 折叠标题：标题下的正文可折叠到标题行。 */
  foldHeadings: boolean;
  /** 折叠缩进：缩进内容（列表等）可折叠。 */
  foldIndentation: boolean;
  /** 缩进参考线。 */
  indentGuides: boolean;
  /** 状态栏显示视图状态按钮。 */
  showViewStateButton: boolean;
}

export function normalizeLineWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LINE_WIDTH;
  // 旧版本为 480–2400px，不能把像素误当成百分比而全部挤到 100%。
  if (value > LINE_WIDTH_MAX) return DEFAULT_LINE_WIDTH;
  const clamped = Math.max(LINE_WIDTH_MIN, Math.min(LINE_WIDTH_MAX, value));
  return Math.round(clamped / LINE_WIDTH_STEP) * LINE_WIDTH_STEP;
}

export function resolveEditorDisplay(settings: EditorDisplaySettings | undefined): EditorDisplay {
  const source = settings ?? {};
  return {
    readableLineLength: source.readable_line_length !== false,
    lineWidth: normalizeLineWidth(source.line_width),
    foldHeadings: source.fold_headings !== false,
    foldIndentation: source.fold_indentation !== false,
    indentGuides: source.indent_guides !== false,
    showViewStateButton: source.show_view_state_button !== false,
  };
}
