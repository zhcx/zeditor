# Privacy Policy

Last updated: August 21, 2026

Zeditor is a local-first desktop Markdown editor. The project maintainers do not operate an analytics, advertising, telemetry, or user-account service for the application. Your documents stay on your device unless you deliberately use a feature that sends selected data to a service you configure.

## Data processed locally

Zeditor reads and writes files that you open, create, convert, export, or select as workspace context. When Local Agent Beta is enabled, it also creates temporary Git worktrees and stores local session metadata and event history so that changes can be reviewed or resumed. Unapplied Agent worktrees remain until you apply or discard the session. Recent-file history, application preferences, and credentials entered in Settings are stored in the application's local configuration directory. Diagnostic crash messages may be appended to `zeditor_crash.log` in the operating system's temporary directory.

The application does not encrypt its settings file. Anyone or any software with access to your operating-system account may be able to read credentials saved there. Use restricted API keys and remove them from Settings when they are no longer needed.

## Optional third-party transfers

Zeditor contacts third parties only when you invoke or enable the corresponding feature:

- **AI providers:** prompts, selected text, document context, attached text or images, and model settings may be sent to the AI endpoint and provider selected by you. Supported providers and custom endpoints have their own privacy and retention terms.
- **Local Agent backends:** when you deliberately start an Agent task, Zeditor launches your locally installed Claude Code, Codex, OpenCode, or Pi CLI. The selected CLI may send prompts, workspace content, command output, and tool results to the model provider configured in that CLI, and may access the network. Zeditor reuses the CLI's authentication and does not copy its login credentials into Zeditor settings.
- **WebDAV / S3 backup:** when enabled, Zeditor sends the saved document content, its relative path within the workspace, timestamps, content hashes, and version manifests directly to the WebDAV server or S3-compatible object storage (AWS S3, Aliyun OSS, Tencent COS, MinIO, Cloudflare R2, ...) you configure. Credentials remain in the local application settings file and are never logged. The Zeditor maintainers do not receive this traffic.
- **Web search:** search queries and the configured credentials are sent to Tavily or to the SearXNG instance selected by you.
- **Image hosting:** images selected for upload and the required credentials or metadata are sent to Cloudinary, PicGo, an S3-compatible service, or another destination configured by you. Local image storage does not send the image to a remote hosting provider.
- **Document conversion:** AnyDoc conversion runs locally and does not upload document contents. Scanned-PDF OCR, image, audio, MSG, and Notebook conversion are not provided by the current module.
- **Update checks and downloads:** when you check for updates or download one, the application contacts GitHub Releases. GitHub receives normal connection information such as your IP address and user agent.

The Zeditor maintainers do not receive the content transferred directly between your installation and these user-selected services. Those services process data under their own policies. Review their terms before sending confidential or personal information.

## Collection, sale, and retention

The project maintainers do not collect or sell personal information through Zeditor and therefore do not retain application content on a maintainer-controlled server. Locally stored data remains until you edit or delete it, uninstall the application and remove its data directory, or the operating system removes temporary files. Third-party retention is controlled by the provider you selected.

## Security and choices

You control whether AI, Local Agent Beta, web search, image upload, and update features are used. Agent commands, network access, and MCP tools use tiered approval by default. “Allow all for this session” suppresses those prompts only for the current in-memory session; workspace isolation, external-path restrictions, and the Git push prohibition remain active. You can avoid third-party transfers by leaving these integrations disabled, using local image storage, and not checking for or downloading updates from within the application. Before sharing logs in an issue, inspect and redact any sensitive paths or content.

Official Windows release signatures and build provenance are described in the [Code Signing Policy](CODE_SIGNING_POLICY.md).

## Changes and contact

Material changes to this policy will be committed to the public repository with an updated date. Questions or privacy reports may be submitted through the project's [GitHub Issues](https://github.com/zhcx/markitdown/issues). Do not include secrets or private document content in a public issue.
