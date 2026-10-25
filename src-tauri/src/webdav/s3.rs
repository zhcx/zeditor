//! S3-compatible object storage client with hand-written AWS SigV4 signing.

use chrono::Utc;
use reqwest::StatusCode;

use super::client::{
    sanitize_webdav_error, strong_etag, PutOutcome, RemoteObject, RemoteSyncClient,
    WritePrecondition,
};
use super::model::S3Settings;
use super::sigv4::{authorization, payload_hash, SigningContext, EMPTY_PAYLOAD_HASH};

/// S3-compatible object storage client.
///
/// Maps absolute `/`-prefixed paths to object keys under the configured
/// bucket, signing every request with AWS Signature Version 4. Standalone
/// clients add the configured root; sync-manager clients receive paths already
/// mapped below that root. Supports both path-style and virtual-hosted style.
#[derive(Debug, Clone)]
pub struct S3Client {
    client: reqwest::Client,
    scheme: String,
    host: String,
    bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
    path_style: bool,
    remote_root: String,
}

impl S3Client {
    /// Build a standalone client that applies the configured root to relative paths.
    pub fn new(settings: &S3Settings) -> Result<Self, String> {
        Self::build(settings, true)
    }

    /// Build a sync-manager client for paths that already include the configured root.
    pub(super) fn new_for_mapped_paths(settings: &S3Settings) -> Result<Self, String> {
        Self::build(settings, false)
    }

    fn build(settings: &S3Settings, prefix_remote_root: bool) -> Result<Self, String> {
        if settings.endpoint.is_empty() {
            return Err("S3 服务端点（endpoint）不能为空".to_string());
        }
        if settings.bucket.is_empty() {
            return Err("S3 存储桶（bucket）不能为空".to_string());
        }
        if settings.access_key.is_empty() || settings.secret_key.is_empty() {
            return Err("S3 访问密钥（Access Key / Secret Key）不能为空".to_string());
        }

        let endpoint = settings.endpoint.trim_end_matches('/');
        let (scheme, host) = if let Some(rest) = endpoint.strip_prefix("https://") {
            ("https", rest)
        } else if let Some(rest) = endpoint.strip_prefix("http://") {
            ("http", rest)
        } else {
            return Err("S3 服务端点必须以 http:// 或 https:// 开头".to_string());
        };
        if host.is_empty() {
            return Err("S3 服务端点缺少主机名".to_string());
        }

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .map_err(|error| format!("Failed to build S3 client: {error}"))?;

        Ok(Self {
            client,
            scheme: scheme.to_string(),
            host: host.to_string(),
            bucket: settings.bucket.clone(),
            region: settings.region.clone(),
            access_key: settings.access_key.clone(),
            secret_key: settings.secret_key.clone(),
            path_style: settings.path_style,
            remote_root: if prefix_remote_root {
                settings.remote_root.trim_matches('/').to_string()
            } else {
                String::new()
            },
        })
    }

    /// Map a path to its bucket key. The sync manager already includes its root.
    fn object_key(&self, path: &str) -> String {
        let relative = path.trim_start_matches('/');
        if self.remote_root.is_empty() {
            relative.to_string()
        } else if relative.is_empty() {
            self.remote_root.clone()
        } else {
            format!("{}/{relative}", self.remote_root)
        }
    }

    /// Build the full request URL for an object key.
    fn url_for(&self, key: &str) -> String {
        let encoded = encode_key(key);
        if self.path_style {
            format!(
                "{}://{}/{}/{}",
                self.scheme, self.host, self.bucket, encoded
            )
        } else {
            format!(
                "{}://{}.{}/{}",
                self.scheme, self.bucket, self.host, encoded
            )
        }
    }

