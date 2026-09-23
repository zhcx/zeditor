import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IMAGE_FILE_EXTENSIONS } from '../src/utils/imageSyntax.ts';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('editor wires table parsing, navigation, floating toolbar and shortcuts', async () => {
  const editor = await read('../src/components/Editor/Editor.tsx');

  assert.match(editor, /import\s*\{[\s\S]*?navigateTableCell[\s\S]*?\}\s*from\s*'\.\.\/\.\.\/utils\/markdownTable'/);
  assert.match(editor, /parseTableAt\(value, selection\.to\)/);
  assert.match(editor, /navigateTableCell\(model\.getValue\(\), selection\.to, tableKey\)/);
  assert.match(editor, /applyTableAction\(controller\.getValue\(\), selection\.to, action\)/);
  assert.match(editor, /applyTableEdit\(insertRow\(model\.getValue\(\), selection\.to, 'below'\)\)/);
  assert.match(editor, /<TableToolbar/);
  assert.match(editor, /refreshTableToolbar\(\);/);
  // 快捷键、菜单与斜杠命令三个入口都用同一套 3 × 3 默认表格
  assert.match(editor, /command\.id === 'table'/);
  assert.match(editor, /slashCommandRunRef\.current\(command\)/);
  assert.ok((editor.match(/insertTableAtCursor\(3, 3\)/g) ?? []).length >= 2, '表格插入入口应复用同一模板');
  assert.match(editor, /window\.addEventListener\('zeditor-table-action', handleTableActionRequest\)/);
  assert.match(editor, /window\.addEventListener\('zeditor-insert-table', handleInsertTableRequest\)/);
  assert.match(editor, /setShowContextImageModal\(true\)/);
  // 粘贴图片优先落到 .assets
  assert.match(editor, /insertImageFromBytes\(dataUrl\.split\(','\)\[1\], extension, '粘贴的图片'\)/);
});

