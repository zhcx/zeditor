import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/appStore';
import {
  type PdfAnnotationSidecarV1,
  type PdfAreaHighlight,
} from '../../utils/pdfAnnotations';

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'annotation-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function PdfReaderPanel() {
  const { pdfReaderPath, closePdfReader } = useAppStore();
  const [dataUrl, setDataUrl] = useState('');
  const [sidecar, setSidecar] = useState<PdfAnnotationSidecarV1 | null>(null);
  const [page, setPage] = useState(1);
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [color, setColor] = useState('#f0c64b');
  const [coordinates, setCoordinates] = useState({ x: 0.08, y: 0.12, width: 0.84, height: 0.12 });
  const [status, setStatus] = useState('');
  const [sourceChanged, setSourceChanged] = useState(false);

  useEffect(() => {
    if (!pdfReaderPath) return;
    let disposed = false;
    const resetTimer = window.setTimeout(() => {
      setDataUrl('');
      setSidecar(null);
      setStatus('正在打开 PDF…');
    }, 0);
    void (async () => {
      try {
        if (!('__TAURI_INTERNALS__' in window)) throw new Error('PDF 阅读器需要桌面运行时');
        const [url, result] = await Promise.all([
          invoke<string>('read_file_base64', { path: pdfReaderPath }),
          invoke<{ sidecar: PdfAnnotationSidecarV1; sourceChanged: boolean }>('load_pdf_annotations', { pdfPath: pdfReaderPath }),
        ]);
        if (disposed) return;
        setDataUrl(url);
        setSidecar(result.sidecar);
        setSourceChanged(result.sourceChanged);
        setStatus(result.sourceChanged ? 'PDF 已变化，现有批注只读' : '已加载 PDF 批注');
      } catch (error) {
        if (!disposed) setStatus(String(error));
      }
    })();
    return () => { disposed = true; window.clearTimeout(resetTimer); };
  }, [pdfReaderPath]);

  const visibleHighlights = useMemo(
    () => sidecar?.areaHighlights.filter((highlight) => highlight.page === page) || [],
    [page, sidecar],
  );

  if (!pdfReaderPath) return null;

  const addHighlight = () => {
    if (!sidecar || sourceChanged) return;
    const highlight: PdfAreaHighlight = {
      id: createId(),
      page,
      ...coordinates,
      title: title.trim() || 'PDF highlight',
      comment: comment.trim(),
      color,
      layerId: sidecar.activeLayerId,
    };
    setSidecar({ ...sidecar, areaHighlights: [...sidecar.areaHighlights, highlight] });
    setTitle('');
    setComment('');
    setStatus('批注已添加，点击保存写入 sidecar');
  };

  const saveAnnotations = async () => {
    if (!sidecar || sourceChanged) return;
    try {
      await invoke('save_pdf_annotations', { pdfPath: pdfReaderPath, sidecar });
      setStatus('批注已保存');
    } catch (error) {
      setStatus(String(error));
    }
  };

  const addLayer = () => {
    if (!sidecar || sourceChanged) return;
    const id = createId();
    setSidecar({
      ...sidecar,
      activeLayerId: id,
      layers: [...sidecar.layers, { id, name: 'Layer ' + (sidecar.layers.length + 1), visible: true }],
    });
  };

  const removeHighlight = (id: string) => {
    if (!sidecar || sourceChanged) return;
    setSidecar({ ...sidecar, areaHighlights: sidecar.areaHighlights.filter((highlight) => highlight.id !== id) });
  };

  const iframeSource = dataUrl ? dataUrl + '#page=' + page : '';

  return (
    <div className="pdf-reader-overlay" role="dialog" aria-modal="true" aria-label="PDF 阅读器">
      <div className="pdf-reader-shell">
        <header className="pdf-reader-header">
          <div>
            <strong>{fileName(pdfReaderPath)}</strong>
            <small>{status}</small>
          </div>
          <div className="pdf-reader-header-actions">
            <button type="button" onClick={() => void saveAnnotations()} disabled={!sidecar || sourceChanged}>保存批注</button>
            <button type="button" onClick={closePdfReader} aria-label="关闭 PDF 阅读器">关闭</button>
          </div>
        </header>
        <div className="pdf-reader-content">
          <main className="pdf-reader-document">
            {iframeSource ? <iframe key={iframeSource} src={iframeSource} title={fileName(pdfReaderPath)} /> : <div className="pdf-reader-loading">{status}</div>}
          </main>
          <aside className="pdf-reader-sidebar">
            <section className="pdf-reader-section">
              <label>页码<input type="number" min={1} value={page} onChange={(event) => setPage(Math.max(1, Number(event.currentTarget.value) || 1))} /></label>
              <div className="pdf-reader-tool-row">
                <button type="button" className="active">区域批注</button>
                <button type="button" onClick={addLayer} disabled={sourceChanged}>新建图层</button>
              </div>
            </section>
            <section className="pdf-reader-section">
              <h3>图层</h3>
              {sidecar?.layers.map((layer) => (
                <button key={layer.id} type="button" className={'pdf-reader-layer ' + (sidecar.activeLayerId === layer.id ? 'active' : '')} onClick={() => {
                  setSidecar({
                    ...sidecar,
                    activeLayerId: layer.id,
                    layers: sidecar.layers.map((item) => item.id === layer.id ? { ...item, visible: !item.visible } : item),
                  });
                }}>
                  <span>{layer.name}</span><small>{layer.visible ? '显示' : '隐藏'}</small>
                </button>
              ))}
            </section>
            <section className="pdf-reader-section">
              <h3>新增区域批注</h3>
              <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="标题" />
              <textarea value={comment} onChange={(event) => setComment(event.currentTarget.value)} placeholder="评论或摘录" rows={3} />
              <label>颜色<input type="color" value={color} onChange={(event) => setColor(event.currentTarget.value)} /></label>
              <div className="pdf-reader-coordinate-grid">
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <label key={key}>{key}<input type="number" min={0} max={1} step={0.01} value={coordinates[key]} onChange={(event) => setCoordinates({ ...coordinates, [key]: Math.max(0, Math.min(1, Number(event.currentTarget.value) || 0)) })} /></label>
                ))}
              </div>
              <button type="button" onClick={addHighlight} disabled={!sidecar || sourceChanged}>添加批注</button>
            </section>
            <section className="pdf-reader-section">
              <h3>本页批注 {visibleHighlights.length}</h3>
              {visibleHighlights.map((highlight) => (
                <article className="pdf-reader-highlight" key={highlight.id} style={{ borderLeftColor: highlight.color }}>
                  <button type="button" onClick={() => setPage(highlight.page)}><strong>{highlight.title}</strong><span>{highlight.comment || '无评论'}</span></button>
                  <button type="button" onClick={() => removeHighlight(highlight.id)} disabled={sourceChanged} aria-label="删除批注">×</button>
                </article>
              ))}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
