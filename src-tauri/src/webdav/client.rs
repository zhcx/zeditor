use reqwest::StatusCode;

use super::model::WebDavSettings;

/// Authenticated WebDAV protocol client.
///
/// Provides HTTP methods for WebDAV operations: MKCOL, PUT, GET, DELETE, PROPFIND.
/// Implements connection testing, error sanitization, and timeout enforcement.
/// The `new` constructor succeeds only when the server URL is valid.
#[derive(Debug, Clone)]
pub struct WebDavClient {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    username: String,
    password: String,
}

impl WebDavClient {
    /// Build a client from application settings.
    ///
    /// Returns an error when the server URL is empty, invalid, or contains embedded
    /// credentials (which are written to the separate settings fields instead).
    pub fn new(settings: &WebDavSettings) -> Result<Self, String> {
        let endpoint = if settings.server_url.is_empty() {
            return Err("WebDAV server URL is required".to_string());
        } else {
            reqwest::Url::parse(&settings.server_url)
                .map_err(|_| "WebDAV server URL is not a valid URL".to_string())?
        };

        if !matches!(endpoint.scheme(), "http" | "https") {
            return Err("WebDAV endpoint must use HTTP or HTTPS".to_string());
        }
        if endpoint.host_str().is_none() {
            return Err("WebDAV endpoint must include a host".to_string());
        }
        if !endpoint.username().is_empty() || endpoint.password().is_some() {
            return Err("WebDAV endpoint must not contain credentials".to_string());
        }

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(
            "User-Agent",
            reqwest::header::HeaderValue::from_static("Zeditor-WebDAV/0.3.8"),
        );

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(45))
            .default_headers(headers)
            .build()
            .map_err(|error| format!("Failed to build WebDAV client: {error}"))?;

