// Apply the last selected theme before CSS and React can paint a frame.
// Desktop keeps this small mirror in WebView localStorage as well.
// 注：此脚本必须保持为独立外部文件——tauri.conf.json 的 CSP 不允许
// inline script，外置后无需 'unsafe-inline' 即可执行。
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('zeditor.browser.settings') || localStorage.getItem('markitdown.browser.settings') || 'null');
    const preference = saved?.appearance?.theme;
    const validThemes = ['vscode-light', 'vscode-dark'];
    const resolved = (preference) => {
      if (validThemes.includes(preference)) return preference;
      // 已下线主题按明暗迁移
      return String(preference).endsWith('-light') ? 'vscode-light' : 'vscode-dark';
    };
    const theme = preference === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vscode-dark' : 'vscode-light')
      : resolved(preference);
    const toFontStack = (fontFamily) => {
      const family = typeof fontFamily === 'string'
        ? fontFamily.replace(/[;{}]/g, '').trim()
        : '';
      return `${family || 'Microsoft YaHei'}, "Microsoft YaHei", sans-serif`;
    };
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme.endsWith('-dark') ? 'dark' : 'light';
    document.documentElement.style.setProperty('--font-sans', toFontStack(saved?.appearance?.ui_font_family));
    document.documentElement.style.setProperty('--font-content', toFontStack(saved?.appearance?.font_family));
    const clamp = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    const uiSize = clamp(saved?.appearance?.ui_font_size, 13, 11, 20);
    document.documentElement.style.setProperty('--ui-font-scale', String(uiSize / 13));
    document.documentElement.style.setProperty('--ui-font-base-size', `${uiSize}px`);
    document.documentElement.style.setProperty('--text-letter-spacing', `${clamp(saved?.appearance?.letter_spacing, 0.6, 0, 5)}px`);
  } catch { /* Use the stylesheet default when cached data is unavailable. */ }
})();
