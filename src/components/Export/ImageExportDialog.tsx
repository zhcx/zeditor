import { AppIcon } from '../Icons/AppIcon';
import { useEffect, useMemo, useState } from 'react';
import { applyExportTemplate, EXPORT_TEMPLATES, loadExportTemplate, saveExportTemplate, type ExportTemplate } from './exportTemplates';
import { renderMarkdownToHtml } from '../../utils/markdownPipeline';
import { enhanceExportHtml, isExportDiagramRequestReady, type ExportDiagramRequest } from '../../utils/exportDiagrams';
import { useAppStore } from '../../stores/appStore';
import { resolveThemePreference } from '../../themes/apply';

type ImageRatio = 'square' | 'landscape' | 'wide' | 'portrait' | 'a4';

interface ImageExportDialogProps {
  content: string;
  onClose: () => void;
}

const formats: Array<{ id: ImageRatio; label: string; ratio: number; hint: string }> = [
  { id: 'square', label: '1 : 1', ratio: 1, hint: '社交媒体 / 卡片' },
  { id: 'landscape', label: '4 : 3', ratio: 4 / 3, hint: '演示文稿 / 平板' },
  { id: 'wide', label: '16 : 9', ratio: 16 / 9, hint: '宽屏 / 视频封面' },
  { id: 'portrait', label: '9 : 16', ratio: 9 / 16, hint: '手机长图 / 故事' },
  { id: 'a4', label: 'A4', ratio: 210 / 297, hint: '打印 / 文档' },
];

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ImageExportDialog({ content, onClose }: ImageExportDialogProps) {
  const [selected, setSelected] = useState<ImageRatio>('square');
  const [exporting, setExporting] = useState(false);
  const [template, setTemplate] = useState<ExportTemplate>(loadExportTemplate);
  const current = formats.find((format) => format.id === selected) || formats[0];
  const settings = useAppStore(state => state.settings);
  const source = content || '暂无内容';
  const theme = resolveThemePreference(settings.appearance.theme);
  const workflowViewerEnabled = settings.workflow?.render_in_preview !== false;
  const diagramRequest = useMemo<ExportDiagramRequest>(() => ({ source, theme, workflowViewerEnabled }), [source, theme, workflowViewerEnabled]);
  // 长图通过 SVG foreignObject 一次性光栅化：图表先转成 PNG 数据地址，
  // 避免嵌套 SVG（Markmap 还带 foreignObject）在绘制时丢图。
  const [renderedHtml, setRenderedHtml] = useState(() => renderMarkdownToHtml(source));
  const [diagramWarnings, setDiagramWarnings] = useState<string[]>([]);
  const [renderedDiagramRequest, setRenderedDiagramRequest] = useState<ExportDiagramRequest | null>(null);
  const diagramsReady = isExportDiagramRequestReady(renderedDiagramRequest, diagramRequest);

  useEffect(() => {
    let cancelled = false;
    const background = getComputedStyle(document.documentElement).getPropertyValue('--bg-document').trim() || '#fffdf8';
    void enhanceExportHtml(renderMarkdownToHtml(diagramRequest.source), {
      mode: 'image',
      theme: diagramRequest.theme,
      background,
      workflowViewerEnabled: diagramRequest.workflowViewerEnabled,
    }).then((result) => {
      if (cancelled) return;
      setRenderedHtml(result.html);
      setDiagramWarnings(result.warnings);
      setRenderedDiagramRequest(diagramRequest);
    }).catch(() => {
      if (!cancelled) {
        setRenderedHtml(renderMarkdownToHtml(diagramRequest.source));
        setDiagramWarnings([]);
        setRenderedDiagramRequest(diagramRequest);
      }
    });
    return () => { cancelled = true; };
  }, [diagramRequest]);

  const handleExport = async () => {
    if (!diagramsReady || exporting) return;
    saveExportTemplate(template);
    setExporting(true);
    const scale = 2;
    const width = current.id === 'a4' ? 794 : 1200;
    const height = Math.round(width / current.ratio);
    const background = getComputedStyle(document.documentElement).getPropertyValue('--bg-document').trim() || '#fffdf8';
    const foreground = getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || '#242321';
    const themedHtml = applyExportTemplate(renderedHtml, 'Zeditor', template);
    // foreignObject 内部必须是良构 XHTML：Markdown 生成的 `<img>` / `<br>` 不是
    // 自闭合标签，直接拼进 SVG 会让整张图无法解码。先交给 XMLSerializer。
    const container = document.createElement('div');
    container.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    container.setAttribute('style', `box-sizing:border-box;width:100%;height:100%;padding:${Math.round(width * 0.04)}px;background:${background};color:${foreground};font-size:${Math.max(18, Math.round(width / 48))}px;overflow:hidden`);
    container.innerHTML = `<style>img{max-width:100%}</style>${themedHtml}`;
    const xhtml = new XMLSerializer().serializeToString(container);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `zeditor-${current.label.replace(/\s/g, '')}.png`);
        setExporting(false);
        onClose();
      }, 'image/png');
    };
    image.onerror = () => setExporting(false);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal-content image-export-modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header"><div><h2>导出为图片</h2><p className="export-modal-subtitle">选择适合内容的画布比例</p></div><button className="modal-close" onClick={onClose} aria-label="关闭"><AppIcon name="close" size={16} /></button></div>
      <div className="modal-body image-export-body">
        <div className="option-row"><label>导出模板</label><select value={template.id} onChange={(event) => setTemplate({ ...EXPORT_TEMPLATES.find((item) => item.id === event.target.value)! })}>{EXPORT_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
        <div className="image-format-grid">
          {formats.map((format) => <button key={format.id} className={`image-format-option ${selected === format.id ? 'selected' : ''}`} onClick={() => setSelected(format.id)}>
            <span className="image-format-preview" style={{ aspectRatio: format.ratio }}><span className="preview-lines" /></span>
            <strong>{format.label}</strong><small>{format.hint}</small>
          </button>)}
        </div>
        <div className="image-export-preview-wrap"><span className="image-export-preview-label">预览</span><div className="image-export-preview" style={{ aspectRatio: current.ratio }}><div dangerouslySetInnerHTML={{ __html: renderedHtml }} /></div></div>
        {diagramWarnings.length > 0 && <p style={{ margin: '8px 0 0', color: 'var(--warning-color, #b45309)', fontSize: 12, lineHeight: 1.6 }}>{diagramWarnings.join('；')}</p>}
      </div>
      <div className="form-actions image-export-actions"><button className="cancel-btn" onClick={onClose}>取消</button><button className="save-btn" onClick={handleExport} disabled={exporting || !diagramsReady}>{exporting ? '正在生成...' : diagramsReady ? '导出 PNG' : '正在准备图表...'}</button></div>
    </div>
  </div>;
}