    /// Send a signed request and classify the status code for user-facing
    /// errors. `payload_hash` must already match the request body.
    async fn send_signed(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, String> {
        self.send_signed_with_headers(method, url, body, &[]).await
    }

    /// Send a signed request with extra headers covered by the signature.
    ///
    /// SigV4 requires every header named in `SignedHeaders` to appear in the
    /// canonical request, so conditional headers must be added before signing
    /// rather than appended to the request afterwards.
    async fn send_signed_with_headers(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Vec<u8>>,
        extra_headers: &[(&str, &str)],
    ) -> Result<reqwest::Response, String> {
        let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let date = Utc::now().format("%Y%m%d").to_string();
        let hash = match &body {
            Some(bytes) => payload_hash(bytes),
            None => EMPTY_PAYLOAD_HASH.to_string(),
        };

        // The canonical host is the URL's actual host (which includes the
        // bucket prefix in virtual-hosted style), and the canonical URI is
        // the path portion of the URL (e.g. /bucket/key).
        let parsed =
            reqwest::Url::parse(url).map_err(|error| format!("Invalid S3 request URL: {error}"))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "S3 request URL has no host".to_string())?;
        // Sign the same authority reqwest transmits in Host. Url::port()
        // excludes default ports and retains custom NAS/MinIO ports.
        let host = match parsed.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        let uri = if parsed.path().is_empty() {
            "/".to_string()
        } else {
            parsed.path().to_string()
        };

        let extra: Vec<(String, String)> = extra_headers
            .iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let mut headers = vec![
            ("host".to_string(), host),
            ("x-amz-content-sha256".to_string(), hash.clone()),
            ("x-amz-date".to_string(), timestamp.clone()),
        ];
        headers.extend(extra.iter().cloned());
        headers.sort_by(|left, right| left.0.cmp(&right.0));
        let canonical_headers: String = headers
            .iter()
            .map(|(name, value)| format!("{name}:{value}\n"))
            .collect();
        let signed_headers = headers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(";");

        let auth = authorization(&SigningContext {
            method: method.as_str(),
            uri: &uri,
            canonical_headers: &canonical_headers,
            signed_headers: &signed_headers,
            payload_hash: &hash,
            access_key: &self.access_key,
            secret_key: &self.secret_key,
            region: &self.region,
            timestamp: &timestamp,
            date: &date,
        });

        let mut request = self.client.request(method, url);
        request = request
            .header("x-amz-date", &timestamp)
            .header("x-amz-content-sha256", &hash)
            .header("Authorization", auth);
        for (name, value) in &extra {
            request = request.header(name, value);
        }
        if let Some(bytes) = body {
            request = request
                .header("Content-Type", "application/octet-stream")
                .body(bytes);
        }
        request
            .send()
            .await
            .map_err(|error| classify_s3_error(&error))
    }

    /// Check whether an object exists via HEAD.
    pub async fn head_exists(&self, path: &str) -> Result<bool, String> {
        let key = self.object_key(path);
        let url = self.url_for(&key);
        let response = self.send_signed(reqwest::Method::HEAD, &url, None).await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            Ok(false)
        } else if status.is_success() {
            Ok(true)
        } else {
            Err(sanitize_webdav_error(Some(status.as_u16()), ""))
        }
    }

    /// Read an object; returns an error when the object is absent.
    pub async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
        self.get_optional(path)
            .await?
            .ok_or_else(|| format!("S3 object not found: {path}"))
    }

    /// Read an object and its strong ETag; `None` when the object is absent.
    ///
    /// S3 always returns an ETag for a stored object; the value includes the
    /// quotes required by `If-Match`, so it is passed through unchanged.
    pub async fn get_optional_with_etag(&self, path: &str) -> Result<Option<RemoteObject>, String> {
        let key = self.object_key(path);
        let url = self.url_for(&key);
        let response = self.send_signed(reqwest::Method::GET, &url, None).await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(sanitize_webdav_error(Some(status.as_u16()), ""));
        }
        // The ETag must be read before consuming the response body.
        let etag = strong_etag(&response);
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read S3 response: {error}"))?;
        Ok(Some(RemoteObject {
            bytes: bytes.to_vec(),
            etag,
        }))
    }

    /// Upload bytes, enforcing an optional optimistic-concurrency precondition.
    ///
    /// S3 and MinIO evaluate `If-Match` / `If-None-Match` on PUT. A losing
    /// writer receives 412, or 409 with `ConditionalRequestConflict` when two
    /// conditional writes race; both map to `PreconditionFailed` so the sync
    /// manager can refetch the manifest and merge.
    pub async fn put_conditional(
        &self,
        path: &str,
        bytes: &[u8],
        precondition: WritePrecondition<'_>,
    ) -> Result<PutOutcome, String> {
        let key = self.object_key(path);
        let url = self.url_for(&key);
        let extra_headers: Vec<(&str, &str)> = match precondition {
            WritePrecondition::Unconditional => Vec::new(),
            WritePrecondition::MustNotExist => vec![("if-none-match", "*")],
            WritePrecondition::Match(etag) => vec![("if-match", etag)],
        };
        let mut status = self
            .send_signed_with_headers(
                reqwest::Method::PUT,
                &url,
                Some(bytes.to_vec()),
                &extra_headers,
            )
            .await?
            .status();

        // Some S3-compatible gateways reject conditional headers with 400 or
        // 501. Retry once unconditionally so backup still works there; the
        // lost race window is limited to those servers, as with WebDAV.
        if matches!(status.as_u16(), 400 | 501) && precondition != WritePrecondition::Unconditional
        {
            status = self
                .send_signed(reqwest::Method::PUT, &url, Some(bytes.to_vec()))
                .await?
                .status();
        }

        if matches!(status.as_u16(), 200 | 201 | 204) {
            Ok(PutOutcome::Applied)
        } else if status == StatusCode::PRECONDITION_FAILED
            || (status == StatusCode::CONFLICT && precondition != WritePrecondition::Unconditional)
        {
            Ok(PutOutcome::PreconditionFailed)
        } else {
            Err(sanitize_webdav_error(Some(status.as_u16()), ""))
        }
    }
}

