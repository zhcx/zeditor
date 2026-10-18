import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { FONT_SIZE_RANGE_THUMB, getRangeMarkerGeometry } from '../../utils/appearanceSettings';
import { LINE_WIDTH_MAX, LINE_WIDTH_MIN, LINE_WIDTH_STEP, normalizeLineWidth } from '../../utils/editorDisplay';
import { createLineWidthPreview } from '../../utils/lineWidthPreview';
import { formatShortcut } from '../../utils/platformShortcuts';

/** 交互值保留在小组件内：滑块跟手，拖动不让整块设置面板或编辑器 React 树重渲染。 */
export function LineWidthSetting({ value, onCommit }: { value: number; onCommit: (width: number) => void }) {
  const [draft, setDraft] = useState({ saved: value, width: value });
  const committedRef = useRef(value);
  const previewRef = useRef<ReturnType<typeof createLineWidthPreview> | null>(null);
  if (draft.saved !== value) setDraft({ saved: value, width: value });

  useEffect(() => { committedRef.current = value; }, [value]);
  useEffect(() => () => {
    previewRef.current?.cancel();
  }, []);

  const begin = () => {
    previewRef.current ??= createLineWidthPreview();
    previewRef.current.begin();
  };
  const preview = (width: number) => {
    begin();
    setDraft(previous => ({ ...previous, width }));
    previewRef.current?.preview(width);
  };
  const commit = (width: number) => {
    previewRef.current?.commit(width);
    if (width === committedRef.current) return;
    committedRef.current = width;
    onCommit(width);
  };
  const geometry = getRangeMarkerGeometry(draft.width, LINE_WIDTH_MIN, LINE_WIDTH_MAX, FONT_SIZE_RANGE_THUMB);
  return (
    <div className="setting-item setting-range-item">
      <div className="setting-range-header">
        <div className="setting-copy">
          <span>行宽</span>
          <small>{formatShortcut('文档区域占编辑框宽度的比例，Ctrl + 鼠标滚轮可快速调整')}</small>
        </div>
        <output>{draft.width}%</output>
      </div>
      <input
        className="settings-range"
        type="range"
        min={LINE_WIDTH_MIN}
        max={LINE_WIDTH_MAX}
        step={LINE_WIDTH_STEP}
        value={draft.width}
        aria-label="行宽"
        aria-valuetext={`${draft.width}%`}
        style={{ '--range-progress': `${geometry.progressPercent}%`, '--range-thumb-size': `${FONT_SIZE_RANGE_THUMB}px` } as CSSProperties}
        onPointerDown={begin}
        onChange={event => preview(normalizeLineWidth(Number(event.currentTarget.value)))}
        onPointerUp={event => commit(Number(event.currentTarget.value))}
        onPointerCancel={event => commit(Number(event.currentTarget.value))}
        onKeyUp={event => { if (/^(Arrow|Home|End|Page)/.test(event.key)) commit(Number(event.currentTarget.value)); }}
        onBlur={event => commit(Number(event.currentTarget.value))}
      />
    </div>
  );
}
