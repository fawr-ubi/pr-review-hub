# Changelog

All notable changes to **PR Review Hub (`my-review`)** are documented in this file.

## [1.0.0] - 2026-11-06

### Added
- **Multi-Account & Multi-Team Architecture**:
  - Dynamic GitHub user and team auto-discovery via `gh api user` and `gh api user/teams` (`GET /api/github/teams`).
  - Configurable `githubUser`, `githubOrg`, `githubTeams`, `projectsDir`, `reviewsDir`, `jiraBaseUrl`, and `jiraPrefixes` in `config.json` and the UI Settings modal.
- **3-Tier Rule Engine & 1-Year Team PR History Onboarding**:
  - Separated rules into versioned cross-team `references/common-dna.md` and gitignored local `references/reviewer-dna.local.md` + `references/false-positives.local.md` to prevent Git conflicts on `git pull`.
  - Added `POST /api/rules/bootstrap` (`ui/lib/onboarding.mjs`) to analyze the last 365 days of team & personal GitHub PR review comments and synthesize candidate rules into `references/candidate-rules.local.json`.
  - Added `À valider` candidate rule workflow (`POST /api/rules/candidates/decision`) in Tab 5 (`Règles Agent`) to validate into Local DNA, validate into Common DNA, edit, or reject proposed rules.
- **Full-Screen Focus Diff, Sticky Diff Header & Diff Code Zoom**:
  - Added `.app-shell.focus-diff-mode` (`z` / `f` / `Esc`) hiding topbars, sidebars, and tabs so the diff fills 100% of the viewport.
  - Added sticky `.diff-file-header` above `#diffScrollArea` with `←` / `→` file navigation, `n` / `p` hunk jumping, quick file selector (`g`), and `-` / `+` / `0` code zoom (`60%` to `180%`).
- **Zero-Disk Working Tree Explorer & On-Demand Worktrees**:
  - Inspect full files (`git show`), directories (`git ls-tree`), and search (`git grep`) at exact PR commit SHAs, or mount physical worktrees with APFS Copy-on-Write `vendor/` cloning.
