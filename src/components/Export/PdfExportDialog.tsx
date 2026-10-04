import { AppIcon } from '../Icons/AppIcon';
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import MarkdownIt from 'markdown-it';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { applyExportTemplate, EXPORT_TEMPLATES, loadExportTemplate, saveExportTemplate, type ExportTemplate } from './exportTemplates';

interface ProgressEvent {
  stage: string;
  progress: number;
  message: string;
}

interface PdfExportOptionsBackend {
  page_format: 'A4' | 'A3' | 'Letter' | 'Legal';
  orientation: 'Portrait' | 'Landscape';
  margin_mm: number;
  include_header_footer: boolean;
}

interface PdfExportOptions {
  pageFormat: 'A4' | 'A3' | 'Letter' | 'Legal';
  orientation: 'Portrait' | 'Landscape';
  margin_mm: number;
  include_header_footer: boolean;
}

interface PdfExportDialogProps {
  content: string;
  filePath: string | null;
  onClose: () => void;
}

const defaultOptions: PdfExportOptions = {
  pageFormat: 'A4',
  orientation: 'Portrait',
  margin_mm: 20,
  include_header_footer: false,
};

const STEPS = [
  { id: 'init', label: '初始化' },
  { id: 'load', label: '加载' },
  { id: 'render', label: '渲染' },
  { id: 'generate', label: '生成' },
  { id: 'complete', label: '完成' },
];

