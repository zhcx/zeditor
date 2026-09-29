import { useCallback, useEffect, useRef, useState } from 'react';
import { save as chooseSaveFile } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import type { IMarkmapOptions, Markmap } from 'markmap-view';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import {
  MARKMAP_BACKGROUND,
  applyMarkmapTheme,
  markmapColor,
  readMarkmapTheme,
  type MarkmapTheme,
} from '../../utils/markmapSource';
import '../../styles/markmap-viewer.css';

export interface MarkmapViewerProps {
  /** 思维导图源码：` ```markmap ` 围栏内的文本（标准 Markdown 标题层级）。 */
  source: string;
  /** 内联在 Markdown 代码块中：紧凑排版。 */
  embedded?: boolean;
  /** 导出文件名使用的标题（通常是当前文档路径）。 */
  title?: string;
}

type TransformerInstance = InstanceType<typeof import('markmap-lib').Transformer>;

/** 节点结构（与 markmap 的 IPureNode 同形，只取渲染需要的字段）。 */
interface MarkmapNodeLike {
  content?: string;
  children?: MarkmapNodeLike[];
}

type ViewerStatus = 'loading' | 'ready' | 'error';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * 解析器无状态、可跨思维导图复用；构造时会装配 markdown-it 与插件，成本较高，
 * 因此整个会话只建一次（首次真正遇到 ```markmap 时才加载）。
 */
let transformerInstance: TransformerInstance | null = null;

async function loadTransformer(): Promise<TransformerInstance> {
  if (!transformerInstance) {
    const { Transformer } = await import('markmap-lib');
    transformerInstance = new Transformer();
  }
  return transformerInstance;
}

/**
 * markmap 会把节点 content 作为 HTML 写进 foreignObject，因此在交给渲染器之前
 * 用预览同一套规则清洗（脚本、事件属性与 javascript: 链接都会被移除）。
 */
function sanitizeNodeContent(node: MarkmapNodeLike): void {
  node.content = sanitizeRenderedHtml(String(node.content ?? ''));
  node.children?.forEach(sanitizeNodeContent);
}

function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function exportFileName(title: string | undefined): string {
  const base = (title || 'mindmap').split(/[\\/]/).pop() || 'mindmap';
  const stem = base.replace(/\.(?:md|markdown|txt)$/i, '').replace(/[^\w.-]+/g, '-');
  return `${stem || 'mindmap'}.png`;
}

/** 桌面端走系统保存对话框，浏览器预览退化为普通下载。 */
async function savePng(blob: Blob, fileName: string): Promise<string> {
  if (isDesktopRuntime()) {
    const path = await chooseSaveFile({ defaultPath: fileName, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!path) return '已取消导出';
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return `已导出：${path}`;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return '已导出 PNG';
}

/**
 * Markmap 思维导图查看器：把 Markdown 标题层级渲染为可平移 / 缩放 / 折叠的 SVG 树。
 * 与 Mermaid 图表一样只读，不联网；配色跟随明暗主题，支持导出 2 倍分辨率 PNG。
 */
export function MarkmapViewer({ source, embedded, title }: MarkmapViewerProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const markmapRef = useRef<Markmap | null>(null);
  const appliedThemeRef = useRef<MarkmapTheme | null>(null);
  const [theme, setTheme] = useState<MarkmapTheme>(readMarkmapTheme);
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const handleThemeChange = () => setTheme(readMarkmapTheme());
    window.addEventListener('zeditor-theme-change', handleThemeChange);
    return () => window.removeEventListener('zeditor-theme-change', handleThemeChange);
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    let disposed = false;
    setStatus('loading');
    setErrorMessage('');
    setNotice('');

    void (async () => {
      try {
        const [{ Markmap: MarkmapCtor }, transformer] = await Promise.all([
          import('markmap-view'),
          loadTransformer(),
        ]);
        if (disposed) return;

        const { root } = transformer.transform(source);
        if (!root || (!root.content && (root.children ?? []).length === 0)) {
          setStatus('error');
          setErrorMessage('思维导图内容为空：请用 Markdown 标题（# / ## / ###）组织层级。');
          return;
        }

        sanitizeNodeContent(root);
        // React 复用同一个 svg 节点，重建前清掉上一次的 markmap id 类名。
        svg.setAttribute('class', 'markmap-svg');
        const currentTheme = readMarkmapTheme();
        const options: Partial<IMarkmapOptions> = {
          autoFit: true,
          // 普通滚轮交给文档滚动，按住 Ctrl 才缩放；拖动平移仍然可用。
          pan: false,
          zoom: true,
          scrollForPan: true,
          duration: 300,
          maxWidth: 360,
          embedGlobalCSS: true,
          color: markmapColor(currentTheme),
        };
        applyMarkmapTheme(svg, currentTheme);
        markmapRef.current = MarkmapCtor.create(svg, options, root);
        appliedThemeRef.current = currentTheme;
        setStatus('ready');
      } catch (error) {
        if (disposed) return;
        console.error('Markmap render error:', error);
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      disposed = true;
      markmapRef.current?.destroy();
      markmapRef.current = null;
      appliedThemeRef.current = null;
    };
  }, [source]);

  // 主题切换只换配色与排版变量：保留缩放位置与折叠状态，不重建整棵树。
  useEffect(() => {
    const svg = svgRef.current;
    const instance = markmapRef.current;
    if (!svg || !instance || appliedThemeRef.current === theme) return;
    appliedThemeRef.current = theme;
    applyMarkmapTheme(svg, theme);
    instance.setOptions({ color: markmapColor(theme) });
    void instance.renderData();
  }, [theme]);

  const fitView = useCallback(() => {
    void markmapRef.current?.fit();
  }, []);

  const exportPng = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const scale = 2;

    // markmap 把自带样式写进 SVG 内的 <style>，主题变量是内联样式：
    // 克隆整个 SVG 即可得到自带样式的矢量图，只差一层不透明底色。
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', SVG_NAMESPACE);
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const background = document.createElementNS(SVG_NAMESPACE, 'rect');
    background.setAttribute('width', String(width));
    background.setAttribute('height', String(height));
    background.setAttribute('fill', MARKMAP_BACKGROUND[theme]);
    clone.insertBefore(background, clone.firstChild);

    const serialized = new XMLSerializer().serializeToString(clone);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        void savePng(blob, exportFileName(title))
          .then(setNotice)
          .catch((error: unknown) => {
            console.error('Markmap export error:', error);
            setNotice('导出 PNG 失败');
          });
      }, 'image/png');
    };
    image.onerror = () => setNotice('导出 PNG 失败');
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
  }, [theme, title]);

  return (
    <figure className={`markmap-container${embedded ? ' is-embedded' : ''}`}>
      <figcaption>Markmap 思维导图</figcaption>
      {status === 'error' ? (
        <div className="markmap-error">
          <strong>思维导图渲染失败</strong>
          <span>{errorMessage}</span>
          <pre>{source}</pre>
        </div>
      ) : (
        <div className="markmap-canvas">
          <svg ref={svgRef} className="markmap-svg" role="img" aria-label="思维导图" />
          {status === 'loading' && <div className="markmap-loading">正在渲染思维导图…</div>}
          <div className="markmap-actions">
            <button type="button" onClick={fitView} disabled={status !== 'ready'}>适应视图</button>
            <button type="button" onClick={() => void exportPng()} disabled={status !== 'ready'}>导出 PNG</button>
          </div>
        </div>
      )}
      {notice && <span className="markmap-notice">{notice}</span>}
    </figure>
  );
}