impl RemoteSyncClient for S3Client {
    /// Object stores have a flat namespace; no directory creation needed.
    async fn ensure_collection(&self, _path: &str) -> Result<(), String> {
        Ok(())
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let key = self.object_key(path);
        let url = self.url_for(&key);
        let response = self
            .send_signed(reqwest::Method::PUT, &url, Some(bytes.to_vec()))
            .await?;
        let status = response.status();
        if matches!(status.as_u16(), 200 | 201 | 204) {
            Ok(())
        } else {
            Err(sanitize_webdav_error(Some(status.as_u16()), ""))
        }
    }

    async fn put_conditional(
        &self,
        path: &str,
        bytes: &[u8],
        precondition: WritePrecondition<'_>,
    ) -> Result<PutOutcome, String> {
        S3Client::put_conditional(self, path, bytes, precondition).await
    }

    async fn get_optional(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(S3Client::get_optional_with_etag(self, path)
            .await?
            .map(|object| object.bytes))
    }

    async fn get_optional_with_etag(&self, path: &str) -> Result<Option<RemoteObject>, String> {
        S3Client::get_optional_with_etag(self, path).await
    }

    async fn delete_optional(&self, path: &str) -> Result<(), String> {
        let key = self.object_key(path);
        let url = self.url_for(&key);
        let response = self
            .send_signed(reqwest::Method::DELETE, &url, None)
            .await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(());
        }
        if status.is_success() {
            Ok(())
        } else {
            Err(sanitize_webdav_error(Some(status.as_u16()), ""))
        }
    }

    async fn test_connection(&self, _remote_root: &str) -> Result<(), String> {
        let probe_name = format!(".zeditor-probe-{}.txt", uuid::Uuid::new_v4());
        let probe_path = format!("/{probe_name}");
        let probe_bytes: &[u8] = b"zeditor-s3-test";

        self.put(&probe_path, probe_bytes)
            .await
            .map_err(|error| format!("上传测试对象失败（PUT {probe_path}）：{error}"))?;

        let read_back = self
            .get_optional(&probe_path)
            .await
            .map_err(|error| format!("读取测试对象失败（GET {probe_path}）：{error}"))?;
        if read_back.as_deref() != Some(probe_bytes) {
            let _ = self.delete_optional(&probe_path).await;
            return Err(format!(
                "读取测试对象失败（GET {probe_path}）：内容与上传不一致"
            ));
        }

        let _ = self.delete_optional(&probe_path).await;
        Ok(())
    }
}

