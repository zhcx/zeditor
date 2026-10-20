import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
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
  for (const name of Object.keys(zip.files).filter(name => name.endsWith('.rels'))) {
    const root = name === '_rels/.rels' ? '' : posix.dirname(posix.dirname(name));
    const relationships = find(await xml(name), 'Relationship') as Record<string, string>[];
    assert.equal(new Set(relationships.map(value => value['@Id'])).size, relationships.length, `duplicate relationship ID in ${name}`);
    for (const relationship of relationships) {
      if (relationship['@TargetMode'] === 'External') continue;
      const target = relationship['@Target'];
      const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(root, target));
      assert.ok(zip.file(path), `unresolved relationship ${name} -> ${target}`);
    }
  }
  for (const name of Object.keys(zip.files).filter(name => name.endsWith('.xml'))) {
    const part = await xml(name);
    const references = ['@r:id', '@r:embed', '@r:link'].flatMap(key => find(part, key));
    if (!references.length) continue;
    const relName = posix.join(posix.dirname(name), '_rels', `${posix.basename(name)}.rels`);
    const ids = new Set((find(await xml(relName), 'Relationship') as Record<string, string>[]).map(value => value['@Id']));
    for (const id of references) assert.ok(ids.has(String(id)), `undefined relationship ID ${id} in ${name}`);
  }
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
  assert.equal(find(document, 'w:tblHeader').filter(value => !(value as Record<string, string>)['@w:val']).length, 1);
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

test('height-only image sizing retains aspect ratio and explicit width/height remain supported', async () => {
  const result = await createDocx('![仅高度](a.png){height=100}\n\n![仅宽度](a.png){width=300}\n\n![指定宽高](a.png){width=200 height=100}', {
    title: '图片尺寸', loadImage: async () => ({ data: png, type: 'png', width: 600, height: 200 }),
  });
  const { xml } = await unpack(result.base64);
  const extents = find(await xml('word/document.xml'), 'wp:extent') as Record<string, string>[];
  assert.deepEqual(extents.map(value => [Number(value['@cx']), Number(value['@cy'])]), [
    [300 * 9525, 100 * 9525], [300 * 9525, 100 * 9525], [200 * 9525, 100 * 9525],
  ]);
});

test('distinct images load with at most four workers while archive order and per-export deduplication remain stable', async () => {
  const source = Array.from({ length: 8 }, (_, index) => `![图${index}](image-${index}.png)`).join('\n\n')
    + '\n\n![再次引用](image-0.png)\n\n脚注[^图]\n\n[^图]: ![脚注图](footnote.png)';
  let active = 0;
  let peak = 0;
  const loaded: string[] = [];
  const loadImage = async (source: string) => {
    loaded.push(source);
    active += 1;
    peak = Math.max(peak, active);
    await setTimeout(source === 'image-0.png' ? 35 : 5);
    active -= 1;
    return { data: png, type: 'png' as const, width: 1, height: 1 };
  };
  const result = await createDocx(source, { title: '并行图片', loadImage });
  assert.equal(peak, 4);
  assert.equal(loaded.length, 9);
  assert.equal(new Set(loaded).size, 9);
  const { xml, zip } = await unpack(result.base64);
  const document = await xml('word/document.xml');
  const descriptions = find(document, 'wp:docPr') as Record<string, string>[];
  assert.deepEqual(descriptions.map(value => value['@descr']), [...Array.from({ length: 8 }, (_, index) => `图${index}`), '再次引用']);
  assert.equal(find(await xml('word/footnotes.xml'), 'w:drawing').length, 1);
  for (const file of Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('word/media/'))) assert.deepEqual(await file.async('uint8array'), png);
  await createDocx('![重新导出](image-0.png)', { title: '新读取', loadImage });
  assert.equal(loaded.filter(value => value === 'image-0.png').length, 2);
});

test('concurrent image failures reject export without unhandled rejections, including a synchronous loader error', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(createDocx('![首图](first.png)\n\n![损坏](second.png)\n\n![另一张损坏](third.png)', {
      title: '失败终止', loadImage: async source => {
        await setTimeout(source === 'first.png' ? 15 : 1);
        if (source !== 'first.png') throw new Error('图片损坏');
        return { data: png, type: 'png', width: 1, height: 1 };
      },
    }), /second\.png.*图片损坏/);
    await assert.rejects(createDocx('![同步失败](sync.png)', {
      title: '同步失败', loadImage: () => { throw new Error('同步读取失败'); },
    }), /sync\.png.*同步读取失败/);
    await setTimeout(20);
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

test('CJK escaping, separate nested list numbering and footnote names survive the OOXML package', async () => {
  const result = await createDocx('中文 & <符号>、"引号"、😀\n\n3. 外层甲\n   1. 内层甲\n   2. 内层乙\n4. 外层乙\n\n引用[^甲&乙]及[^第二]。\n\n[^甲&乙]: 脚注甲 & 😀\n\n[^第二]: 脚注乙 < 2', { title: '中文 & 转义' });
  const { xml } = await unpack(result.base64);
  const document = await xml('word/document.xml');
  // Use the shared Markdown typographer's displayed punctuation.
  assert.ok(texts(document).includes('中文 & <符号>、“引号”、😀'));
  const numbered = (find(document, 'w:p') as Record<string, unknown>[]).filter(value => find(value, 'w:numPr').length);
  assert.deepEqual(numbered.map(value => texts(value)), ['外层甲', '内层甲', '内层乙', '外层乙']);
  const ids = numbered.map(value => (find(value, 'w:numId')[0] as Record<string, string>)['@w:val']);
  assert.equal(ids[0], ids[3]);
  assert.equal(ids[1], ids[2]);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(find(document, 'w:footnoteReference').map(value => (value as Record<string, string>)['@w:id']), ['1', '2']);
  assert.ok(texts(await xml('word/footnotes.xml')).includes('脚注甲 & 😀'));
  assert.ok(texts(await xml('word/footnotes.xml')).includes('脚注乙 < 2'));
  assert.ok(!texts(document).includes('脚注甲'));
});
