import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createDocx } from '../src/utils/docxExport.ts';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', trimValues: false });
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=', 'base64'));
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const texts = (xml: unknown) => find(xml, 'w:t').map(value => typeof value === 'object' ? (value as Record<string, unknown>)['#text'] : value).join('');

function find(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const result: unknown[] = [];
  for (const [name, item] of Object.entries(value)) {
    if (name === key) result.push(...asArray(item));
    result.push(...find(item, key));
  }
  return result;
}

async function unpack(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'must be a real ZIP, not HTML renamed to .docx');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const xml = async (name: string) => {
    const entry = zip.file(name);
    assert.ok(entry, `missing OOXML part ${name}`);
    const value = await entry.async('string');
    assert.equal(XMLValidator.validate(value), true, `invalid XML in ${name}`);
    return parser.parse(value);
  };
  // Validate all XML entries, not just the body being asserted below.
  for (const name of Object.keys(zip.files).filter(name => name.endsWith('.xml') || name.endsWith('.rels'))) await xml(name);
  return { zip, xml, bytes };
}

test('native DOCX archive has editable CJK text, styles, lists, tables, links and embedded image relationships', async () => {
  const loaded: string[] = [];
  const result = await createDocx(`# 中文报告\n\n正文 **重点**，*强调* 和 ~~删除~~、\`code\`。\n\n[官方链接](https://example.com/report?q=1&lang=zh)\n\n3. 第一项\n4. 第二项\n   - 子项目\n\n- [x] 已完成\n- [ ] 待处理\n\n| 名称 | 数量 |\n| :-- | --: |\n| 附件 | 2 |\n\n![示例图片](.assets/中文.png){width=320 height=200}\n`, {
    title: '中文报告', font: 'SimSun, serif',
    loadImage: async source => { loaded.push(source); return { data: png, type: 'png', width: 1, height: 1 }; },
  });
  assert.deepEqual(loaded, ['.assets/%E4%B8%AD%E6%96%87.png']);
  const { zip, xml } = await unpack(result.base64);
  const types = await xml('[Content_Types].xml');
  assert.ok(find(types, 'Override').some((item: Record<string, string>) => item['@ContentType'] === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'));
  const document = await xml('word/document.xml');
  const text = find(document, 'w:t').map(value => typeof value === 'object' ? (value as Record<string, unknown>)['#text'] : value).join('');
  assert.ok(text.includes('中文报告') && text.includes('正文') && text.includes('重点'));
  assert.ok(text.includes('☑ ') && text.includes('☐ '));
  assert.equal(find(document, 'w:tbl').length, 1);
  assert.equal(find(document, 'w:tr').length, 2);
  assert.equal(find(document, 'w:tc').length, 4);
  assert.equal(find(document, 'w:hyperlink').length, 1);
  assert.equal(find(document, 'w:drawing').length, 1);
  assert.ok(find(document, 'w:pStyle').some((value: Record<string, string>) => value['@w:val'] === 'Heading1'));
  assert.ok(find(document, 'w:numPr').length >= 5);
  const numbering = await xml('word/numbering.xml');
  assert.ok(find(numbering, 'w:start').some((value: Record<string, string>) => value['@w:val'] === '3'));
  const styles = await xml('word/styles.xml');
  assert.ok(find(styles, 'w:rFonts').some((value: Record<string, string>) => value['@w:eastAsia'] === 'SimSun'));
  const relationships = await xml('word/_rels/document.xml.rels');
  const rels = find(relationships, 'Relationship') as Record<string, string>[];
  assert.ok(rels.some(value => value['@Target'] === 'https://example.com/report?q=1&lang=zh' && value['@TargetMode'] === 'External'));
  const imageRel = rels.find(value => value['@Type'].endsWith('/image'));
  assert.ok(imageRel);
  assert.deepEqual(new Uint8Array(await zip.file(`word/${imageRel['@Target']}`)!.async('uint8array')), png);
  await mkdir('test-output/docx-export', { recursive: true });
  await writeFile('test-output/docx-export/中文报告.docx', Buffer.from(result.base64, 'base64'));
});

test('native footnotes, TOC, page breaks and page number fields are connected OOXML parts', async () => {
  const result = await createDocx('# 报告\n\n正文[^来源]，再次引用[^来源]。\n\n[^来源]: 可编辑的 **来源说明**。\n    第二行。\n', {
    title: '带脚注的报告', toc: true, cover: true, headerFooter: true, titleNumbering: true,
  });
  const { xml, bytes } = await unpack(result.base64);
  const document = await xml('word/document.xml');
  assert.equal(find(document, 'w:footnoteReference').length, 2);
  assert.ok(find(document, 'w:footnoteReference').every((value: Record<string, string>) => value['@w:id'] === '1'));
  assert.ok(find(document, 'w:instrText').some(value => JSON.stringify(value).includes('TOC')));
  assert.equal(find(document, 'w:br').filter((value: Record<string, string>) => value['@w:type'] === 'page').length, 2);
  const footnotes = await xml('word/footnotes.xml');
  assert.ok(texts(footnotes).includes('来源说明'));
  assert.ok(!texts(document).includes('来源说明'));
  const footer = await xml('word/footer1.xml');
  assert.ok(find(footer, 'w:instrText').some(value => JSON.stringify(value).includes('PAGE')));
  assert.ok(find(footer, 'w:instrText').some(value => JSON.stringify(value).includes('NUMPAGES')));
  assert.equal(find(await xml('word/settings.xml'), 'w:updateFields').length, 1);
  await writeFile('test-output/docx-export/目录脚注与页码.docx', bytes);
});

test('unsupported formula and diagram output is readable and explicitly reported', async () => {
  const result = await createDocx('公式 $E=mc^2$、\\(a_{i} + \\alpha\\)。\n\n$$\\frac{a}{b}$$\n\n```mermaid\ngraph TD\n A --> B\n```\n\n<script>not executed</script>\n', { title: '回退行为', customCss: 'body{color:red}' });
  const { xml } = await unpack(result.base64);
  const text = texts(await xml('word/document.xml'));
  assert.ok(text.includes('$E=mc^2$') && text.includes('A --> B'));
  assert.ok(text.includes('\\(a_{i} + \\alpha\\)') && text.includes('$$\\frac{a}{b}$$'));
  assert.ok(result.warnings.some(warning => warning.includes('TeX')));
  assert.ok(result.warnings.some(warning => warning.includes('源码')));
  assert.ok(result.warnings.some(warning => warning.includes('HTML')));
  assert.ok(result.warnings.some(warning => warning.includes('CSS')));
});

test('failed images abort the export and HTML/code do not trigger arbitrary local reads', async () => {
  await assert.rejects(createDocx('![附件](.assets/missing.png)', { title: '失败', loadImage: async () => { throw new Error('文件不存在'); } }), /missing\.png.*文件不存在/);
  await assert.rejects(createDocx('![附件](.assets/a.png)', { title: '未配置' }), /未配置图片读取器/);
  const loaded: string[] = [];
  await createDocx('```md\n![x](secret.png)\n```\n\n<img src="secret.png">\n\n[文件](secret.png)', {
    title: '安全读取', loadImage: async source => { loaded.push(source); return { data: png, type: 'png', width: 1, height: 1 }; },
  });
  assert.deepEqual(loaded, []);
});

test('media promoted from image syntax preserves its address without trying to read a video as an image', async () => {
  const result = await createDocx('![演示录像](.assets/demo.mp4)\n\n@[youtube](https://youtu.be/abc12345678)', {
    title: '媒体回退', loadImage: async () => { throw new Error('should not read media'); },
  });
  const { xml } = await unpack(result.base64);
  assert.ok(texts(await xml('word/document.xml')).includes('.assets/demo.mp4'));
  assert.ok(result.warnings.some(value => value.includes('音视频')));
});

test('fenced diagrams are embedded as images when a renderer is provided', async () => {
  const calls: string[] = [];
  const source = [
    '# 图表',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
    '```yaml',
    'name: ci',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '```',
    '',
    '```yaml',
    'name: just-data',
    'values:',
    '  - 1',
    '```',
    '',
  ].join('\n');
  const result = await createDocx(source, {
    title: '图表',
    loadDiagram: async (language, diagramSource) => {
      calls.push(`${language}:${diagramSource.includes('runs-on')}`);
      if (language === 'yaml' && !diagramSource.includes('runs-on')) return null;
      return { data: png, type: 'png', width: 40, height: 20 };
    },
  });
  // 普通 YAML 不应被当成图表；工作流与 Mermaid 各写一张图片。
  assert.deepEqual(calls, ['mermaid:false', 'yaml:true', 'yaml:false']);
  const { xml } = await unpack(result.base64);
  const document = await xml('word/document.xml');
  assert.equal(find(document, 'w:drawing').length, 2);
  const text = texts(document);
  assert.ok(!text.includes('A --> B'), 'rendered diagrams must not duplicate their source');
  assert.ok(text.includes('just-data') && text.includes('values'));
  assert.deepEqual(result.warnings.filter(warning => warning.includes('图表')), []);
});

test('failed diagram rendering keeps the source and reports the reason', async () => {
  const failed = await createDocx('```mermaid\ngraph TD\n  A --> B\n```\n', {
    title: '图表失败',
    loadDiagram: async () => { throw new Error('渲染器不可用'); },
  });
  const failedParts = await unpack(failed.base64);
  assert.ok(texts(await failedParts.xml('word/document.xml')).includes('A --> B'));
  assert.ok(failed.warnings.some(warning => warning.includes('渲染器不可用')));

  const empty = await createDocx('```mermaid\ngraph TD\n  A --> B\n```\n', {
    title: '图表为空',
    loadDiagram: async () => null,
  });
  assert.ok(empty.warnings.some(warning => warning.includes('图表未能转换为图片')));
});
