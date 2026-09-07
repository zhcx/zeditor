import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('application and converter version sources stay synchronized', () => {
  const packageJson = JSON.parse(read('package.json'))
  const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))
  const cargoVersion = read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1]
  const converterProjectVersion = read('converter/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1]
  const converterResourceVersion = read('src-tauri/resources/converter_version.txt').trim()

  assert.equal(packageJson.name, 'zeditor')
  assert.equal(packageJson.version, '0.4.5')
  assert.equal(tauriConfig.version, packageJson.version)
  assert.equal(tauriConfig.productName, 'Zeditor')
  assert.equal(tauriConfig.identifier, 'com.zeditor.desktop')
  assert.equal(cargoVersion, packageJson.version)
  assert.equal(converterProjectVersion, '1.2.0')
  assert.equal(converterResourceVersion, converterProjectVersion)
})

test('repository publishes an actual MIT license and privacy policy', () => {
  const license = read('LICENSE')
  const privacy = read('PRIVACY.md')

  assert.match(license, /^MIT License/m)
  assert.match(license, /Permission is hereby granted, free of charge/)
  assert.match(license, /Copyright \(c\) 2026 zhcx/)
  assert.match(privacy, /local-first/i)
  assert.match(privacy, /AI provider/i)
  assert.match(privacy, /image hosting/i)
  assert.match(privacy, /update checks/i)
})

test('code signing policy contains SignPath attribution, roles, privacy, and build provenance', () => {
  const policy = read('CODE_SIGNING_POLICY.md')
  const readme = read('README.md')

  assert.match(policy, /Free code signing provided by SignPath\.io, certificate by SignPath Foundation/)
  assert.match(policy, /Committers and reviewers/i)
  assert.match(policy, /Approvers/i)
  assert.match(policy, /manual approval/i)
  assert.match(policy, /PRIVACY\.md/)
  assert.match(policy, /GitHub-hosted/i)
  assert.match(readme, /Code signing policy/i)
  assert.match(readme, /CODE_SIGNING_POLICY\.md/)
  assert.match(readme, /PRIVACY\.md/)
})

test('document converter is an optional cross-platform module with a frozen dependency set', () => {
  const lock = read('converter/Cargo.lock')
  const project = read('converter/Cargo.toml')
  const workflow = read('.github/workflows/converter.yml')
  const ignore = read('.gitignore')
  const baseConfig = JSON.parse(read('src-tauri/tauri.conf.json'))
  const windowsConfig = JSON.parse(read('src-tauri/tauri.windows.conf.json'))

  assert.match(project, /name = "zeditor-document-converter"/i)
  assert.match(project, /anydoc/i)
  assert.match(lock, /name = "anydoc"/i)
  assert.match(workflow, /cargo build --manifest-path converter\/Cargo.toml --release --locked/)
  assert.match(workflow, /x86_64-pc-windows-msvc/)
  assert.match(workflow, /x86_64-apple-darwin/)
  assert.match(workflow, /aarch64-apple-darwin/)
  assert.match(workflow, /x86_64-unknown-linux-gnu/)
  assert.doesNotMatch(workflow, /signpath/i)
  assert.match(ignore, /src-tauri\/resources\/document_converter\.exe/)
  assert.ok(!baseConfig.bundle.resources.includes('resources/document_converter.exe'))
  assert.ok(!windowsConfig.bundle.resources.includes('resources/document_converter.exe'))
  assert.ok(existsSync('converter/src/main.rs'))
  assert.ok(!existsSync('src-tauri/resources/document_converter.py'))
})

test('Windows release workflow reserves both SignPath signing stages', () => {
  const workflow = read('.github/workflows/build.yml')

  assert.match(workflow, /tauri build.*--no-bundle/i)
  assert.match(workflow, /tauri bundle/i)
  assert.ok((workflow.match(/actions\/upload-artifact@v7/g) ?? []).length >= 2)
  assert.ok((workflow.match(/signpath\/github-action-submit-signing-request@v2/g) ?? []).length >= 2)
  assert.match(workflow, /SIGNPATH_EXECUTABLES_ARTIFACT_CONFIGURATION_SLUG/)
  assert.match(workflow, /SIGNPATH_INSTALLERS_ARTIFACT_CONFIGURATION_SLUG/)
  assert.match(workflow, /wait-for-completion: true/)
  assert.match(workflow, /manual approval/i)
})

test('release builds wait for the locked quality gate', () => {
  const workflow = read('.github/workflows/build.yml')
  const packageJson = JSON.parse(read('package.json'))

  assert.match(workflow, /quality-checks:/)
  assert.match(workflow, /needs: quality-checks/)
  assert.match(workflow, /npm ci/)
  assert.match(workflow, /npm run lint/)
  assert.match(workflow, /npm audit --audit-level=high/)
  assert.doesNotMatch(workflow, /document_converter\.exe/)
  assert.match(workflow, /cargo fmt --check/)
  assert.match(workflow, /cargo clippy --locked --all-targets -- -D warnings/)
  assert.match(workflow, /cargo test --locked/)
  assert.ok((workflow.match(/node-version: '22'/g) ?? []).length >= 3)
  assert.equal(packageJson.engines.node, '>=22.6.0')
})

test('SignPath application copy contains the confirmed applicant details and no placeholders', () => {
  const application = read('docs/signpath-foundation-application.md')

  assert.match(application, /https:\/\/github\.com\/zhcx\/markitdown/)
  assert.match(application, /MIT License/)
  assert.match(application, /GitHub Actions/)
  assert.match(application, /SignPath Foundation/)
  assert.match(application, /Zhang Changxin/)
  assert.match(application, /zhcx@live\.com/)
  assert.doesNotMatch(application, /Applicant must fill|\[APPLICANT/i)
})
