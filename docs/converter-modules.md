# Zeditor AnyDoc converter modules

Zeditor keeps document conversion separate from the desktop installer. The application downloads only the native AnyDoc module matching the current target, verifies it, and installs it below the application data directory.

## Supported targets

- `x86_64-pc-windows-msvc`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-unknown-linux-gnu`

The `converter-v1.3.0` tag matches `src-tauri/resources/converter_version.txt`. GitHub Actions builds the Rust `anydoc 0.2.4` executable on all four runners, verifies protocol 1 and `engine: anydoc`, then publishes four ZIP archives.

Supported input extensions are DOC, DOCX, DOCM, PPT, PPS, POT, PPTX, PPTM, PPSX, PPSM, XLS, XLSX, XLSM, XLSB, ODT, ODS, ODP, RTF, EPUB, CSV, and text-based PDF.

Image-only PDFs require a future OCR engine. Images, audio, Outlook MSG, JSON/XML feeds, ZIP, and Jupyter Notebook are not handled by this AnyDoc module.

## Release trust

The Windows converter is intentionally not Authenticode/SignPath-signed at this stage. This does not disable application-level integrity checks:

1. Each archive contains `module.json`, optional `module.sig`, and one native executable.
2. `module.sig` is an Ed25519 signature over the exact `module.json` bytes when signing is configured.
3. `module.json` contains the executable SHA-256 and `engine: anydoc`.
4. The stable channel manifest contains every archive SHA-256 and size.
5. Zeditor verifies all values and runs `--version-json` before activation.

## Local build

```powershell
cargo fetch --manifest-path converter/Cargo.toml --locked
cargo build --manifest-path converter/Cargo.toml --release --locked
```

Run `converter/target/release/document_converter --version-json` before packaging. For developer diagnostics, set `ANYDOC_CONVERTER_PATH` to a built executable; Zeditor does not search for Python or install Python dependencies.