test('table toolbar exposes row, column, alignment and format actions', async () => {
  const toolbar = await read('../src/components/Editor/TableToolbar.tsx');

  for (const action of ['row-above', 'row-below', 'row-delete', 'column-left', 'column-right', 'column-delete', 'align-left', 'align-center', 'align-right', 'format', 'table-delete']) {
    assert.match(toolbar, new RegExp(`'${action}'`), `缺少表格动作 ${action}`);
  }
  assert.match(toolbar, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test('menu bar publishes table and image requests instead of touching the editor directly', async () => {
  const menuBar = await read('../src/components/MenuBar/MenuBar.tsx');

  assert.match(menuBar, /label: '插入图片…'/);
  assert.match(menuBar, /label: '插入表格'/);
  assert.match(menuBar, /Ctrl\+Shift\+T/);
  assert.match(menuBar, /label: '表格操作'/);
  assert.match(menuBar, /new CustomEvent\('zeditor-table-action', \{ detail: \{ action \} \}\)/);
  assert.match(menuBar, /new CustomEvent\(kind === 'table' \? 'zeditor-insert-table' : 'zeditor-insert-image'\)/);
});

test('toolbar inserts tables through the shared template and offers local image import', async () => {
  const toolbar = await read('../src/components/Toolbar/Toolbar.tsx');

  assert.match(toolbar, /buildTableInsert\(rows, columns\)/);
  assert.match(toolbar, /filters: imageDialogFilters\(\)/);
  assert.match(toolbar, /await insertImageFromPath\(selected, altText\.trim\(\) \|\| undefined\)/);
  assert.match(toolbar, /复制到文档同级的 \.assets 目录/);
});

test('toolbar keeps a single table entry merging quick insert and the size picker', async () => {
  const toolbar = await read('../src/components/Toolbar/Toolbar.tsx');
  const picker = await read('../src/components/Editor/TablePicker.tsx');

  // 工具栏只保留一个表格按钮：点击打开尺寸选择器，内部再提供默认 3 × 3 快捷插入。
  assert.equal((toolbar.match(/picker: true/g) ?? []).length, 1);
  assert.match(toolbar, /label: '表格', picker: true/);
  assert.doesNotMatch(toolbar, /toolbarGroups\[3\]\.buttons\.unshift/);
  assert.match(toolbar, /setTablePickerAnchor\(event\.currentTarget\)/);
  assert.match(toolbar, /anchor=\{tablePickerAnchor\}/);
  assert.match(toolbar, /onInsertDefault=\{\(\) => insertTable\(3, 3\)\}/);

  // 弹层挂到 body 并按其锚点元素测量，越界夹取、下方空间不足时翻转到上方
  assert.match(picker, /createPortal\(/);
  assert.match(picker, /anchor\.getBoundingClientRect\(\)/);
  assert.match(picker, /document\.body,/);
  assert.match(picker, /requestAnimationFrame\(updatePosition\)/);
  assert.match(picker, /Math\.min\(rect\.left, window\.innerWidth - width - 8\)/);
  assert.match(picker, /flipsUp = below \+ height > window\.innerHeight - 8/);
  assert.match(picker, /onInsertDefault/);
});

test('toolbar merges similar commands into dropdown menus and keeps only high-frequency buttons', async () => {
  const toolbar = await read('../src/components/Toolbar/Toolbar.tsx');
  const sliceBetween = (from: string, to: string) => {
    const start = toolbar.indexOf(from);
    const end = toolbar.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `${from} → ${to}`);
    return toolbar.slice(start, end);
  };
  // 直接按钮位于 8 空格缩进，菜单项缩进更深，用它区分两者。
  const countDirectButtons = (block: string) => (block.match(/\r?\n[ ]{8}\{/g) ?? []).length;

  // 直接按钮只保留高频动作：加粗 / 斜体 / 删除线 + 样式、标题、列表三个菜单
  const formatGroup = sliceBetween("title: '格式'", "title: '编辑'");
  assert.equal(countDirectButtons(formatGroup), 6);
  assert.equal((formatGroup.match(/menu: \[/g) ?? []).length, 3);
  for (const label of ["label: '加粗'", "label: '斜体'", "label: '删除线'", "label: '样式'", "label: '标题'", "label: '列表'"]) {
    assert.match(formatGroup, new RegExp(label), label);
  }
  // 图标、字母、符号混排会让工具栏显得杂乱，统一使用文字标签
  assert.doesNotMatch(formatGroup, /icon: '/);
  // 标题与列表的层级按钮收进菜单
  assert.match(formatGroup, /menu: \[[\s\S]*?\{ label: '一级标题'/);
  assert.match(formatGroup, /\{ label: '六级标题'/);
  assert.match(formatGroup, /menu: \[[\s\S]*?\{ label: '无序列表'/);

  const editGroup = sliceBetween("title: '编辑'", "title: '插入'");
  assert.equal(countDirectButtons(editGroup), 3);
  assert.match(editGroup, /label: '整理'/);
  assert.match(editGroup, /menu: \[[\s\S]*?\{ label: '检查并格式化 Markdown'/);

  const insertGroup = sliceBetween("title: '插入'", 'const toolbarButtons');
  assert.equal(countDirectButtons(insertGroup), 4);
  assert.match(insertGroup, /label: '表格', picker: true/);
  for (const label of ["label: '插入'", "label: '公式'", "label: '图表'"]) {
    assert.match(insertGroup, new RegExp(label), label);
  }
  assert.match(insertGroup, /menu: \[[\s\S]*?\{ label: 'Mermaid 流程图'/);
});

test('toolbar dropdown component positions itself, closes on Escape and supports keyboard navigation', async () => {
  const menu = await read('../src/components/Toolbar/ToolbarMenu.tsx');

  assert.match(menu, /createPortal\(/);
  assert.match(menu, /aria-haspopup="menu"/);
  assert.match(menu, /aria-expanded=\{open\}/);
  assert.match(menu, /requestAnimationFrame\(updatePosition\)/);
  assert.match(menu, /Math\.min\(rect\.left, window\.innerWidth - width - 8\)/);
  assert.match(menu, /event\.key === 'Escape'/);
  assert.match(menu, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
  assert.match(menu, /window\.addEventListener\('keydown', handleKeyDown, true\)/);
  assert.match(menu, /data-active=\{index === activeIndex\}/);
});

test('dropped images go through the asset pipeline like media files', async () => {
  const app = await read('../src/App.tsx');

  assert.match(app, /isImageFilePath\(path\)/);
  assert.match(app, /await insertImageFromPath\(path\)/);
});

test('preview resolves local images, renders sizes and hosts the image interactions', async () => {
  const preview = await read('../src/components/Preview/Preview.tsx');

  assert.match(preview, /md\.core\.ruler\.after\('inline', 'image_size_attributes'/);
  assert.match(preview, /resolveMediaSources\(currentFile, localImageSources\)/);
  assert.match(preview, /无法读取图片/);
  assert.match(preview, /enhanceTables\(container, currentFile\)/);
  assert.match(preview, /table-column-handle/);
  assert.match(preview, /<ImagePropertiesModal/);
  assert.match(preview, /className="preview-image-menu"/);
  assert.match(preview, /navigator\.clipboard\.writeText\(menuImage\.src\)/);
});

test('image asset service copies files or clipboard data into .assets before inserting syntax', async () => {
  const service = await read('../src/services/imageAssets.ts');

  assert.match(service, /invoke<ImageAssetImport>\('import_image_asset',\s*\{\s*sourcePath,\s*documentPath\s*\}\)/);
  assert.match(service, /invoke<ImageAssetImport>\('import_image_bytes',\s*\{\s*dataBase64,\s*extension,\s*documentPath\s*\}\)/);
  assert.match(service, /请先保存文档/);
  assert.match(service, /invalidateResolvedSource\(useAppStore\.getState\(\)\.currentFile, asset\.relativePath\)/);
  assert.match(service, /setUploadStatus\('error'/);
  assert.match(service, /formatImageMarkdown\(spec\)/);
});

test('desktop side whitelists image extensions and exposes both import commands', async () => {
  const commands = await read('../src-tauri/src/commands.rs');
  const main = await read('../src-tauri/src/main.rs');

  assert.match(commands, /const IMAGE_EXTENSIONS:\s*\[&str; 12\]/);
  assert.match(commands, /const MAX_IMAGE_BYTES:\s*u64 = 64 \* 1024 \* 1024/);
  assert.match(commands, /仅支持导入图片文件/);
  assert.match(commands, /fn reserve_asset_name/);
  assert.match(commands, /fn assets_target_dir/);
  assert.match(commands, /pub async fn import_image_asset/);
  assert.match(commands, /pub async fn import_image_bytes/);
  // 媒体导入复用同一套目录与命名逻辑，仍然保留原有提示文案
  assert.match(commands, /assets_target_dir\(&document_path, assets_dir, "媒体"\)/);
  assert.match(commands, /reserve_asset_name\(&target_dir, &safe_name, source_meta\.len\(\), "媒体"\)/);
  assert.match(commands, /仅支持导入视频或音频文件/);
  // 提示文案改为按 label 拼装，运行时仍然输出“同名媒体文件过多，请重命名后再导入”
  assert.match(commands, /format!\("同名\{label\}文件过多，请重命名后再导入"\)/);

  assert.match(main, /commands::import_image_asset/);
  assert.match(main, /commands::import_image_bytes/);

  // 前端文件选择器与后端白名单必须保持一致。
  const declared = commands.match(/const IMAGE_EXTENSIONS:\s*\[&str; 12\] = \[([\s\S]*?)\];/);
  assert.ok(declared, 'image extension whitelist');
  const rustExtensions = [...declared[1].matchAll(/"([a-z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...rustExtensions].sort(), [...IMAGE_FILE_EXTENSIONS].sort());
});