        Ok(Self {
            client,
            endpoint,
            username: settings.username.clone(),
            password: settings.password.clone(),
        })
    }

    /// Build the full request URL for a resource path.
    ///
    /// Appends the path to the configured endpoint while preserving any base
    /// sub-path in the endpoint (e.g. `http://host:5005/dav` + `/Zeditor` →
    /// `/dav/Zeditor`). `Url::join` would silently drop the `/dav` prefix.
    fn request_url(&self, path: &str) -> Result<reqwest::Url, String> {
        let base = self.endpoint.to_string().trim_end_matches('/').to_string();
        let suffix = path.trim_start_matches('/');
        reqwest::Url::parse(&format!("{base}/{suffix}"))
            .map_err(|error| format!("Invalid WebDAV resource path: {error}"))
    }

    fn apply_auth(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if !self.username.is_empty() {
            request.basic_auth(&self.username, Some(&self.password))
        } else {
            request
        }
    }

    /// Recursively create a remote collection and all missing parent collections.
    ///
    /// Collection requests use a trailing slash: RFC 4918 collection URLs end
    /// with `/`, and several servers (including fnOS NAS WebDAV) return 405 for
    /// slash-less MKCOL even though clients like Obsidian create directories
    /// fine with the trailing slash.
    pub async fn ensure_collection(&self, path: &str) -> Result<(), String> {
        let segments: Vec<&str> = path
            .trim_start_matches('/')
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();

        let mut current = String::new();
        for segment in &segments {
            current.push('/');
            current.push_str(segment);
            self.mkcol(&current).await?;
        }
        Ok(())
    }

    async fn mkcol(&self, path: &str) -> Result<(), String> {
        let collection_path = format!("{}/", path.trim_end_matches('/'));
        let url = self.request_url(&collection_path)?;
        let request = self
            .client
            .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), url);
        let response = self
            .apply_auth(request)
            .send()
            .await
            .map_err(|error| classify_network_error(&error))?;

        let status = response.status();
        match status {
            // 201: created. 301: redirected to the canonical collection URL.
            StatusCode::CREATED | StatusCode::MOVED_PERMANENTLY => Ok(()),
            // 405 is ambiguous: the collection may already exist, or the server
            // may refuse automatic directory creation (common on NAS WebDAV).
            // Verify with PROPFIND instead of guessing.
            StatusCode::METHOD_NOT_ALLOWED => match self.propfind_exists(&collection_path).await {
                Ok(true) => Ok(()),
                Ok(false) => Err(format!(
                    "服务器不支持自动创建目录（MKCOL 405）：{path} 不存在。请先在 NAS 文件管理器中手动创建该目录，再重新测试连接"
                )),
                Err(_) => Err(
                    "服务器不支持创建远端目录（MKCOL 405），且无法验证目录是否已存在".to_string(),
                ),
            },
            _ => Err(sanitize_webdav_error(Some(status.as_u16()), "")),
        }
    }

    /// Upload bytes to a resource path, replacing an existing resource.
    pub async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let url = self.request_url(path)?;
        let request = self.client.put(url).body(bytes.to_vec());
        let response = self
            .apply_auth(request)
            .send()
            .await
            .map_err(|error| classify_network_error(&error))?;

        let status = response.status();
        if matches!(status.as_u16(), 200 | 201 | 204) {
            Ok(())
        } else {
            Err(sanitize_webdav_error(Some(status.as_u16()), ""))
        }
    }

    /// Read a resource; returns `None` when the server responds with 404.
    pub async fn get_optional(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        let url = self.request_url(path)?;
        let request = self.client.get(url);
        let response = self
            .apply_auth(request)
            .send()
            .await
            .map_err(|error| classify_network_error(&error))?;

        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(sanitize_webdav_error(Some(status.as_u16()), ""));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read WebDAV response: {error}"))?;
        Ok(Some(bytes.to_vec()))
    }

    /// Read a resource; returns an error when the resource is absent.
    pub async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
        self.get_optional(path)
            .await?
            .ok_or_else(|| format!("WebDAV resource not found: {path}"))
    }

    /// Delete a resource; returns `Ok(())` when the resource is absent.
    pub async fn delete_optional(&self, path: &str) -> Result<(), String> {
        let url = self.request_url(path)?;
        let request = self.client.delete(url);
        let response = self
            .apply_auth(request)
            .send()
            .await
            .map_err(|error| classify_network_error(&error))?;

        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(());
        }
        if status.is_success() || status == StatusCode::NO_CONTENT {
            Ok(())
        } else {
            Err(sanitize_webdav_error(Some(status.as_u16()), ""))
        }
    }

    /// Check whether a resource exists via PROPFIND.
    pub async fn propfind_exists(&self, path: &str) -> Result<bool, String> {
        let url = self.request_url(path)?;
        let request = self
            .client
            .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
            .header("Depth", "0");
        let response = self
            .apply_auth(request)
            .send()
            .await
            .map_err(|error| classify_network_error(&error))?;

        let status = response.status();
        if status == StatusCode::MULTI_STATUS {
            Ok(true)
        } else if status == StatusCode::NOT_FOUND {
            Ok(false)
        } else {
            Err(sanitize_webdav_error(Some(status.as_u16()), ""))
        }
    }

    /// Verify WebDAV access by creating the root, writing a probe, reading it back,
    /// and cleaning up.
    pub async fn test_connection(&self, remote_root: &str) -> Result<(), String> {
        let probe_name = format!(".zeditor-probe-{}.txt", uuid::Uuid::new_v4());
        let probe_path = if remote_root == "/" {
            format!("/{probe_name}")
        } else {
            let root = remote_root.trim_start_matches('/');
            format!("/{root}/{probe_name}")
        };

        // Ensure the root collection exists
        self.ensure_collection(remote_root)
            .await
            .map_err(|error| format!("创建远端目录失败：{error}"))?;

        // Write the probe
        let probe_bytes: &[u8] = b"zeditor-webdav-test";
        self.put(&probe_path, probe_bytes)
            .await
            .map_err(|error| format!("上传测试文件失败（PUT {probe_path}）：{error}"))?;

        // Read and verify
        let read_back = self
            .get(&probe_path)
            .await
            .map_err(|error| format!("读取测试文件失败（GET {probe_path}）：{error}"))?;
        if read_back.as_slice() != probe_bytes {
            // Attempt cleanup but return the mismatch error
            let _ = self.delete_optional(&probe_path).await;
            return Err(format!(
                "读取测试文件失败（GET {probe_path}）：返回内容与上传不一致"
            ));
        }

        // Clean up the probe (best-effort)
        let _ = self.delete_optional(&probe_path).await;

        Ok(())
    }
}

