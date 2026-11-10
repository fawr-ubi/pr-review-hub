# PR Review Hub & `my-review` Agent (`v1.2.0`)

Zero-dependency local web cockpit (`http://localhost:4242`) and continuously learning AI code review agent (`my-review`) for GitHub Pull Requests. Built to scale across **any GitHub account, any GitHub organization, and multiple engineering teams** with dedicated team agent profiles, layered review rules, and human-in-the-loop GitHub publishing.

> **100% Human-in-the-Loop Guarantee:** The AI agent and background sync **never** auto-publish comments or reviews to GitHub. Every inline comment, reply, or review submission happens only when you explicitly click a button in the UI.

---

## ⚡ 1-Command Zero-Config Quick Start (< 30 Seconds)

You don't need `npm install` (zero external dependencies) or manual configuration files. Just make sure `node`, `gh`, `jq`, and an AI CLI (`gemini` or `claude`) are installed:

### 1. Prerequisites (macOS / Linux)

```bash
# 1. Core CLI tools (Node.js >= 18, GitHub CLI, jq)
brew install node gh jq

# 2. Authenticate GitHub CLI (if not already logged in)
gh auth status || gh auth login

# 3. AI Agent CLI: Antigravity CLI (`agy`), Gemini CLI (`gemini`), or Claude Code CLI (`claude`)
# PR Review Hub auto-detects whichever one is installed on your Mac (prioritizing `agy` -> `gemini` -> `claude`):
which agy || which gemini || which claude
```

---

### 2. Clone & Start Immediately (Zero-Config Auto-Setup)

Copy-paste this single block in your terminal:

```bash
gh repo clone fawr-ubi/pr-review-hub ~/.gemini/config/skills/my-review && \
cd ~/.gemini/config/skills/my-review && \
npm start
```

*(Alternative if you prefer `git clone`: `git clone https://github.com/fawr-ubi/pr-review-hub.git ~/.gemini/config/skills/my-review`)*

