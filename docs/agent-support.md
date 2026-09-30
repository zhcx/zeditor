# Local Agent Beta

Zeditor Desktop can run Claude Code, Codex, OpenCode, or Pi from the AI side panel. This is separate from the API-based AI features: translation, proofreading, companion writing, and ordinary AI chat continue to use the provider configured in AI Settings.

## Requirements

- Install and sign in to at least one supported CLI: `claude`, `codex`, `opencode`, or `pi`.
- Open the directory you want to use as the Zeditor workspace. Git repository roots use isolated worktrees; other directories require explicit session authorization and are edited directly.
- Enable **Local Agent (Beta)** under **Settings → AI Assistant**, then run environment detection.
- Leave executable, model, and profile fields empty to reuse the CLI defaults.

Zeditor checks for the structured streaming and approval interfaces it needs. A CLI that is installed but too old is reported as incompatible instead of being launched with reduced safety.

## Isolation and applying changes

Each new Agent session creates a detached temporary Git worktree. Current tracked edits and untracked files are copied into a private baseline commit, so the Agent sees the user's current workspace without mixing those edits into the Agent result.

At the end of a turn, Zeditor compares the worktree with that baseline. Changes can be applied by file. Before applying, Zeditor checks that the corresponding original files have not changed since the session started. A conflict stops the operation without overwriting the newer content.

Applied files are removed from the pending change set. Discarding a session removes its temporary worktree and local event history. Git repository roots use this isolated review flow. Other opened directories are authorized as the session root and edited directly, while external paths and Git push remain blocked.

## Approval modes

Tiered approval is the default:

- Reads inside the isolated workspace and file edits inside the worktree are allowed.
- Shell commands, network access, and MCP tools ask for approval.
- External paths and `git push` are blocked.

An approval card offers one-time approval, approval for the same action type during the session, complete approval for the current session, or rejection. Complete approval auto-accepts later command, network, and MCP requests, but does not remove worktree isolation or hard-deny rules.

Complete approval exists only in memory. Restarting Zeditor, creating a new session, or restoring a previous session returns to tiered approval. It can also be disabled immediately from the Agent panel; operations already running are not retroactively interrupted.

### Backend differences

Approval coverage depends on what the CLI exposes:

- **Claude Code** asks for every Bash, Write/Edit, WebFetch/WebSearch, and MCP call through a `PreToolUse` hook.
- **Codex** forwards its app-server approval requests into the same cards.
- **OpenCode** uses its `permission.asked` events.
- **Pi** has **no per-tool approval**. Once the workspace is trusted it runs commands and edits on its own, so tiered approval cannot intercept them and the hard-deny rules for external paths and `git push` do not apply. Worktree isolation plus review-before-apply stay in effect, and Pi extension prompts (`select` / `confirm`) are still surfaced as approval cards.

Because Pi runs autonomously, treat its sessions the same way you would treat a fully approved Claude Code session: review the pending change set before applying it.

## Local data

Session metadata, normalized events, and unapplied worktrees are stored below Zeditor's application data directory. CLI authentication remains owned by the CLI. Zeditor does not inject API keys from its ordinary AI provider settings into Agent processes.
