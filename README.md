# PR Review Hub & `my-review` Agent (`v1.3.0`)

Zero-dependency local web cockpit (`http://localhost:4242`), **Multi-Domain `/100` PR Scoring Engine** (5 specialized agents), and continuously learning AI code review agent (`my-review`) for GitHub Pull Requests. Built to scale across **any GitHub account, any GitHub organization, and multiple engineering squads** (`Popcorn`, `Pili`, `Banana`, `Papaya`, `Frontend Web`, `Mobile Kotlin`, `QA Automation`) with layered review rules, `ubitransports/wanreview` compatibility, and 100% human-in-the-loop GitHub publishing.

> **100% Human-in-the-Loop & Zero Background Token Burn by Default:** The AI agent **never** auto-publishes comments or reviews to GitHub. New teammate installs default to **Standalone / Reader Mode** (`0` background token burn — AI reviews only run when you explicitly click `Run Review`).

---

## ⚡ 1-Command Colleague Full Setup (< 30 Seconds)

You don't need `npm install` (zero external dependencies) or manual configuration files. Just make sure `node` (>= 18), `gh` (authenticated), and an AI CLI (`agy`, `gemini`, or `claude`) are installed:

### 1. Prerequisites (macOS / Linux)

```bash
# 1. Core CLI tools (Node.js >= 18 & GitHub CLI)
brew install node gh

# 2. Authenticate GitHub CLI (if not already logged in)
gh auth status || gh auth login

# 3. AI Agent CLI: Antigravity CLI (`agy`), Gemini CLI (`gemini`), or Claude Code CLI (`claude`)
which agy || which gemini || which claude

# 4. Optional (Enriches Product & Scope Agent with Jira acceptance criteria):
which acli || echo "Optional: acli not installed — Product agent will fall back to PR description"
```

---

### 2. 1-Command Full Colleague Setup

Run this single command in your terminal — it clones **PR Review Hub**, auto-detects your GitHub account & squad (`Pili`, `Popcorn`, `Banana`, `Papaya`, `Front`, `Mobile`, `QA`), syncs your open Pull Requests, runs `Doctor`, starts the background daemon (no terminal tab kept open), and opens **[http://localhost:4242](http://localhost:4242)**:

```bash
gh repo clone fawr-ubi/pr-review-hub ~/.gemini/config/skills/my-review && \
~/.gemini/config/skills/my-review/install.sh
```

*(Want zero interactive prompts using your auto-detected GitHub teams? Append `--yes`. To check status or stop the background daemon anytime: `cd ~/.gemini/config/skills/my-review && npm run status` / `npm run stop`.)*

#### What happens automatically on your very first start?
- **Auto-bootstraps `config.json` & Squad Profile**: Detects your GitHub login (`gh api user`), discovers your GitHub teams (`gh api user/teams`), and **auto-selects your Squad Agent Profile** (`pili-back`, `popcorn-back`, `banana-back`, `papaya-back`, `frontend-web`, `mobile-kotlin`, `qa-automation`).
- **Safe Teammate Standalone Mode (`0` background tokens)**: Starts in **`Standalone / Reader Mode`** so you browse your PR queue freely and trigger 5-agent reviews (`Run Review`) on demand.
- **Multi-Domain `/100` PR Scorecard**: Evaluates each reviewed PR across **5 domain agents** (`Security 25%`, `Product & Scope 20%`, `Quality & Architecture 25%`, `Performance 15%`, `Testing & Anti-Bloat 15%`) with live score recalculation on False Positive dismissal and isolated single-agent Deep Re-runs (`↻`).
- **In-App Google OAuth Sign-In for `agy`**: If your Antigravity CLI (`agy`) Google OAuth session expires, sign back in directly inside the web UI modal without leaving your browser.
- **Instant `👤 My PR` Badge**: Pull Requests you authored are highlighted across the queue and PR header.

---

### 3. Optional: Interactive CLI Setup & macOS Finder Launcher (`./install.sh`)

If you prefer an interactive terminal wizard that also mines 1 year of your team's GitHub PR review comments and creates a double-clickable **`Open Review Hub.command`** launcher on your Mac:

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

It verifies your environment in 2 seconds and provides 1-click copyable fix commands:
1. **`node` (>= 18)** & **`git`**
2. **`gh` CLI & Auth** (`gh auth status`)
3. **AI Agent CLI (`agy`, `gemini`, or `claude`)**:
   - Auto-detects **`agy`** (Antigravity CLI), **`gemini`** (Gemini CLI), or **`claude`** (Claude Code CLI) across standard, Homebrew, `~/.local/bin`, and NVM paths, with automatic fallback if one is missing.
   - You can switch your preferred runner anytime in **`Settings`**.
4. **Local Projects Workspace (`projectsDir`)** *(Optional — only needed for local Git Worktrees & IDE jump; AI reviews and diffs work 100% remotely via GitHub)*
5. **Reviews Storage Directory (`reviewsDir`)** & **Team Agent Profile**
6. **IDE / CLI Skill Registration (`~/.gemini/config/skills/my-review`)**

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
npm run start:bg      # Start PR Review Hub as a background daemon on :4242 and open browser
npm run status        # Check daemon status, active squad profile, and cached PR count
npm run stop          # Stop running background daemon cleanly
npm start             # Start PR Review Hub in foreground
npm run doctor        # Run environment, AI CLI & Jira CLI health checks
npm run setup         # Run interactive ./install.sh wizard (+ macOS Finder launcher)
npm run simulate:pili # Launch an isolated brand-new colleague setup simulation for Pili Squad (:4243)
npm run sync          # Scan GitHub PR queue via scripts/sync-queue.sh
npm test              # Run the 50-test unit & E2E suite
npm run package       # Build a clean pr-review-hub-shareable.zip archive
```