/// Percent-encode a key for use in a URL path segment, preserving `/`.
fn encode_key(key: &str) -> String {
    key.split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn classify_s3_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "S3 请求超时：请检查网络连接与服务端点".to_string()
    } else if error.is_connect() {
        "S3 连接失败：请检查服务端点与网络".to_string()
    } else {
        format!("S3 请求失败：{}", error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNED_HEADERS: &str = "host;x-amz-content-sha256;x-amz-date";

    fn settings_for(endpoint: &str) -> S3Settings {
        S3Settings {
            enabled: true,
            endpoint: endpoint.into(),
            bucket: "zeditor-backup".into(),
            region: "us-east-1".into(),
            access_key: "AKIDEXAMPLE".into(),
            secret_key: "secret".into(),
            // The test server listens on a bare IP; path-style keeps the URL
            // host parseable (virtual-hosted style would be bucket.IP:port).
            path_style: true,
            remote_root: "/Zeditor".into(),
        }
    }

    #[test]
    fn object_key_joins_remote_root_and_relative_path() {
        let client = S3Client::new(&settings_for("https://s3.amazonaws.com")).expect("client");
        assert_eq!(client.object_key("/note.md"), "Zeditor/note.md");
        assert_eq!(client.object_key("/docs/note.md"), "Zeditor/docs/note.md");
        assert_eq!(client.object_key("/"), "Zeditor");
    }

    #[test]
    fn virtual_host_url_uses_bucket_subdomain() {
        let mut settings = settings_for("https://s3.amazonaws.com");
        settings.path_style = false;
        let client = S3Client::new(&settings).expect("client");
        let key = client.object_key("/docs/note.md");
        assert_eq!(
            client.url_for(&key),
            "https://zeditor-backup.s3.amazonaws.com/Zeditor/docs/note.md"
        );
    }

    #[test]
    fn path_style_url_puts_bucket_in_path() {
        let mut settings = settings_for("http://localhost:9000");
        settings.path_style = true;
        let client = S3Client::new(&settings).expect("client");
        let key = client.object_key("/docs/note.md");
        assert_eq!(
            client.url_for(&key),
            "http://localhost:9000/zeditor-backup/Zeditor/docs/note.md"
        );
    }

    #[test]
    fn url_encoding_preserves_slashes_and_encodes_segments() {
        let mut settings = settings_for("http://localhost:9000");
        settings.path_style = true;
        settings.remote_root = "/My Notes".into();
        let client = S3Client::new(&settings).expect("client");
        let key = client.object_key("/报告 #.md");
        assert_eq!(key, "My Notes/报告 #.md");
        let url = client.url_for(&key);
        assert!(url.contains("My%20Notes"));
        assert!(url.contains("报告%20%23.md") || url.contains("%E6%8A%A5%E5%91%8A%20%23.md"));
        // 路径部分 = /bucket/My%20Notes/报告%20%23.md（两个分隔斜杠 + 编码内容不含裸 #）
        let path = url.split_once("://").map(|(_, rest)| rest).unwrap_or("");
        assert_eq!(path.matches('/').count(), 3);
    }

    #[test]
    fn new_validates_endpoint_and_credentials() {
        assert!(S3Client::new(&S3Settings::default()).is_err());
        let mut settings = settings_for("s3.amazonaws.com");
        settings.endpoint = "s3.amazonaws.com".into(); // 缺少 scheme
        assert!(S3Client::new(&settings).is_err());
    }

    #[tokio::test]
    async fn put_get_delete_round_trips_through_the_protocol() {
        let server = crate::webdav::client::test_support::TestDavServer::start(vec![]).await;
        let client = S3Client::new(&settings_for(&server.url)).expect("client");

        client.put("/docs/note.md", b"hello s3").await.expect("put");
        let bytes = client
            .get_optional("/docs/note.md")
            .await
            .expect("get")
            .expect("present");
        assert_eq!(bytes.as_slice(), b"hello s3");

        client
            .delete_optional("/docs/note.md")
            .await
            .expect("delete");
        assert!(client
            .get_optional("/docs/note.md")
            .await
            .expect("get after delete")
            .is_none());
    }

    #[tokio::test]
    async fn requests_carry_sigv4_authorization_headers() {
        let server = crate::webdav::client::test_support::TestDavServer::start(vec![]).await;
        let client = S3Client::new(&settings_for(&server.url)).expect("client");
        client.put("/note.md", b"data").await.expect("put");

        let requests = server.requests().await;
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "PUT");
        assert!(request.authorization.starts_with("AWS4-HMAC-SHA256 "));
        assert!(request.authorization.contains("us-east-1/s3/aws4_request"));
        assert!(request
            .authorization
            .contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
    }

    #[tokio::test]
    async fn signature_matches_actual_host_header_on_custom_port() {
        let server = crate::webdav::client::test_support::TestDavServer::success().await;
        let settings = settings_for(&server.url);
        let client = S3Client::new(&settings).unwrap();
        client.put("/中文 #.md", b"exact payload").await.unwrap();
        let requests = server.requests().await;
        let request = &requests[0];
        let timestamp = &request.headers["x-amz-date"];
        let hash = payload_hash(&request.body);
        let canonical_headers = format!(
            "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
            request.headers["host"], hash, timestamp
        );
        let expected = authorization(&SigningContext {
            method: &request.method,
            uri: &request.path,
            canonical_headers: &canonical_headers,
            signed_headers: SIGNED_HEADERS,
            payload_hash: &hash,
            access_key: &settings.access_key,
            secret_key: &settings.secret_key,
            region: &settings.region,
            timestamp,
            date: &timestamp[..8],
        });
        assert_eq!(request.authorization, expected);
    }

    #[tokio::test]
    async fn conditional_put_signs_if_match_and_rejects_a_stale_validator() {
        let server = crate::webdav::client::test_support::TestDavServer::start(vec![]).await;
        let client = S3Client::new(&settings_for(&server.url)).expect("client");

        assert_eq!(
            client
                .put_conditional("/note.md", b"first", WritePrecondition::MustNotExist)
                .await
                .expect("create"),
            PutOutcome::Applied
        );
        let object = client
            .get_optional_with_etag("/note.md")
            .await
            .expect("read")
            .expect("present");
        let etag = object.etag.clone().expect("S3 exposes a strong ETag");

        assert_eq!(
            client
                .put_conditional("/note.md", b"stale", WritePrecondition::Match("\"stale\""),)
                .await
                .expect("stale attempt"),
            PutOutcome::PreconditionFailed
        );
        assert_eq!(
            client
                .put_conditional("/note.md", b"second", WritePrecondition::Match(&etag))
                .await
                .expect("current etag"),
            PutOutcome::Applied
        );

        let requests = server.requests().await;
        let conditional = requests
            .iter()
            .find(|request| request.headers.get("if-match") == Some(&etag))
            .expect("signed If-Match request");
        assert!(conditional
            .authorization
            .contains("SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date"));
        let create = requests.first().expect("create request");
        assert_eq!(
            create.headers.get("if-none-match").map(String::as_str),
            Some("*")
        );
        assert!(create
            .authorization
            .contains("SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date"));
    }

    #[tokio::test]
    async fn must_not_exist_is_rejected_once_the_object_appears() {
        let server = crate::webdav::client::test_support::TestDavServer::start(vec![]).await;
        let client = S3Client::new(&settings_for(&server.url)).expect("client");

        assert_eq!(
            client
                .put_conditional("/note.md", b"first", WritePrecondition::MustNotExist)
                .await
                .expect("create"),
            PutOutcome::Applied
        );
        assert_eq!(
            client
                .put_conditional("/note.md", b"second", WritePrecondition::MustNotExist)
                .await
                .expect("second create"),
            PutOutcome::PreconditionFailed
        );

        let stored = client
            .get_optional("/note.md")
            .await
            .expect("read")
            .expect("present");
        assert_eq!(stored, b"first");
    }

    #[tokio::test]
    async fn remote_client_enforces_s3_preconditions() {
        let server = crate::webdav::client::test_support::TestDavServer::start(vec![]).await;
        let client = crate::webdav::RemoteClient::S3(
            S3Client::new(&settings_for(&server.url)).expect("client"),
        );

        assert_eq!(
            client
                .put_conditional("/note.md", b"first", WritePrecondition::MustNotExist)
                .await
                .expect("create"),
            PutOutcome::Applied
        );
        let etag = client
            .get_optional_with_etag("/note.md")
            .await
            .expect("read")
            .expect("present")
            .etag
            .expect("strong etag");
        assert_eq!(
            client
                .put_conditional("/note.md", b"stale", WritePrecondition::Match("\"stale\""))
                .await
                .expect("stale attempt"),
            PutOutcome::PreconditionFailed
        );
        assert_eq!(
            client
                .put_conditional("/note.md", b"second", WritePrecondition::Match(&etag))
                .await
                .expect("current etag"),
            PutOutcome::Applied
        );
    }

    #[tokio::test]
    async fn connection_test_probe_writes_reads_and_cleans_up() {
        let server = crate::webdav::client::test_support::TestDavServer::start(vec![]).await;
        let client = S3Client::new(&settings_for(&server.url)).expect("client");
        client
            .test_connection("/Zeditor")
            .await
            .expect("connection");

        let methods: Vec<String> = server
            .requests()
            .await
            .iter()
            .map(|request| request.method.clone())
            .collect();
        assert!(methods.contains(&"PUT".to_string()));
        assert!(methods.contains(&"GET".to_string()));
        assert!(methods.contains(&"DELETE".to_string()));
    }

    #[tokio::test]
    async fn client_can_be_used_as_remote_sync_client() {
        let server = crate::webdav::client::test_support::TestDavServer::start(vec![]).await;
        let client = crate::webdav::RemoteClient::S3(
            S3Client::new(&settings_for(&server.url)).expect("client"),
        );
        client.put("/note.md", b"data").await.expect("trait put");
        client.ensure_collection("/docs").await.expect("no-op");
        assert!(client
            .get_optional("/note.md")
            .await
            .expect("trait get")
            .is_some());
    }
}