export function PdfExportDialog({ content, filePath, onClose }: PdfExportDialogProps) {
  const [options, setOptions] = useState<PdfExportOptions>(defaultOptions);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [success, setSuccess] = useState(false);
  const [template, setTemplate] = useState<ExportTemplate>(loadExportTemplate);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen<ProgressEvent>('pdf-export-progress', (event) => {
        setProgress(event.payload);
        if (event.payload.stage === 'complete') {
          setSuccess(true);
        }
      });
    };

    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleExport = async () => {
    saveExportTemplate(template);
    setExporting(true);
    setError(null);
    setProgress({ stage: 'init', progress: 0, message: '准备导出...' });
    setSuccess(false);

    try {
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: true });
      const title = filePath?.split(/[\\/]/).pop()?.replace(/\.md$/i, '') || '文档';
      const htmlBody = applyExportTemplate(sanitizeRenderedHtml(md.render(content)), title, template);

      const defaultFilename = filePath
        ? filePath.split(/[\\/]/).pop()?.replace(/\.md$/i, '') || 'document'
        : 'document';

      const selected = await save({
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: defaultFilename + '.pdf',
      });

      if (!selected) {
        setExporting(false);
        setProgress(null);
        return;
      }

      const backendOptions: PdfExportOptionsBackend = {
        page_format: options.pageFormat,
        orientation: options.orientation,
        margin_mm: options.margin_mm,
        include_header_footer: options.include_header_footer || template.headerFooter,
      };

      await invoke<string>('export_pdf_direct', {
        htmlBody,
        outputPath: selected,
        settings: { pdf_margin: options.margin_mm, html_template: 'default' },
        options: backendOptions,
        filePath,
      });

      // Show success briefly before closing
      setTimeout(() => onClose(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }

    setExporting(false);
  };

  const getStepStatus = (stepId: string) => {
    if (!progress) return '';
    const currentIndex = STEPS.findIndex(s => s.id === progress.stage);
    const stepIndex = STEPS.findIndex(s => s.id === stepId);
    if (stepIndex < currentIndex) return 'completed';
    if (stepIndex === currentIndex) return 'active';
    return '';
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content pdf-export-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>导出 PDF</h2>
          <button className="modal-close" onClick={onClose} disabled={exporting} aria-label="关闭"><AppIcon name="close" size={16} /></button>
        </div>

        <div className="modal-body">
          {/* Progress Bar Section */}
          {exporting && progress && (
            <div className="pdf-progress-container">
              <div className="pdf-progress-header">
                <span className="pdf-progress-stage">正在导出</span>
                <span className="pdf-progress-percent">{progress.progress}%</span>
              </div>
              <div className="pdf-progress-bar-wrapper">
                <div
                  className="pdf-progress-bar-fill"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              <p className="pdf-progress-message">{progress.message}</p>

              {/* Step Indicators */}
              <div className="pdf-progress-steps">
                {STEPS.map(step => (
                  <div key={step.id} className={`pdf-step-indicator ${getStepStatus(step.id)}`}>
                    <div className="pdf-step-dot" />
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Success Icon */}
          {success && (
            <div className="pdf-success-icon">
              <AppIcon name="checkCircle" size={20}  />
            </div>
          )}

          {/* Options Section */}
          {!exporting && !success && (
            <div className="export-section">
              <label className="section-label">导出模板</label>
              <div className="option-row"><label>预设</label><select value={template.id} onChange={(event) => setTemplate({ ...EXPORT_TEMPLATES.find((item) => item.id === event.target.value)! })}>{EXPORT_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
              <div className="option-row"><label>字体</label><input value={template.font} onChange={(event) => setTemplate({ ...template, font: event.target.value })} /></div>
              <div className="option-row"><label>行距</label><input type="number" step="0.05" min="1" max="3" value={template.lineHeight} onChange={(event) => setTemplate({ ...template, lineHeight: Number(event.target.value) || 1.7 })} /></div>
              <div className="option-row"><label>水印</label><input value={template.watermark} placeholder="可选" onChange={(event) => setTemplate({ ...template, watermark: event.target.value })} /></div>
              <div className="option-row checkbox"><label><input type="checkbox" checked={template.toc} onChange={(event) => setTemplate({ ...template, toc: event.target.checked })} /> 包含目录</label><label><input type="checkbox" checked={template.cover} onChange={(event) => setTemplate({ ...template, cover: event.target.checked })} /> 包含封面</label></div>
              {template.id === 'custom' && <textarea className="export-template-css" value={template.customCss} placeholder="自定义 CSS" onChange={(event) => setTemplate({ ...template, customCss: event.target.value })} />}
              <label className="section-label">页面设置</label>
              <div className="option-row">
                <label>页面格式</label>
                <select
                  value={options.pageFormat}
                  onChange={e => setOptions({ ...options, pageFormat: e.target.value as PdfExportOptions['pageFormat'] })}
                  disabled={exporting}
                >
                  <option value="A4">A4</option>
                  <option value="A3">A3</option>
                  <option value="Letter">Letter</option>
                  <option value="Legal">Legal</option>
                </select>
              </div>
              <div className="option-row">
                <label>页面方向</label>
                <select
                  value={options.orientation}
                  onChange={e => setOptions({ ...options, orientation: e.target.value as PdfExportOptions['orientation'] })}
                  disabled={exporting}
                >
                  <option value="Portrait">纵向</option>
                  <option value="Landscape">横向</option>
                </select>
              </div>
              <div className="option-row">
                <label>页边距 (mm)</label>
                <input
                  type="number"
                  min="5"
                  max="50"
                  value={options.margin_mm}
                  onChange={e => setOptions({ ...options, margin_mm: parseInt(e.target.value) || 20 })}
                  disabled={exporting}
                />
              </div>
              <div className="option-row checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={options.include_header_footer}
                    onChange={e => setOptions({ ...options, include_header_footer: e.target.checked })}
                    disabled={exporting}
                  />
                  包含页眉页脚
                </label>
              </div>
            </div>
          )}

          {error && (
            <div className="export-error">
              <span>导出失败: {error}</span>
            </div>
          )}

          <div className="export-actions">
            <button className="export-btn primary" onClick={handleExport} disabled={exporting}>
              {exporting ? '正在导出...' : '导出'}
            </button>
            <button className="export-btn secondary" onClick={onClose} disabled={exporting}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