/// Protocol-agnostic remote storage client used by the sync manager.
///
/// Both the WebDAV client and the S3 client implement this trait so the
/// manager can run the same snapshot/manifest/index/current transaction
/// against either backend. Paths are always absolute (`/`-prefixed) strings;
/// each implementation maps them to its own URL/key space.
//
// `async fn` in trait is stable since Rust 1.75; the lint fires because
// auto-trait bounds on the returned future are unspecified. We always use
// these through `Box<dyn RemoteSyncClient>`, so the future's Send-ness is
// resolved at the concrete impl, not through the trait object.
#[allow(async_fn_in_trait)]
pub trait RemoteSyncClient: Send + Sync {
    /// Ensure the remote collection (directory) exists. Object stores with a
    /// flat namespace (S3) accept this as a no-op.
    async fn ensure_collection(&self, path: &str) -> Result<(), String>;

    /// Upload bytes to a resource path, replacing an existing resource.
    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String>;

    /// Read a resource; `Ok(None)` when the resource is absent.
    async fn get_optional(&self, path: &str) -> Result<Option<Vec<u8>>, String>;

    /// Delete a resource; absence is not an error.
    async fn delete_optional(&self, path: &str) -> Result<(), String>;

    /// Verify read/write capability with a probe write/read/delete cycle.
    async fn test_connection(&self, remote_root: &str) -> Result<(), String>;
}

impl RemoteSyncClient for WebDavClient {
    async fn ensure_collection(&self, path: &str) -> Result<(), String> {
        self.ensure_collection(path).await
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.put(path, bytes).await
    }

    async fn get_optional(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        self.get_optional(path).await
    }

    async fn delete_optional(&self, path: &str) -> Result<(), String> {
        self.delete_optional(path).await
    }

    async fn test_connection(&self, remote_root: &str) -> Result<(), String> {
        self.test_connection(remote_root).await
    }
}

/// Concrete client backend chosen by the sync manager at runtime.
///
/// An enum instead of a trait object keeps the async futures concrete (and
/// always Send) while still letting the manager run one transaction against
/// either protocol.
#[derive(Clone)]
pub enum RemoteClient {
    WebDav(WebDavClient),
    S3(crate::webdav::S3Client),
}

impl RemoteSyncClient for RemoteClient {
    async fn ensure_collection(&self, path: &str) -> Result<(), String> {
        match self {
            Self::WebDav(client) => client.ensure_collection(path).await,
            Self::S3(client) => client.ensure_collection(path).await,
        }
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::WebDav(client) => client.put(path, bytes).await,
            Self::S3(client) => client.put(path, bytes).await,
        }
    }

    async fn get_optional(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        match self {
            Self::WebDav(client) => client.get_optional(path).await,
            Self::S3(client) => client.get_optional(path).await,
        }
    }

    async fn delete_optional(&self, path: &str) -> Result<(), String> {
        match self {
            Self::WebDav(client) => client.delete_optional(path).await,
            Self::S3(client) => client.delete_optional(path).await,
        }
    }

    async fn test_connection(&self, remote_root: &str) -> Result<(), String> {
        match self {
            Self::WebDav(client) => client.test_connection(remote_root).await,
            Self::S3(client) => client.test_connection(remote_root).await,
        }
    }
}

