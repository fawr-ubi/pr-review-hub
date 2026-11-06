# PR Review Hub (`my-review` — v1.0.0)

Zero-dependency local web cockpit (`http://localhost:4242`) and continuously learning AI code review skill (`my-review`) for GitHub Pull Requests. Built to work across **any GitHub account, any GitHub organization, and any engineering team**.

---

## Key Features

1. **Multi-Account & Multi-Team PR Queue Discovery (`scripts/sync-queue.sh`)**
   - Automatically discovers your GitHub login (`gh api user`) and your GitHub team memberships (`gh api user/teams`).
   - Scans open PRs where review is requested from you or your configured teams, PRs you already reviewed, and your own PRs (`Self-Review` vs `Peer-Review`).
   - Tracks commit SHAs (`NEEDS_REVIEW`, `NEEDS_UPDATE`, `UP_TO_DATE`), detects stacked PRs, and archives merged/closed PR reviews automatically.
2. **Keyboard-First Web Cockpit (`http://localhost:4242`)**
   - **1. Audit Report**: Executive summary card (`Task Summary & Functional Problem Solved` + `Incremental Update`), interactive Mermaid architecture diagrams, and structured finding cards.
   - **2. Ready-to-Post Comments**: Editable Markdown comments with 1-click copy, inline/general GitHub publishing, `+ Rule` extraction, and `False Positive` dismissal.
   - **3. Integrated Diff Viewer & Full-Screen Focus Diff (`z` / `f` / `Esc`)**:
     - Sticky file navigation bar that remains visible while scrolling long diffs.
     - Keyboard file switching (`←` / `→` or `h` / `l`), hunk/finding jumping (`n` / `p`), quick file jump selector (`g`), and **Diff Code Zoom (`-` / `+` / `0`)** from `60%` to `180%`.
   - **4. Zero-Disk Working Tree Explorer & On-Demand Git Worktree**:
     - Browse any file or run `git grep` at the exact PR commit SHA without checking out a branch, or mount an isolated worktree (with APFS Copy-on-Write `vendor/` cloning) and open directly in **PhpStorm** (`i`) or **VS Code**.
   - **5. 3-Tier Agent Rules & 1-Year Team PR History Onboarding**:
     - **Tier 1 (`references/common-dna.md`)**: Versioned cross-team engineering base (SOLID, Security, Clean Code, Testing).
     - **Tier 2 (`references/reviewer-dna.local.md` & `references/false-positives.local.md`)**: Gitignored local/team rules so `git pull` never causes merge conflicts.
     - **Tier 3 (`references/candidate-rules.local.json`)**: 1-click analyzer (`Analyser PRs Équipe (1 an)`) that mines the last **365 days** of your team's GitHub PR review comments and proposes candidate rules that you **validate or reject** before activation.
3. **100% Human-in-the-Loop Safety**
   - Never auto-publishes comments to GitHub without explicit user confirmation in the UI modal.

---

## Quick Installation

### Prerequisites
- macOS or Linux with **Node.js >= 18**
- **GitHub CLI (`gh`)** authenticated (`gh auth status`)
- **jq** (`brew install jq`)

### Install via Git Clone (Recommended)
```bash
git clone git@github.com:fawr-ubi/pr-review-hub.git ~/.gemini/config/skills/my-review
cd ~/.gemini/config/skills/my-review
./install.sh
```

Then start the server:
```bash
node ~/.gemini/config/skills/my-review/ui/server.mjs
```
And open **[http://localhost:4242](http://localhost:4242)**.

---

## Keyboard Shortcuts (`?` in UI)

| Shortcut | Action |
| :--- | :--- |
| `←` / `→` (or `h` / `l`) | Previous / Next modified file in Diff |
| `↑` / `↓` / `PageUp` / `PageDown` | Scroll active diff or report panel |
| `-` / `+` (or `=`) / `0` | Zoom out / Zoom in / Reset zoom (`100%`) in Diff & Code |
| `n` / `p` | Next / Previous Hunk or Finding |
| `z` or `f` / `Esc` | Toggle Full-Screen Focus Diff (`100%` viewport) |
| `g` | Focus quick file jump selector |
| `j` / `k` | Next / Previous PR in queue |
| `1` — `5` | Switch tabs (Audit, Comments, Diff, Working Tree, Agent Rules) |
| `[` / `]` | Collapse/Expand PR sidebar / Modified files sidebar |
| `t` | Switch current file between Git Diff and Working Tree |
| `i` | Open current file & line in PhpStorm |
| `s` / `o` | Split-screen mode / Pop-out secondary window |
| `c` / `r` / `m` | Agent Q&A Drawer / Re-run AI Review / Publish Review Modal |

---

## Automated Tests

Run the built-in unit & E2E test suite (`node:test`):
```bash
node --test ui/tests/hub.test.mjs
```
