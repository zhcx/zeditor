# Windows code signing with SignPath

The release workflow is ready for SignPath Foundation's GitHub integration. It remains in an explicit unsigned fallback mode until the application is approved and every required repository value is configured.

## Architecture

Windows signing is intentionally split into two requests:

1. Build `zeditor.exe`; upload it as a GitHub Actions artifact; request manual SignPath approval and signing.
2. Replace the local application executable with the signed copy, build MSI and NSIS installers, upload the installers as another GitHub Actions artifact, and request manual SignPath approval and signing.
3. Verify Authenticode signatures and publish only the returned installer files. When SignPath settings are absent, the workflow publishes the generated installers without signatures and emits a prominent warning.

This structure ensures that both the installed executables and their outer installers can be signed. The pre-sign artifacts exist on GitHub before each request, and every build job upstream of the requests uses a GitHub-hosted runner.

## GitHub configuration after approval

Create one Actions secret:

- `SIGNPATH_API_TOKEN`

Create these Actions variables:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_EXECUTABLES_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_INSTALLERS_ARTIFACT_CONFIGURATION_SLUG`

The two artifact configurations should accept the default ZIP artifact created by `actions/upload-artifact@v7`:

- Executable configuration: `zeditor.exe`.
- Installer configuration: one `.msi` and one NSIS `.exe`, both Authenticode-signed.

Do not add placeholder or partial values. The workflow enables signing only when all six values are present; otherwise it takes the unsigned fallback path.

Install the SignPath GitHub App as instructed by SignPath and link the repository to the SignPath project. Configure the signing policy for manual approval, restrict the project to GitHub's trusted build system, and require GitHub-hosted runners.

## Optional converter module

The document converter is no longer bundled into the MSI or NSIS installer. It is built by the separate converter workflow and installed on demand into the application data directory. The Windows converter module is deliberately outside the SignPath flow for now; its signed module metadata and SHA-256 are still mandatory before activation. See [converter-modules.md](converter-modules.md).

## Verification

The workflow verifies returned files before upload. A release can also be checked manually:

```powershell
Get-AuthenticodeSignature .\Zeditor_0.3.7_x64-setup.exe |
  Format-List Status,SignerCertificate,TimeStamperCertificate
```

For a SignPath-signed build, the result must be `Valid`, the signer subject must contain `SignPath Foundation`, and a timestamp certificate must be present. See the repository's [Code Signing Policy](https://github.com/zhcx/zeditor/blob/main/CODE_SIGNING_POLICY.md) for governance and incident handling.
