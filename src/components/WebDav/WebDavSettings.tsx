import { AppIcon } from '../Icons/AppIcon';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WebDavConnectionResult, WebDavSettings } from '../../types/webdav';

interface WebDavSettingsProps {
  value: WebDavSettings;
  onChange: (value: WebDavSettings) => void;
  onBrowseHistory: () => void;
}

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function WebDavSettings({ value, onChange, onBrowseHistory }: WebDavSettingsProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);

  const update = (patch: Partial<WebDavSettings>) => onChange({ ...value, ...patch });

  // 连接测试要求至少填写服务器地址，避免无意义的请求。
  const canTest = value.server_url.trim() !== '';

  const testConnection = async () => {
    if (!canTest || testing) return;
    setTesting(true);
    setResult(null);
    try {
      const response = await invoke<WebDavConnectionResult>('webdav_test_connection', {
        settings: value,
      });
      setResult({ ok: true, message: response.message });
    } catch (error) {
      setResult({ ok: false, message: String(error).slice(0, 240) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="webdav-settings">
      <div className="setting-item setting-toggle-item">
        <div className="setting-copy">
          <span>启用 WebDAV 自动备份</span>
          <small>
            本地保存成功后自动上传到远端服务器，保留最近 20 个不同内容版本。
            云端失败不会影响本地保存。
          </small>
        </div>
        <button
          type="button"
          className={`settings-switch ${value.enabled ? 'is-on' : ''}`}
          role="switch"
          aria-checked={value.enabled}
          aria-label="启用 WebDAV 自动备份"
          onClick={() => update({ enabled: !value.enabled })}
        >
          <span className="settings-switch-thumb" />
        </button>
      </div>

      {value.enabled && (
        <>
          <div className="setting-item">
            <label className="setting-label" htmlFor="webdav-server-url">
              服务器地址
            </label>
            <input
              id="webdav-server-url"
              className="setting-input"
              type="url"
              value={value.server_url}
              placeholder="https://example.com/dav"
              onChange={event => update({ server_url: event.target.value })}
            />
          </div>

          <div className="setting-item">
            <label className="setting-label" htmlFor="webdav-username">
              用户名
            </label>
            <input
              id="webdav-username"
              className="setting-input"
              type="text"
              value={value.username}
              autoComplete="off"
              onChange={event => update({ username: event.target.value })}
            />
          </div>

          <div className="setting-item">
            <label className="setting-label" htmlFor="webdav-password">
              密码 / 应用密码
            </label>
            <div className="webdav-password-row">
              <input
                id="webdav-password"
                className="setting-input"
                type={passwordVisible ? 'text' : 'password'}
                value={value.password}
                autoComplete="new-password"
                onChange={event => update({ password: event.target.value })}
              />
              <button
                type="button"
                className="webdav-password-toggle"
                aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                aria-pressed={passwordVisible}
                title={passwordVisible ? '隐藏密码' : '显示密码'}
                onClick={() => setPasswordVisible(visible => !visible)}
              >
                {passwordVisible ? (
                  <AppIcon name="eyeOff" size={20}  />
                ) : (
                  <AppIcon name="eye" size={20}  />
                )}
                <span>{passwordVisible ? '隐藏' : '显示'}</span>
              </button>
            </div>
          </div>

          <div className="setting-item">
            <label className="setting-label" htmlFor="webdav-remote-root">
              远端根目录
            </label>
            <input
              id="webdav-remote-root"
              className="setting-input"
              type="text"
              value={value.remote_root}
              onChange={event => update({ remote_root: event.target.value })}
            />
            <p className="setting-hint">凭据仅保存在本地设备，不会上传。</p>
          </div>

          {!isTauriRuntime() && (
            <p className="setting-hint webdav-desktop-only">
              WebDAV 备份仅在桌面版中可用。
            </p>
          )}

          <div className="setting-item webdav-actions">
            <button
              type="button"
              className="button webdav-action-primary"
              disabled={testing || !canTest}
              title={canTest ? undefined : '请先填写服务器地址'}
              onClick={() => void testConnection()}
            >
              {testing && <span className="ai-spinner webdav-action-spinner" aria-hidden="true" />}
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button
              type="button"
              className="button webdav-action-secondary"
              onClick={onBrowseHistory}
            >
              浏览全部备份
            </button>
          </div>

          {result && (
            <p className={`webdav-connection-result ${result.ok ? 'ok' : 'error'}`}>
              {result.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
