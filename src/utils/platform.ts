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