/// Classify a reqwest error into a user-facing message.
fn classify_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "WebDAV request timed out. Please check your network connection and server URL.".to_string()
    } else if error.is_connect() {
        "WebDAV connection refused. Please verify the server URL and that the server is running."
            .to_string()
    } else if error.is_body() {
        "WebDAV request body error. The request could not be sent.".to_string()
    } else if error.is_request() {
        "WebDAV request error. The request could not be completed.".to_string()
    } else {
        format!("WebDAV error: {}", sanitize_diagnostic(&error.to_string()))
    }
}

/// Centralized WebDAV error sanitization.
///
/// Known status codes map to fixed Chinese messages. Unknown status codes
/// produce a generic status-only message: the server diagnostic is never echoed
/// because a malicious or broken server could repeat credentials or document
/// content back in its response body.
pub fn sanitize_webdav_error(status: Option<u16>, _text: &str) -> String {
    match status {
        Some(401) => "WebDAV 认证失败：用户名或密码不正确".to_string(),
        Some(403) => "WebDAV 权限不足：服务器拒绝了操作".to_string(),
        Some(404) => "WebDAV 资源未找到：远端路径可能已被删除".to_string(),
        Some(405) | Some(501) => {
            "服务器不支持此连接方式（HTTP 405/501）：目标服务器可能未启用 WebDAV 写入支持，或远端路径指向了非 WebDAV 目录".to_string()
        }
        Some(409) => "WebDAV 冲突：远端目标已存在或路径无效".to_string(),
        Some(412) => "WebDAV 前置条件失败".to_string(),
        Some(423) => "WebDAV 资源被锁定".to_string(),
        Some(507) => "WebDAV 存储空间不足".to_string(),
        Some(code) => format!("WebDAV 服务器返回错误 (HTTP {code})"),
        None => "WebDAV 请求失败但未收到响应".to_string(),
    }
}

/// Strip control characters and cap a diagnostic at 240 characters.
fn sanitize_diagnostic(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    cap_message(&cleaned, 240)
}

