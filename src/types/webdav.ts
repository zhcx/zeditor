/** Frontend mirror of the Rust WebDAV DTOs and status contracts. */

export type WebDavSyncPhase = 'disabled' | 'idle' | 'queued' | 'syncing' | 'success' | 'error';

export interface WebDavSyncEvent {
  /** Backend that produced the event (`'webdav'` default, or `'s3'`). */
  provider?: string;
  document_id: string;
  local_path: string;
  phase: Exclude<WebDavSyncPhase, 'disabled' | 'idle'>;
  /** Optional progress description; absent for most phases. */
  progress?: string;
  timestamp: string;
  /** Sanitized failure message; only present on the error phase. */
  error?: string;
}

export interface WebDavSettings {
  enabled: boolean;
  server_url: string;
  username: string;
  password: string;
  remote_root: string;
}

export interface S3Settings {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  access_key: string;
  secret_key: string;
  path_style: boolean;
  remote_root: string;
}

export interface WebDavDocumentSummary {
  document_id: string;
  display_name: string;
  current_path: string;
  latest_at: string;
}

export interface WebDavVersion {
  encoding?: string;
  id: string;
  created_at: string;
  size: number;
  sha256: string;
  snapshot_path: string;
  /** Absent on legacy document-only backups; empty means verified no attachments. */
  assets?: BackupAsset[];
}

export interface BackupAsset {
  relative_path: string;
  snapshot_path: string;
  size: number;
  sha256: string;
}

export interface RestoredBackup {
  encoding?: string;
  path: string;
  asset_count: number;
  legacy_document_only: boolean;
}

export interface WebDavDownloadedVersion {
  filename: string;
  content: string;
  data_base64?: string;
  size: number;
  sha256: string;
}

export interface WebDavConnectionResult {
  message: string;
}
