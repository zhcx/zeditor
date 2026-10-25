---
title: 真实 WebDAV / S3 集成测试
---

# 真实 WebDAV / S3 多设备并发集成测试

仓库中有 4 个默认忽略的端到端测试，直接连接真实 WebDAV 或 S3 兼容服务，验证多设备并发备份不会丢版本：

- `live_webdav_enforces_conditional_writes` / `live_s3_enforces_conditional_writes`
  - 探测服务器是否返回强 ETag，并真正执行 `If-Match` / `If-None-Match: *`；
  - 服务器若忽略条件头，测试会明确失败，而不是静默退化为后写覆盖。
- `live_webdav_two_devices_preserve_both_versions` / `live_s3_two_devices_preserve_both_versions`
  - 两个独立管理器（各自本地文件与队列）并发同步同一远端文档，共 3 轮；
  - 断言清单保留两个设备全部 6 个版本、每个快照内容与 SHA-256 一致；
  - 断言全局索引有效，并分别恢复两个设备写入的版本，逐字节比对本地文件。

这些测试需要真实服务，因此标记为 `#[ignore]`。未设置对应环境变量时，显式运行也会打印 `SKIP` 并正常退出。

## 运行命令

在 `src-tauri` 目录执行：

```powershell
# WebDAV
$env:ZEDITOR_LIVE_WEBDAV_URL = "https://dav.example.com/remote.php/dav/files/alice"
$env:ZEDITOR_LIVE_WEBDAV_USERNAME = "alice"
$env:ZEDITOR_LIVE_WEBDAV_PASSWORD = "<应用密码>"
cargo test live_webdav -- --ignored --nocapture

# S3 兼容存储
$env:ZEDITOR_LIVE_S3_ENDPOINT = "http://127.0.0.1:9000"
$env:ZEDITOR_LIVE_S3_BUCKET = "zeditor-test"
$env:ZEDITOR_LIVE_S3_ACCESS_KEY = "<access key>"
$env:ZEDITOR_LIVE_S3_SECRET_KEY = "<secret key>"
cargo test live_s3 -- --ignored --nocapture
```

### 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `ZEDITOR_LIVE_WEBDAV_URL` | 是 | WebDAV 服务地址，可包含基础子路径 |
| `ZEDITOR_LIVE_WEBDAV_USERNAME` | 否 | 留空为匿名访问 |
| `ZEDITOR_LIVE_WEBDAV_PASSWORD` | 否 | 保留首尾字符，不做 trim |
| `ZEDITOR_LIVE_WEBDAV_ROOT` | 否 | 测试根目录，默认 `/zeditor-live-tests` |
| `ZEDITOR_LIVE_S3_ENDPOINT` | 是 | 例如 `http://127.0.0.1:9000` |
| `ZEDITOR_LIVE_S3_BUCKET` | 是 | 必须预先存在，账号需有读写与删除权限 |
| `ZEDITOR_LIVE_S3_REGION` | 否 | 默认 `us-east-1` |
| `ZEDITOR_LIVE_S3_ACCESS_KEY` | 是 | 仅从环境变量读取 |
| `ZEDITOR_LIVE_S3_SECRET_KEY` | 是 | 仅从环境变量读取 |
| `ZEDITOR_LIVE_S3_PATH_STYLE` | 否 | 默认 `true`；AWS 虚拟主机风格设为 `false` |
| `ZEDITOR_LIVE_S3_ROOT` | 否 | 测试对象前缀，默认 `/zeditor-live-tests` |

每次运行都会在根目录下创建唯一的 `zeditor-live-<uuid>` 子目录，因此并行运行或多台机器共用同一账号时不会读到彼此历史。测试结束会尽力删除本次创建的对象/目录；异常中止时，残留内容也只会留在该唯一目录内。

## 服务器要求

- WebDAV：支持 `MKCOL`、`PUT`、`GET`、`DELETE`、`PROPFIND`，并为 `GET` 返回强 `ETag`；
- S3：支持 `PutObject` 的 `If-Match` / `If-None-Match`。本次已用 SeaweedFS 4.50 验证；AWS S3 官方文档确认支持，MinIO 文档亦声明支持（本次未实机验证）；
- 条件写探测失败时，不会把“服务器不支持”误报为通过；请换用支持条件写的服务后再运行并发用例。

## 本地自测

已用 WsgiDAV 4.4.0（Python 3.14）和 SeaweedFS 4.50 S3 网关验证全部 4 个用例。

WebDAV：

```powershell
python -m venv wsgidav-venv
.\wsgidav-venv\Scripts\python.exe -m pip install wsgidav cheroot
.\wsgidav-venv\Scripts\wsgidav.exe -H 127.0.0.1 -p 18080 -r .\wsgidav-data --auth anonymous --no-config
$env:ZEDITOR_LIVE_WEBDAV_URL = "http://127.0.0.1:18080"
cargo test live_webdav -- --ignored --nocapture
```

S3：从 SeaweedFS 官方 Release 下载 `windows_amd64.zip` 并校验 SHA-256，准备一个仅用于测试的 `s3-config.json`：

```json
{
  "identities": [
    {
      "name": "zeditor-live",
      "credentials": [{ "accessKey": "<test-access-key>", "secretKey": "<test-secret-key>" }],
      "actions": ["Admin", "Read", "List", "Write", "Tagging"]
    }
  ]
}
```

```powershell
.\weed.exe server -dir=.\data -ip=127.0.0.1 `
  -master.port=19333 -volume.port=19380 -filer.port=18888 `
  -s3 -s3.port=19000 -s3.config=.\s3-config.json -s3.autoCreateBucket

$env:ZEDITOR_LIVE_S3_ENDPOINT = "http://127.0.0.1:19000"
$env:ZEDITOR_LIVE_S3_BUCKET = "zeditor-test"
$env:ZEDITOR_LIVE_S3_ACCESS_KEY = "<test-access-key>"
$env:ZEDITOR_LIVE_S3_SECRET_KEY = "<test-secret-key>"
cargo test live_s3 -- --ignored --nocapture
```

`-s3.autoCreateBucket` 会在首次写入时创建测试桶；MinIO 等实现需要先手动建桶。也可以同时设置 WebDAV 与 S3 环境变量，一次运行全部 4 个用例：

```powershell
cargo test live_ -- --ignored --nocapture
```

::: warning 凭据
不要把真实凭据写入仓库、脚本或截图。测试只读取进程环境变量，错误信息不会输出 Access Key / Secret Key / 密码。
:::