fn cap_message(message: &str, max_len: usize) -> String {
    if message.chars().count() <= max_len {
        message.to_string()
    } else {
        let mut truncated: String = message.chars().take(max_len).collect();
        truncated.push('…');
        truncated
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    // Fields are read by manager/integration test consumers beyond the client
    // module itself; keep the fixture structs whole.
    #![allow(dead_code)]

    use super::*;
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    #[derive(Clone, Debug)]
    pub(crate) struct RecordedRequest {
        pub method: String,
        pub path: String,
        pub authorization: String,
        pub depth: String,
        pub body: Vec<u8>,
    }

    pub(crate) struct TestDavServer {
        pub url: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        resources: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        statuses: Arc<Mutex<VecDeque<u16>>>,
        fail_once_path: Arc<Mutex<Option<String>>>,
        _shutdown: tokio::sync::watch::Sender<bool>,
    }

    impl Drop for TestDavServer {
        fn drop(&mut self) {
            let _ = self._shutdown.send(true);
        }
    }

    impl TestDavServer {
        /// Start a test server with a fixed sequence of status codes for each request.
        /// When the queue is empty, the server falls back to its default per-method logic.
        pub async fn start(statuses: Vec<u16>) -> Self {
            Self::start_inner(
                Arc::new(Mutex::new(VecDeque::from(statuses))),
                Arc::new(Mutex::new(HashMap::new())),
                Arc::new(Mutex::new(None)),
            )
            .await
        }

        /// Start a server that always returns 200/201/204/207 for normal operations.
        pub async fn success() -> Self {
            Self::start_inner(
                Arc::new(Mutex::new(VecDeque::new())),
                Arc::new(Mutex::new(HashMap::new())),
                Arc::new(Mutex::new(None)),
            )
            .await
        }

        /// Start a server that returns 503 once for the MKCOL path `/Zeditor/notes/note.md`
        /// (or a PUT to that path — the fail_once is triggered by the path segment).
        pub async fn fail_once_on_current() -> Self {
            Self::start_inner(
                Arc::new(Mutex::new(VecDeque::new())),
                Arc::new(Mutex::new(HashMap::new())),
                Arc::new(Mutex::new(Some("/Zeditor/notes/note.md".to_string()))),
            )
            .await
        }

        /// Start a server with pre-seeded resources.
        pub async fn with_resources(resources: HashMap<String, Vec<u8>>) -> Self {
            Self::start_inner(
                Arc::new(Mutex::new(VecDeque::new())),
                Arc::new(Mutex::new(resources)),
                Arc::new(Mutex::new(None)),
            )
            .await
        }

        async fn start_inner(
            statuses: Arc<Mutex<VecDeque<u16>>>,
            resources: Arc<Mutex<HashMap<String, Vec<u8>>>>,
            fail_once_path: Arc<Mutex<Option<String>>>,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind test server");
            let port = listener.local_addr().unwrap().port();
            let url = format!("http://127.0.0.1:{port}/");

            let requests = Arc::new(Mutex::new(Vec::new()));
            let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

            let requests_clone = requests.clone();
            let resources_clone = resources.clone();
            let statuses_clone = statuses.clone();
            let fail_once_clone = fail_once_path.clone();

            tokio::spawn(async move {
                loop {
                    let mut shutdown = shutdown_rx.clone();
                    tokio::select! {
                        _ = shutdown.changed() => break,
                        accept = listener.accept() => {
                            let (mut stream, _) = match accept {
                                Ok(v) => v,
                                Err(_) => break,
                            };

                            let requests = requests_clone.clone();
                            let resources = resources_clone.clone();
                            let statuses = statuses_clone.clone();
                            let fail_once = fail_once_clone.clone();

                            tokio::spawn(async move {
                                handle_connection(&mut stream, &requests, &resources, &statuses, &fail_once).await;
                            });
                        }
                    }
                }
            });

            Self {
                url,
                requests,
                resources,
                statuses,
                fail_once_path,
                _shutdown: shutdown_tx,
            }
        }

        pub async fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().await.clone()
        }

        /// Return the paths of all PUT requests, in order.
        pub async fn put_paths(&self) -> Vec<String> {
            let guard = self.requests.lock().await;
            guard
                .iter()
                .filter(|r| r.method == "PUT")
                .map(|r| r.path.clone())
                .collect()
        }

        pub async fn resource(&self, path: &str) -> Option<Vec<u8>> {
            self.resources.lock().await.get(path).cloned()
        }

        /// Parse the stored manifest and return its version count, or 0 if absent.
        pub async fn visible_manifest_versions(&self) -> usize {
            let guard = self.resources.lock().await;
            for (path, bytes) in guard.iter() {
                if path.ends_with("/manifest.json") {
                    if let Ok(manifest) =
                        serde_json::from_slice::<crate::webdav::DocumentManifest>(bytes)
                    {
                        return manifest.versions.len();
                    }
                }
            }
            0
        }
    }

    pub(crate) fn settings_for(url: &str) -> WebDavSettings {
        WebDavSettings {
            enabled: true,
            server_url: url.into(),
            username: "user".into(),
            password: "secret".into(),
            remote_root: "/Zeditor".into(),
        }
    }

    async fn handle_connection(
        stream: &mut tokio::net::TcpStream,
        requests: &Arc<Mutex<Vec<RecordedRequest>>>,
        resources: &Arc<Mutex<HashMap<String, Vec<u8>>>>,
        statuses: &Arc<Mutex<VecDeque<u16>>>,
        fail_once: &Arc<Mutex<Option<String>>>,
    ) {
        // Read the request line and headers
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).await.is_err() {
            return;
        }
        let request_line = request_line.trim_end();

        let parts: Vec<&str> = request_line.split_whitespace().collect();
        if parts.len() < 2 {
            return;
        }
        let method = parts[0].to_string();
        let path = parts[1].to_string();

        // Read headers
        let mut authorization = String::new();
        let mut content_length: usize = 0;
        let mut depth = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.is_err() {
                return;
            }
            if line.trim().is_empty() {
                break;
            }
            let line = line.trim_end();
            // HTTP header names are case-insensitive; hyper/reqwest emit them in
            // lowercase over HTTP/1.1, so match case-insensitively.
            let lower = line.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("authorization: ") {
                // `rest` is a byte slice of `lower`; the original value in `line`
                // starts at `line.len() - rest.len()` (lower/line share the same
                // byte length, and to_ascii_lowercase never changes length).
                let value_start = line.len() - rest.len();
                authorization = line[value_start..].to_string();
            } else if let Some(rest) = lower.strip_prefix("content-length: ") {
                content_length = rest.parse().unwrap_or(0);
            } else if let Some(rest) = lower.strip_prefix("depth: ") {
                let value_start = line.len() - rest.len();
                depth = line[value_start..].to_string();
            }
        }

        // Read body
        let mut body = Vec::new();
        if content_length > 0 {
            let mut remaining = content_length;
            let mut chunk = vec![0u8; 8192];
            while remaining > 0 {
                let want = remaining.min(chunk.len());
                let read = reader.read(&mut chunk[..want]).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..read]);
                remaining -= read;
            }
        }

        // Record the request
        {
            let mut guard = requests.lock().await;
            guard.push(RecordedRequest {
                method: method.clone(),
                path: path.clone(),
                authorization,
                depth,
                body: body.clone(),
            });
        }

        // Check queued statuses
        {
            let mut guard = statuses.lock().await;
            if let Some(status) = guard.pop_front() {
                write_response(reader.into_inner(), status, "").await;
                return;
            }
        }

        // Check fail_once
        {
            let mut guard = fail_once.lock().await;
            if let Some(ref fail_path) = *guard {
                // Trigger failure when the request path contains the fail path
                if path.contains(fail_path) {
                    *guard = None;
                    write_response(reader.into_inner(), 503, "").await;
                    return;
                }
            }
        }

        // Default handling
        let stream = reader.into_inner();
        match method.as_str() {
            "MKCOL" => {
                write_response(stream, 201, "").await;
            }
            "PUT" => {
                {
                    let mut guard = resources.lock().await;
                    guard.insert(path, body);
                }
                write_response(stream, 204, "").await;
            }
            "GET" => {
                let resource = {
                    let guard = resources.lock().await;
                    guard.get(&path).cloned()
                };
                match resource {
                    Some(data) => write_response_with_body(stream, 200, &data).await,
                    None => write_response(stream, 404, "").await,
                }
            }
            "DELETE" => {
                {
                    let mut guard = resources.lock().await;
                    guard.remove(&path);
                }
                write_response(stream, 204, "").await;
            }
            "PROPFIND" => {
                let exists = {
                    let guard = resources.lock().await;
                    guard.contains_key(&path)
                };
                if exists {
                    write_response(stream, 207, "").await;
                } else {
                    write_response(stream, 404, "").await;
                }
            }
            _ => {
                write_response(stream, 405, "").await;
            }
        }
    }

    async fn write_response(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
        let reason = status_reason(status);
        // 本服务器每个连接只处理一个请求随即关闭，因此必须显式声明
        // `Connection: close`：否则 reqwest 的连接池会把下一个请求复用到一个
        // 已被关闭的 socket 上，导致「同一个 WebDAV 用例偶发返回网络错误」。
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;
    }

    async fn write_response_with_body(
        stream: &mut tokio::net::TcpStream,
        status: u16,
        body: &[u8],
    ) {
        let reason = status_reason(status);
        // 同上：单请求连接，需显式关闭，避免连接池复用已关闭的 socket。
        let header = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes()).await;
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;
    }

    fn status_reason(status: u16) -> &'static str {
        match status {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            207 => "Multi-Status",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            409 => "Conflict",
            412 => "Precondition Failed",
            423 => "Locked",
            503 => "Service Unavailable",
            507 => "Insufficient Storage",
            _ => "Unknown",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_support::*;

    #[tokio::test]
    async fn creates_collections_and_uploads_with_basic_auth() {
        let server = TestDavServer::start(vec![201, 201, 204]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        client
            .ensure_collection("/Zeditor/docs")
            .await
            .expect("collections");
        client
            .put("/Zeditor/docs/note.md", b"hello")
            .await
            .expect("put");

        let requests = server.requests().await;
        let methods: Vec<&str> = requests.iter().map(|r| r.method.as_str()).collect();
        assert_eq!(methods, vec!["MKCOL", "MKCOL", "PUT"]);
        assert!(requests
            .iter()
            .all(|r| r.authorization.starts_with("Basic ")));
    }

    #[tokio::test]
    async fn sanitizes_authentication_errors() {
        let server = TestDavServer::start(vec![401]).await;
        let settings = settings_for(&server.url);
        let client = WebDavClient::new(&settings).expect("client");
        let error = client.get("/Zeditor/private.md").await.expect_err("401");
        assert!(error.contains("认证"));
        assert!(!error.contains(&settings.password));
    }

    #[tokio::test]
    async fn get_optional_returns_none_for_404() {
        let server = TestDavServer::start(vec![]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        let result = client
            .get_optional("/Zeditor/absent.md")
            .await
            .expect("optional get");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn put_then_get_round_trips_bytes() {
        let server = TestDavServer::start(vec![]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        client
            .put("/Zeditor/notes/note.md", b"hello world")
            .await
            .expect("put");
        let bytes = client.get("/Zeditor/notes/note.md").await.expect("get");
        assert_eq!(bytes.as_slice(), b"hello world");
    }

    #[tokio::test]
    async fn delete_optional_removes_resource() {
        let server = TestDavServer::start(vec![]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        client
            .put("/Zeditor/notes/note.md", b"delete me")
            .await
            .expect("put");
        client
            .delete_optional("/Zeditor/notes/note.md")
            .await
            .expect("delete");
        let result = client
            .get_optional("/Zeditor/notes/note.md")
            .await
            .expect("get after delete");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn delete_optional_accepts_absent_resource() {
        let server = TestDavServer::start(vec![]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        client
            .delete_optional("/Zeditor/absent.md")
            .await
            .expect("delete absent");
    }

    #[tokio::test]
    async fn propfind_detects_existence() {
        let server = TestDavServer::start(vec![]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        client
            .put("/Zeditor/notes/exists.md", b"content")
            .await
            .expect("put");
        assert!(client
            .propfind_exists("/Zeditor/notes/exists.md")
            .await
            .expect("propfind exists"));
        assert!(!client
            .propfind_exists("/Zeditor/notes/absent.md")
            .await
            .expect("propfind absent"));
    }

    #[tokio::test]
    async fn test_connection_probe_writes_reads_and_cleans_up() {
        let server = TestDavServer::start(vec![]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        client
            .test_connection("/Zeditor")
            .await
            .expect("connection test");

        let requests = server.requests().await;
        let methods: Vec<&str> = requests.iter().map(|r| r.method.as_str()).collect();
        // MKCOL /Zeditor, PUT probe, GET probe, DELETE probe
        assert!(methods.contains(&"MKCOL"));
        assert!(methods.contains(&"PUT"));
        assert!(methods.contains(&"GET"));
        assert!(methods.contains(&"DELETE"));
    }

    #[tokio::test]
    async fn new_client_rejects_embedded_credentials_in_url() {
        let settings = WebDavSettings {
            enabled: true,
            server_url: "https://user:pass@example.com/dav".to_string(),
            username: "".to_string(),
            password: "".to_string(),
            remote_root: "/Zeditor".to_string(),
        };
        let error = WebDavClient::new(&settings).expect_err("should reject embedded credentials");
        assert!(error.contains("credentials"));
    }

    #[tokio::test]
    async fn new_client_rejects_empty_url() {
        let settings = WebDavSettings {
            enabled: true,
            server_url: "".to_string(),
            username: "".to_string(),
            password: "".to_string(),
            remote_root: "/Zeditor".to_string(),
        };
        let error = WebDavClient::new(&settings).expect_err("should reject empty URL");
        assert!(error.contains("required"));
    }

    #[tokio::test]
    async fn anonymous_mode_works_without_auth_header() {
        let server = TestDavServer::start(vec![]).await;
        let settings = WebDavSettings {
            enabled: true,
            server_url: server.url.clone(),
            username: "".to_string(),
            password: "".to_string(),
            remote_root: "/Zeditor".to_string(),
        };
        let client = WebDavClient::new(&settings).expect("anonymous client");
        client
            .put("/Zeditor/notes/note.md", b"public")
            .await
            .expect("anonymous put");

        let requests = server.requests().await;
        assert!(requests[0].authorization.is_empty());
    }

    #[tokio::test]
    async fn ensure_collection_treats_existing_collection_as_success() {
        // MKCOL 405, then PROPFIND confirms the collection already exists (207).
        let server = TestDavServer::start(vec![201, 405, 207, 204]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        client
            .ensure_collection("/Zeditor/docs")
            .await
            .expect("existing collection");
        client
            .put("/Zeditor/docs/note.md", b"hi")
            .await
            .expect("put after existing collection");
    }

    #[tokio::test]
    async fn ensure_collection_rejects_405_when_collection_does_not_exist() {
        // MKCOL 405 and PROPFIND confirms absence (404): NAS-style servers that
        // refuse automatic directory creation must surface a clear diagnostic.
        let server = TestDavServer::start(vec![201, 405, 404]).await;
        let client = WebDavClient::new(&settings_for(&server.url)).expect("client");
        let error = client
            .ensure_collection("/Zeditor/docs")
            .await
            .expect_err("automatic creation refused");
        assert!(error.contains("手动创建"));
    }

    #[test]
    fn cap_message_truncates_without_splitting_multibyte_characters() {
        // The Chinese ellipsis and 汉 characters are 3 bytes each in UTF-8; a byte
        // slice at a non-character boundary would panic. cap_message must not.
        let message = "诊断：服务器拒绝访问，请检查权限".to_string();
        let capped = cap_message(&message, 10);
        assert!(capped.ends_with('…'));
        assert_eq!(capped.chars().count(), 11);
        assert!(capped.starts_with("诊断：服务器"));
    }

    #[test]
    fn cap_message_preserves_short_messages() {
        let message = "ok".to_string();
        assert_eq!(cap_message(&message, 240), "ok");
    }

    #[test]
    fn sanitize_maps_known_statuses_and_caps_unknown_errors() {
        assert!(sanitize_webdav_error(Some(401), "").contains("认证"));
        assert!(sanitize_webdav_error(Some(403), "").contains("权限"));
        assert!(sanitize_webdav_error(Some(404), "").contains("未找到"));
        assert!(sanitize_webdav_error(Some(507), "").contains("存储空间"));
        assert!(sanitize_webdav_error(Some(599), "").contains("599"));
        assert!(sanitize_webdav_error(None, "").contains("未收到"));
        assert!(sanitize_webdav_error(Some(405), "").contains("不支持此连接方式"));
        assert!(sanitize_webdav_error(Some(501), "").contains("不支持此连接方式"));
    }

    #[test]
    fn sanitized_errors_exclude_credentials_and_content() {
        let password = "super-secret-password";
        let document = "private document sentence";
        let raw = format!("server rejected {password}: {document}");

        let message = sanitize_webdav_error(Some(500), &raw);
        assert!(!message.contains(password));
        assert!(!message.contains(document));
        assert!(message.len() <= 240);

        // Known status codes never echo the server diagnostic at all.
        let auth_message = sanitize_webdav_error(Some(401), &raw);
        assert!(!auth_message.contains(password));
        assert!(!auth_message.contains(document));
    }

    #[test]
    fn sanitized_errors_strip_control_characters_and_cap_unknown_text() {
        let raw = "line1\r\nESC\x1b[31mred\x00null and a very long tail ".repeat(40);
        let message = sanitize_webdav_error(Some(599), &raw);
        assert!(!message.contains('\u{1b}'));
        assert!(!message.contains('\x00'));
        assert!(message.len() <= 240);
        assert!(message.contains("599"));
    }
}
