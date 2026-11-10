# Changelog

All notable changes to **PR Review Hub (`my-review`)** are documented in this file.

## [1.1.0] - 2026-11-09

### Added
- **Multi-Team Agent Profiles & 4-Layer Rule Architecture (`references/teams/<team-id>/`)**:
  - Added versioned per-team profile packs (`profile.json` + `team-dna.md`) so multiple engineering teams (`popcorn-back`, `frontend-web`, `mobile-kotlin`, `qa-automation`, or custom teams) can maintain their own tech stack, AI agent instructions, and team review rules in Git without conflicts.
  - Added `GET /api/teams/profiles` and `POST /api/teams/profiles` endpoints plus an interactive **Active Team Agent** bar and **+ New Team Profile** creator in Tab `5. Agent Rules`.
  - Added configurable AI Agent CLI runner (`gemini` or `claude`) in `config.json` and Settings.
- **Tab 2 (`2. Description & Conversation`) & GitHub Review Threads**:
  - Full PR description rendering, chronological commit history, and GitHub conversation / review threads with inline replies, thread resolution/reopening, and 1-click jump to diff lines.
- **Interactive Multi-Line Inline Comments & CODEOWNERS Merge Readiness**:
  - Click or drag across line numbers in `3. Git Diff` to write multi-line comments, save drafts to `4. AI Proposals`, publish directly to GitHub, or open targeted Agent Q&A.
  - Automatic `CODEOWNERS` parsing and real-time team approval / mergeability status badges.
- **Hybrid Disk + Client Pre-Fetching & Instant Navigation**:
  - Background server disk cache warming (`warmOpenPrCachesInBackground`) and client-side hover/queue pre-fetching (`prefetchPrData`) for instant PR switching (`0ms` tab transitions).
- **Customizable Keyboard Shortcuts & Compact 100% English UI**:
  - Full English localization across UI, server, parsers, and CLI installer.
  - Customizable keyboard shortcuts modal (`?`) with visible keybind hints on topbar and diff action buttons.
  - Isolated `Draft` PRs into their dedicated `Draft` queue filter tab.

## [1.0.0] - 2026-11-06

### Added
- **Multi-Account & Multi-Team Architecture**:
  - Dynamic GitHub user and team auto-discovery via `gh api user` and `gh api user/teams` (`GET /api/github/teams`).
  - Configurable `githubUser`, `githubOrg`, `githubTeams`, `projectsDir`, `reviewsDir`, `jiraBaseUrl`, and `jiraPrefixes` in `config.json` and the UI Settings modal.
- **3-Tier Rule Engine & 1-Year Team PR History Onboarding**:
  - Separated rules into versioned cross-team `references/common-dna.md` and gitignored local `references/reviewer-dna.local.md` + `references/false-positives.local.md` to prevent Git conflicts on `git pull`.
  - Added `POST /api/rules/bootstrap` (`ui/lib/onboarding.mjs`) to analyze the last 365 days of team & personal GitHub PR review comments and synthesize candidate rules into `references/candidate-rules.local.json`.
- **Full-Screen Focus Diff, Sticky Diff Header & Diff Code Zoom**:
  - Added `.app-shell.focus-diff-mode` (`z` / `f` / `Esc`) hiding topbars, sidebars, and tabs so the diff fills 100% of the viewport.
- **Zero-Disk Working Tree Explorer & On-Demand Worktrees**:
  - Inspect full files (`git show`), directories (`git ls-tree`), and search (`git grep`) at exact PR commit SHAs, or mount physical worktrees with APFS Copy-on-Write `vendor/` cloning.
