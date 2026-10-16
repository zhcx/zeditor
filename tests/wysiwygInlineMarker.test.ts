import { it } from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_MARKER_TAGS, matchInlineMarker } from '../src/utils/wysiwyg/inlineMarkers.ts';
import { serializeInlineNodes } from '../src/utils/wysiwyg/inlineSerialize.ts';
import { elementNode, textNode } from '../src/utils/wysiwyg/inlineNodes.ts';

it('matches a closed marker pair right at the caret', () => {
  assert.deepEqual(matchInlineMarker('**粗体**', 6), { kind: 'strong', from: 0, to: 6, content: '粗体' });
  assert.deepEqual(matchInlineMarker('*斜体*', 4), { kind: 'em', from: 0, to: 4, content: '斜体' });
  assert.deepEqual(matchInlineMarker('~~删除~~', 6), { kind: 'del', from: 0, to: 6, content: '删除' });
  assert.deepEqual(matchInlineMarker('`代码`', 4), { kind: 'code', from: 0, to: 4, content: '代码' });
  // 前面有正文时只替换标记区间，不影响别的字符。
  assert.deepEqual(matchInlineMarker('前**粗**', 6), { kind: 'strong', from: 1, to: 6, content: '粗' });
  assert.deepEqual(matchInlineMarker('中文 *斜*', 6), { kind: 'em', from: 3, to: 6, content: '斜' });
});

it('only fires when the closing marker sits exactly at the caret', () => {
  // 光标停在标记中间时不触发，否则会把还没打完的内容提前成元素。
  assert.equal(matchInlineMarker('**粗体**', 4), null);
  assert.equal(matchInlineMarker('**粗体**', 2), null);
  assert.equal(matchInlineMarker('**粗体**', 0), null);
  // 光标越过闭合标记（后面还有字）也不触发：那是普通移动光标，不该改写已有文本。
  assert.equal(matchInlineMarker('**粗体**后', 7), null);
});

it('never fires while a longer marker is still being typed', () => {
  // 这是最容易踩的坑：打 `**粗体**` 时第 5 个字符停在 `**粗体*`，
  // 若此时按单 `*` 收尾就会先把「粗体」变成斜体，整段再也拼不出粗体。
  assert.equal(matchInlineMarker('**粗体*', 5), null);
  assert.equal(matchInlineMarker('**粗', 3), null);
  assert.equal(matchInlineMarker('*', 1), null);
  assert.equal(matchInlineMarker('**', 2), null);
  // 三个星号同理：`***粗***` 不应被拆成半截。
  assert.equal(matchInlineMarker('***粗*', 5), null);
  assert.equal(matchInlineMarker('***粗**', 6), null);
});

it('refuses content that markdown would not render as emphasis', () => {
  // 空内容、首尾空白都不是强调（`* 斜 *` 是字面量）。
  assert.equal(matchInlineMarker('**', 2), null);
  assert.equal(matchInlineMarker('****', 4), null);
  assert.equal(matchInlineMarker('* 斜*', 4), null);
  assert.equal(matchInlineMarker('*斜 *', 4), null);
  // 内容里还留着标记字符说明是嵌套写法，只转换一半会留下半截字面量。
  assert.equal(matchInlineMarker('**a*b**', 7), null);
  assert.equal(matchInlineMarker('**a**b**', 8), null);
  // 行内代码里不能再套反引号。
  assert.equal(matchInlineMarker('`a`b`', 5), null);
});

it('accepts underscore emphasis only at boundaries confirmed by the renderer', () => {
  assert.deepEqual(matchInlineMarker('_斜体_', 4), { kind: 'em', from: 0, to: 4, content: '斜体' });
  assert.deepEqual(matchInlineMarker('__粗体__', 6), { kind: 'strong', from: 0, to: 6, content: '粗体' });
  assert.equal(matchInlineMarker('文件_名称_', 6), null);
  assert.equal(matchInlineMarker('a__name__', 9), null);
  assert.equal(matchInlineMarker('\\_name_', 7), null);
});

it('recognizes complete triple emphasis without converting partially closed markers', () => {
  for (const source of ['***粗斜***', '___粗斜___']) {
    assert.deepEqual(matchInlineMarker(source, source.length), { kind: 'strong-em', from: 0, to: source.length, content: '粗斜' });
    assert.equal(matchInlineMarker(source.slice(0, -1), source.length - 1), null);
  }
});

it('serializes a converted marker back to the source the user typed', () => {
  // 这里是「输入即渲染」安全的根据：转换出来的 DOM 必须回写成同一段标记，
  // 否则源码与所见会分叉。逐种标记验证往返。
  const roundTrip = (kind: string, content: string) => {
    const node = elementNode(INLINE_MARKER_TAGS[kind as keyof typeof INLINE_MARKER_TAGS], {}, [textNode(content)]);
    return serializeInlineNodes([node], {});
  };
  assert.equal(roundTrip('strong', '粗体'), '**粗体**');
  assert.equal(roundTrip('em', '斜体'), '*斜体*');
  assert.equal(roundTrip('del', '删除'), '~~删除~~');
  assert.equal(roundTrip('code', '代码'), '`代码`');
});

it('would otherwise write the marker as escaped literal text', () => {
  // 对照：不转换时字面 `**粗体**` 会被转义写回，这就是必须接管的原因。
  const literal = serializeInlineNodes([textNode('**粗体**')], {});
  assert.equal(literal, '\\*\\*粗体\\*\\*');
});
