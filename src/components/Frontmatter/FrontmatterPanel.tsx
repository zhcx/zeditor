import { useMemo, useState } from 'react';
import {
  parseFrontmatter,
  updateFrontmatterField,
  type FrontmatterField,
  type FrontmatterFieldType,
} from '../../utils/documentAnalysis';

interface FrontmatterPanelProps {
  content: string;
  onContentChange: (content: string) => void;
}

function displayValue(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

function valueForField(field: FrontmatterField, draft: string): unknown {
  if (field.type === 'checkbox') return draft === 'true';
  if (field.type === 'number' || field.type === 'progress') {
    const number = Number(draft);
    return Number.isFinite(number) ? number : 0;
  }
  if (field.type === 'array' || field.type === 'multiselect') {
    try {
      const parsed = JSON.parse(draft);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall back to the convenient comma-separated editor format.
    }
    return draft.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return draft;
}

function inputType(fieldType: FrontmatterFieldType) {
  if (fieldType === 'number' || fieldType === 'progress') return 'number';
  if (fieldType === 'date' || fieldType === 'datetime' || fieldType === 'time') return fieldType;
  return 'text';
}

export function FrontmatterPanel({ content, onContentChange }: FrontmatterPanelProps) {
  const analysis = useMemo(() => parseFrontmatter(content), [content]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const updateField = (field: FrontmatterField, draft: string) => {
    setDrafts((current) => ({ ...current, [field.key]: draft }));
    onContentChange(updateFrontmatterField(content, field.key, valueForField(field, draft)));
  };

  const addField = () => {
    const requested = window.prompt('新属性名称', 'title');
    const key = requested?.trim();
    if (!key || !/^[A-Za-z_][\w.-]*$/.test(key)) return;
    onContentChange(updateFrontmatterField(content, key, ''));
  };

  if (!analysis.present) {
    return (
      <div className="frontmatter-panel frontmatter-empty">
        <div>
          <strong>文档属性</strong>
          <span>为研究笔记添加标题、标签、状态或来源信息。</span>
        </div>
        <button type="button" onClick={() => onContentChange(updateFrontmatterField(content, 'title', ''))}>
          添加属性
        </button>
      </div>
    );
  }

  return (
    <details className="frontmatter-panel" open>
      <summary className="frontmatter-header">
        <span>
          <strong>文档属性</strong>
          <small>{analysis.fields.length} 个字段</small>
        </span>
        <button type="button" onClick={(event) => { event.preventDefault(); addField(); }}>
          添加字段
        </button>
      </summary>
      {analysis.diagnostics.length > 0 && (
        <div className="frontmatter-diagnostics" role="status">
          {analysis.diagnostics.map((diagnostic, index) => (
            <span key={diagnostic.message + index}>{diagnostic.message}</span>
          ))}
        </div>
      )}
      <div className="frontmatter-fields">
        {analysis.fields.map((field) => {
          const draft = drafts[field.key] ?? displayValue(field.value);
          const options = field.options?.map(String) || [];
          return (
            <label className="frontmatter-field" key={field.key}>
              <span className="frontmatter-field-label">
                {field.label || field.key}
                <small>{field.type}</small>
              </span>
              {field.type === 'checkbox' ? (
                <input
                  type="checkbox"
                  checked={draft === 'true'}
                  onChange={(event) => updateField(field, String(event.currentTarget.checked))}
                />
              ) : field.type === 'select' && options.length > 0 ? (
                <select value={draft} onChange={(event) => updateField(field, event.currentTarget.value)}>
                  {options.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input
                  type={inputType(field.type)}
                  min={field.type === 'progress' ? 0 : undefined}
                  max={field.type === 'progress' ? 100 : undefined}
                  value={draft}
                  onChange={(event) => setDrafts((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  onBlur={(event) => updateField(field, event.currentTarget.value)}
                />
              )}
            </label>
          );
        })}
      </div>
    </details>
  );
}
