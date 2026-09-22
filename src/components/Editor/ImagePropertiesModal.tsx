import { useState } from 'react';
import { normalizeImageSize, type ImageSpec } from '../../utils/imageSyntax';

interface ImagePropertiesModalProps {
  spec: ImageSpec;
  onApply: (spec: ImageSpec) => void;
  onClose: () => void;
}

const SIZE_PRESETS: { label: string; width?: number }[] = [
  { label: '原始尺寸', width: undefined },
  { label: '小 (240px)', width: 240 },
  { label: '中 (420px)', width: 420 },
  { label: '大 (640px)', width: 640 },
];

/** 图片属性编辑：源路径、替代文本、标题与显示尺寸。 */
export function ImagePropertiesModal({ spec, onApply, onClose }: ImagePropertiesModalProps) {
  const [src, setSrc] = useState(spec.src);
  const [alt, setAlt] = useState(spec.alt);
  const [title, setTitle] = useState(spec.title ?? '');
  const [width, setWidth] = useState(spec.width ? String(spec.width) : '');
  const [height, setHeight] = useState(spec.height ? String(spec.height) : '');

  const submit = () => {
    const nextWidth = normalizeImageSize(width);
    const nextHeight = normalizeImageSize(height);
    onApply({
      src: src.trim(),
      alt,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(nextWidth ? { width: nextWidth } : {}),
      ...(nextHeight ? { height: nextHeight } : {}),
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content image-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>图片属性</h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <div className="link-form">
            <div className="form-field">
              <label>图片路径</label>
              <input type="text" value={src} onChange={(event) => setSrc(event.target.value)} placeholder=".assets/图片.png 或 https://..." />
            </div>
            <div className="form-field">
              <label>替代文本</label>
              <input type="text" value={alt} onChange={(event) => setAlt(event.target.value)} placeholder="图片描述" />
            </div>
            <div className="form-field">
              <label>标题（可选）</label>
              <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="鼠标悬停时显示" />
            </div>
            <div className="form-field image-size-field">
              <label>显示尺寸</label>
              <div className="image-size-inputs">
                <input type="number" min={1} value={width} onChange={(event) => setWidth(event.target.value)} placeholder="宽度" aria-label="宽度" />
                <span className="image-size-separator">×</span>
                <input type="number" min={1} value={height} onChange={(event) => setHeight(event.target.value)} placeholder="高度" aria-label="高度" />
              </div>
              <div className="image-size-presets">
                {SIZE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="image-size-preset"
                    onClick={() => {
                      setWidth(preset.width ? String(preset.width) : '');
                      setHeight('');
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-actions">
              <button className="cancel-btn" onClick={onClose}>取消</button>
              <button className="save-btn" onClick={submit} disabled={!src.trim()}>保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
