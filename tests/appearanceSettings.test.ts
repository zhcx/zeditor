import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function loadAppearanceSettings() {
  try {
    return await import('../src/utils/appearanceSettings.ts');
  } catch {
    return {};
  }
}

test('uses 1.4 as the default content line height', async () => {
  const settings = await loadAppearanceSettings();

  assert.equal(settings.DEFAULT_LINE_HEIGHT, 1.4);
});

test('aligns the default font label with the 14px range thumb center', async () => {
  const settings = await loadAppearanceSettings();
  const geometry = settings.getRangeMarkerGeometry?.(14, 12, 32, 18);

  assert.deepEqual(geometry, {
    progressPercent: 10,
    thumbOffsetPx: 7.2,
  });

  const trackWidth = 1000;
  const thumbCenter = 18 / 2 + 0.1 * (trackWidth - 18);
  const markerPosition = trackWidth * 0.1 + geometry.thumbOffsetPx;
  assert.equal(markerPosition, thumbCenter);
});

test('removes the retired Inkwell themes from settings, menus, and styles', () => {
  const paths = [
    'index.html',
    'src/App.tsx',
    'src/components/MenuBar/MenuBar.tsx',
    'src/components/Settings/SettingsPanel.tsx',
    'src/i18n/index.ts',
    'src/styles/main.css',
  ];
  const sources = paths.map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /inkwell/i);
});

test('editor and preview font sizes update before settings persistence', () => {
  const settingsPanel = readFileSync(new URL('../src/components/Settings/SettingsPanel.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');
  const preview = readFileSync(new URL('../src/components/Preview/Preview.tsx', import.meta.url), 'utf8');

  assert.match(settingsPanel, /document\.documentElement\.style\.setProperty\('--font-content-size', `\$\{fontSize\}px`\)/);
  assert.match(settingsPanel, /zeditor-content-font-size-preview/);
  assert.match(settingsPanel, /previewContentFontSize\(fontSize\)/);
  assert.match(settingsPanel, /previewContentFontSize\(settings\.appearance\.font_size, settings\.appearance\.font_family\)/);
  assert.match(settingsPanel, /setSettingsOpen\(false\);[\s\S]*window\.setTimeout\(\(\) => void saveSettings\(saveData\), 0\)/);
  assert.match(editor, /addEventListener\('zeditor-content-font-size-preview', handleFontSizePreview\)/);
  assert.match(editor, /fontSize,[\s\S]*lineHeight: Math\.round\(fontSize \* settings\.appearance\.line_height\)/);
  assert.match(preview, /fontSize: 'var\(--font-content-size\)'/);
});
