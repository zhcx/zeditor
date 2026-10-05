//! S3-compatible object storage client with hand-written AWS SigV4 signing.

use chrono::Utc;
use reqwest::StatusCode;

use super::client::{sanitize_webdav_error, RemoteSyncClient};
use super::model::S3Settings;
use super::sigv4::{
    authorization, payload_hash, SigningContext, EMPTY_PAYLOAD_HASH, SIGNED_HEADERS,
};

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
        let uri = if parsed.path().is_empty() {
            "/".to_string()
        } else {
            parsed.path().to_string()
        };

        let canonical_headers = format!(
            "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
            host, hash, timestamp
        );
        let auth = authorization(&SigningContext {
            method: method.as_str(),
            uri: &uri,
            canonical_headers: &canonical_headers,
            signed_headers: SIGNED_HEADERS,
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

    async fn get_optional(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
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
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read S3 response: {error}"))?;
        Ok(Some(bytes.to_vec()))
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