Then open **[http://localhost:4242](http://localhost:4242)** in your browser!

#### What happens automatically on your very first `npm start`?
- **Auto-bootstraps `config.json`** by querying your GitHub login (`gh api user`) and your GitHub teams (`gh api user/teams`).
- **Auto-detects your local workspace** (`~/Ubitransport/projects`, `~/projects`, etc.) and your installed AI CLI (**`agy`** Antigravity CLI, **`gemini`** Gemini CLI, or **`claude`** Claude Code CLI, including `~/.local/bin`, Homebrew, and NVM paths).
- **Initializes your 4-layer engineering rules** (`Common DNA` + `Team DNA` + local personal rules) and **auto-syncs your open Pull Requests** on first browser load.
- **Works even without local repo clones**: When you click **`Run Review`** or **`Review All`**, the server fetches the PR diff and metadata directly from GitHub (`gh pr diff`) and streams it to the AI agent (`agy`, `gemini`, or `claude`) with your team's rules and review checklist embedded.

---

### 3. Optional: Interactive Setup & macOS Finder Launcher (`./install.sh`)

If you want to customize your **Team Agent Profile** interactively (`popcorn-back`, `frontend-web`, `mobile-kotlin`, `qa-automation`), mine 1 year of your team's GitHub PR review comments, and create a double-clickable **`Open Review Hub.command`** launcher on your Mac:

```bash
cd ~/.gemini/config/skills/my-review
npm run setup   # or ./install.sh
```

---

## 🩺 Troubleshooting AI Reviews (`Doctor` Check)

If clicking **`Run Review`** or **`Review All`** does not generate a review on a colleague's machine, run the built-in **Doctor** check (either by clicking **`Doctor`** in the top-right header of the web UI, or in your terminal):

```bash
cd ~/.gemini/config/skills/my-review
npm run doctor
```

It verifies all 6 required components in 2 seconds:
1. **`node` (>= 18)**
2. **`gh` CLI & Auth** (`gh auth status`)
3. **`jq` binary** (used by `scripts/sync-queue.sh`)
4. **AI Agent CLI (`agy`, `gemini`, or `claude`)**:
   - Auto-detects **`agy`** (Antigravity CLI), **`gemini`** (Gemini CLI), or **`claude`** (Claude Code CLI) with automatic fallback if one is missing.
   - You can also switch your preferred runner anytime in **`Settings (⚙)`**.
5. **Local Projects Workspace (`projectsDir`)**
6. **Reviews Storage Directory (`reviewsDir`)**

---

## 🧭 5-Minute Tour (Getting Started)

### Step 1 — Your Pull Request Queue (`All PRs`)
- When you open `http://localhost:4242`, the full-page queue displays all open PRs where your review (or your team's review) is requested, plus PRs you authored (`Self-Review`).
- **Draft PRs** are isolated in the **`Draft`** tab so they never clutter your actionable queue.
- Each row shows **CODEOWNERS** team readiness (`Mergeable` vs `Waiting approval: <team>`), CI status, diff size (`+additions / -deletions`), and AI audit verdict.
- Click **`Sync GitHub`** to refresh the queue from GitHub, or **`Review All`** to launch AI audits in the background on all pending PRs.

### Step 2 — The 5-Tab PR Review Cockpit
Click any PR (or press `j`/`k` + `Enter`) to open the review workspace:

1. **`1. Audit Report` (`1`)**: Executive summary card, Mermaid architecture diagrams, and structured finding cards (`🔴 Blocker`, `🟠 Major`, `🟡 Minor`, `🔵 Nitpick`) with clickable file/line links.
2. **`2. Description & Conversation` (`2`)**: Full PR description, chronological commit list, and GitHub review threads (reply to a thread, resolve/reopen, or jump to the exact diff line).
3. **`3. Git Diff` (`3`)**:
   - Collapsible file tree (`b`) with status badges (`M`, `A`, `D`, `R`) and finding counters.
   - On-demand context expansion (`↑ 20`, `↓ 20`, `All`) when you need to read code outside the diff hunks.
   - **Single-line or Multi-line Inline Comments**: Click `+` on any line, or **click-and-drag across multiple line numbers** to open the inline comment composer immediately on mouse release.
   - **Full-Screen Focus Diff (`z`)**: Hides all topbars for 100% vertical code reading.
4. **`4. AI Proposals` (`4`)**: Review, edit, or dismiss AI-generated and manual inline comments before publishing them to GitHub.
5. **`5. Agent Rules` (`5`)**: Manage the 4-layer rule engine (`Common DNA`, `Team DNA`, `Local DNA`, `False Positives`, and `Candidates`).

> **Tip — Side-by-Side Split View (`s`)**: Press `s` (or click `Split (s)`) to display any two tabs side by side (e.g. `1. Audit Report` on the left + `3. Git Diff` on the right). `Shift+Click` any tab to open it in the right-hand pane.

### Step 3 — Ask the Agent or Teach It (`Agent Q&A` & `False Positives`)
- Click **`Agent Q&A (c)`** on the top bar (or **`Ask Agent`** on any finding) to ask questions about the PR code.
- If an AI finding is a false positive or an intentional project convention, click **`False Positive`** on the finding card: the agent records the exception in your `false-positives.local.md` and will never repeat that remark on future PRs.

### Step 4 — Publish Your Review to GitHub (`Submit Review (m)`)
- Click **`Submit Review (m)`** to open the publication modal:
  - Choose `Approve`, `Request Changes`, or `Comment`,
  - Select which inline comments to include,
  - Or click **`Create Pending Review`** to stage your comments as a draft review on GitHub first.

---

## 💬 Sharing Your Testing REX (Feedback) & Updating

While testing PR Review Hub on your daily PRs:

1. **Log Feedback In-App (`Feedback / REX` button)**:
   - Click **`Feedback / REX`** in the top header (or inside any PR) whenever you spot a bug, a UX improvement, an AI false positive, or a missing team rule.
   - Click **`Copy REX Markdown for Slack`** to copy a formatted Markdown report (including your app version, active team profile, and notes) ready to paste in Slack/Teams, or click **`Open GitHub Issue`**.
2. **1-Click In-App Updates (`Update`)**:
   - When new fixes or features are pushed to `main`, an **`Update (N)`** button automatically appears next to the version badge in the top-left header. Click it to pull the latest version and reload in one click.
   - Or from the terminal: `cd ~/.gemini/config/skills/my-review && git pull`.
3. **Environment Diagnostics (`Doctor`)**:
   - Click **`Doctor`** in the top-right header (or inside **`Settings`**) to view the live **Environment Health Check**, or run `npm run doctor`.

---

## 🏢 Multi-Team Architecture & Adding Your Team

Each engineering team has its own versioned Agent Profile and Team DNA without ever conflicting with colleagues' personal settings:

```text
pr-review-hub/
├── SKILL.md                          # Core AI Review Agent instructions (Modes 1–4)
├── package.json                      # Zero-dependency ESM scripts (start, test, sync, doctor, package, setup)
├── install.sh                        # Interactive 1-minute onboarding CLI
├── references/
│   ├── common-dna.md                 # Layer 1: Versioned organization-wide engineering baseline
│   ├── review-checklist.md           # Systematic multi-layer checklist injected into every AI review
│   ├── review-artifact-template.md   # Standardized Markdown report structure for AI reviews
│   ├── teams/                        # Layer 2: Versioned per-team Agent Profiles & Team DNA packs
│   │   ├── popcorn-back/             #   ├── PHP 8.3 / Symfony / API Platform / 2cloud backend profile
│   │   ├── frontend-web/             #   ├── TypeScript / Vue 3 / Angular frontend profile
│   │   ├── mobile-kotlin/            #   ├── Android / Kotlin / Clean Architecture mobile profile
│   │   └── qa-automation/            #   └── Cypress / TypeScript / Behat QA profile
│   ├── reviewer-dna.local.md         # Layer 3: Personal local rules (gitignored, zero merge conflicts)
│   ├── false-positives.local.md      # Layer 3: Personal false-positive exceptions (gitignored)
│   └── candidate-rules.local.json    # Layer 4: Candidate rules mined from 1-year GitHub PR history
└── ui/                               # Local HTTP server & 5-tab Web UI
```

### How to Create or Customize a Team Profile:
1. Go to tab **`5. Agent Rules`** in the UI (`http://localhost:4242`).
2. Click **`+ New Team Profile`** (or **`Configure Team Agent`** on the banner):
   - Set your team slug (e.g. `moneris-back`), display name, tech stack tags, watched GitHub teams, and custom instructions for the AI review agent.
3. Click **`Scan Team PRs (1y)`** to analyze the last 365 days of your team's GitHub PR review comments and approve the best rules directly into **`Team DNA`** (`references/teams/<team-id>/team-dna.md`).
4. Commit and push `references/teams/<team-id>/` so every teammate inherits the profile on `git pull`.

---

## ⌨️ Keyboard Shortcuts (`?` in UI)

Every shortcut can be customized by clicking **`? Keyboard Shortcuts`** in the bottom-right footer:

| Default Key | Action |
| :--- | :--- |
| `j` / `k` | Next / Previous PR in the queue |
| `Enter` | Open selected PR |
| `q` | Return to full-page PR Queue (`All PRs`) |
| `1` — `5` | Switch tabs (`1. Audit Report` .. `5. Agent Rules`) |
| `←` / `→` (or `h` / `l`) | Previous / Next modified file in `3. Git Diff` |
| `n` / `p` | Next / Previous Hunk or Finding |
| `-` / `+` / `0` | Zoom out / Zoom in / Reset zoom (`100%`) in `3. Git Diff` |
| `b` | Show / Hide modified files sidebar in `3. Git Diff` |
| `z` or `f` / `Esc` | Toggle Full-Screen Focus Diff (`100%` viewport) |
| `s` | Toggle side-by-side Split View (`Report + Diff`) |
| `r` | Run / Re-run AI Review on current PR |
| `c` | Toggle AI Agent Q&A / Mode 2 Debrief drawer |
| `o` | Open synchronized Pop-out Diff window |
| `g` | Open current PR on GitHub |
| `m` | Open `Submit Review` modal |
| `/` | Focus PR search bar |
| `?` | Open customizable Keyboard Shortcuts modal |

---

## 🧪 Useful CLI Commands

```bash
npm start        # Start PR Review Hub on http://localhost:4242 (auto-bootstraps config on first run)
npm run setup    # Run interactive ./install.sh wizard
npm run doctor   # Run environment & AI CLI health checks
npm run sync     # Scan GitHub PR queue via scripts/sync-queue.sh
npm test         # Run the unit & E2E test suite
npm run package  # Build a clean pr-review-hub-shareable.zip archive
```
