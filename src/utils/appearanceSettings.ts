import { isMacOS } from './platform.ts';

export const DEFAULT_FONT_SIZE = 14;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_RANGE_THUMB = 18;
export const DEFAULT_LINE_HEIGHT = 1.4;
export const DEFAULT_UI_FONT_SIZE = 13;
export const DEFAULT_LETTER_SPACING = 0.6;
export const UI_FONT_SIZE_MIN = 11;
export const UI_FONT_SIZE_MAX = 20;

export function normalizeTypography(appearance: { ui_font_size?: unknown; letter_spacing?: unknown }) {
  const clamp = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  return {
    uiFontSize: clamp(appearance.ui_font_size, DEFAULT_UI_FONT_SIZE, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX),
    letterSpacing: clamp(appearance.letter_spacing, DEFAULT_LETTER_SPACING, 0, 5),
  };
}

export function typographyCssVariables(appearance: { ui_font_size?: unknown; letter_spacing?: unknown }) {
  const { uiFontSize, letterSpacing } = normalizeTypography(appearance);
  return {
    '--ui-font-scale': String(uiFontSize / DEFAULT_UI_FONT_SIZE),
    '--ui-font-base-size': `${uiFontSize}px`,
    '--text-letter-spacing': `${letterSpacing}px`,
  };
}

/**
 * 构造编辑区内容的字体栈，规则与 App.tsx 写入 --font-content 的保持一致。
 *
 * Monaco 的折行/字符宽度测量以 fontFamily 字符串为缓存键（FontMeasurements
 * 按 fontFamily+fontSize+lineHeight 的 getId() 缓存）。因此这里必须返回
 * 可直接解析的真实字体名，**不能**传 'var(--font-content)' 这类 CSS 变量
 * 引用——CSS 变量字符串本身不随字体变化，更换字体后 Monaco 会命中旧测量
 * 缓存，渲染用的是新字体而折行宽度仍按旧字体计算，导致行文字溢出编辑框。
 */
export function contentFontStack(fontFamily?: string): string {
  const family = fontFamily?.replace(/[;{}]/g, '').trim();
  // 未指定字体时按平台取系统字体：macOS 回落到微软雅黑会明显「像 Windows 软件」。
  const fallback = isMacOS()
    ? '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif'
    : '"Microsoft YaHei", sans-serif';
  return family ? `${family}, ${fallback}` : fallback;
}

export function getRangeMarkerGeometry(
  value: number,
  min: number,
  max: number,
  thumbSize: number,
) {
  const ratio = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  return {
    progressPercent: Number((ratio * 100).toFixed(4)),
    thumbOffsetPx: Number(((thumbSize / 2) * (1 - 2 * ratio)).toFixed(4)),
  };
}
