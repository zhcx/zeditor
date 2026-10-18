/**
 * 平台判定：桌面端（WKWebView / WebView2）与浏览器预览共用同一套逻辑。
 *
 * theme-boot.js 在首帧渲染前就把判定结果写入 `<html data-platform>`，样式表
 * 据此启用 macOS 原生外观层（macos.css）。这里读取同一份结果，保证 JS 与 CSS
 * 的判定完全一致；缺失时（例如单测环境或缓存脚本未执行）再回落到 UA 探测。
 */
export type DesktopPlatform = 'macos' | 'windows' | 'linux';

function detectFromNavigator(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const raw = `${userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  if (/mac|iphone|ipad|ipod/i.test(raw)) return 'macos';
  if (/win/i.test(raw)) return 'windows';
  return 'linux';
}

export function detectPlatform(): DesktopPlatform {
  if (typeof document === 'undefined') return detectFromNavigator();
  const declared = document.documentElement.dataset.platform;
  if (declared === 'macos' || declared === 'windows' || declared === 'linux') return declared;
  return detectFromNavigator();
}

/** 当前是否运行在 macOS 上（决定是否使用原生红绿灯标题栏等平台镀铬）。 */
export function isMacOS(): boolean {
  return detectPlatform() === 'macos';
}

/**
 * 平台主修饰键：macOS 只认 ⌘，Windows/Linux 只认 Ctrl。
 *
 * 用于「⌘+点击打开链接」这类有系统语义的操作。不能简单接受两者：macOS 上
 * Ctrl+点击 是系统右键，若同时当作打开链接，用户想呼出上下文菜单就会跳走。
 * 普通功能快捷键仍可写 `ctrlKey || metaKey`（两端都习惯），此处只约束手势。
 */
export function isPrimaryModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMacOS() ? event.metaKey : event.ctrlKey;
}

/**
 * macOS 原生应用菜单是否已接管加速键。
 *
 * 菜单构建成功后才写入 `data-native-menu="active"`（失败会清掉标记，窗口内菜单
 * 继续兜底）。原生菜单与窗口级监听处理同一组快捷键时，一次按键会走两条路径，
 * 因此窗口级处理器在标记存在时应让位。
 */
export function isNativeMenuActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.nativeMenu === 'active';
}
