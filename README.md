# PR Review Hub (`my-review` — v1.1.0)

Zero-dependency local web cockpit (`http://localhost:4242`) and continuously learning AI code review agent (`my-review`) for GitHub Pull Requests. Built to scale across **any GitHub account, any GitHub organization, and multiple engineering teams** with dedicated team agent profiles and layered review rules.

---

## Architecture & Multi-Team Design

```
pr-review-hub/
├── SKILL.md                          # Core AI Review Agent instructions (Modes 1–4)
├── package.json                      # Zero-dependency ESM scripts (npm start, npm test, npm run sync)
├── install.sh                        # Interactive 1-minute onboarding CLI for any engineer/team
├── config.example.json               # Portable configuration template
├── scripts/
│   ├── sync-queue.sh                 # GitHub GraphQL PR queue scanner & state tracker
│   └── package-shareable-zip.sh      # Distributable archive builder
├── references/
│   ├── common-dna.md                 # Layer 1: Versioned organization-wide engineering baseline
│   ├── teams/                        # Layer 2: Versioned per-team Agent Profiles & Team DNA packs
│   │   ├── popcorn-back/             #   ├── PHP 8.3 / Symfony / API Platform / 2cloud backend profile
│   │   ├── frontend-web/             #   ├── TypeScript / Vue 3 / Angular frontend profile
│   │   ├── mobile-kotlin/            #   ├── Android / Kotlin / Clean Architecture mobile profile
│   │   └── qa-automation/            #   └── Cypress / TypeScript / Behat QA profile
│   ├── reviewer-dna.local.md         # Layer 3: Personal local rules (gitignored, zero merge conflicts)
│   ├── false-positives.local.md      # Layer 3: Personal false-positive exceptions (gitignored)
│   └── candidate-rules.local.json    # Layer 4: Candidate rules mined from 1-year GitHub PR history
└── ui/
    ├── server.mjs                    # Local HTTP server with disk caching & background pre-warming
    ├── index.html                    # 5-tab Review Hub Web UI (Dark / Purple / Light themes)
    ├── app.js                        # Keyboard-first frontend with instant client pre-fetching
    ├── styles.css                    # Responsive design system
    ├── lib/
    │   ├── config.mjs                # Multi-account, multi-team & CLI runner configuration
    │   ├── rules.mjs                 # 4-layer rule engine & Team Profile manager
    │   ├── onboarding.mjs            # 1-year GitHub PR review history miner & rule synthesizer
    │   ├── agent.mjs                 # Gemini CLI / Claude Code CLI runner & streaming Q&A
    │   ├── parser.mjs                # Markdown report & unified diff hunk parser
    │   ├── metadata.mjs              # CODEOWNERS parser, mergeability & Jira resolver
    │   └── worktree.mjs              # Zero-disk git tree explorer & APFS Copy-on-Write worktrees
    └── tests/
        └── hub.test.mjs              # Automated unit & E2E test suite (node:test)
```

---

## Key Features

1. **Multi-Team Agent Profiles & 4-Layer Rule Engine (`5. Agent Rules`)**
   - **Layer 1 (`references/common-dna.md`)**: Shared cross-team engineering baseline (SOLID, Security, Clean Code, Testing).
   - **Layer 2 (`references/teams/<team-id>/`)**: Each team (`popcorn-back`, `frontend-web`, `mobile-kotlin`, `qa-automation`, or custom) has its own versioned `profile.json` (tech stack, watched GitHub teams, custom AI agent instructions) and `team-dna.md` rules. Create or switch team profiles in 1 click from the UI (`+ New Team Profile`).
   - **Layer 3 (`references/*.local.md`)**: Gitignored personal rules and false-positive exceptions so `git pull` never causes merge conflicts.
   - **Layer 4 (`Scan Team PRs (1y)`)**: Mines the last **365 days** of your team's GitHub PR review comments and proposes candidate rules that you can approve into **Local DNA**, **Team DNA**, or **Common DNA**.

2. **Multi-Account & Multi-Team PR Queue (`scripts/sync-queue.sh`)**
   - Auto-discovers your GitHub login and team memberships (`gh api user/teams`).
   - Isolates `Draft` PRs in a dedicated `Draft` tab, computes real-time **CODEOWNERS** team approval status (`Mergeable` vs `Waiting approval`), and pre-warms PR diffs & descriptions on disk and in browser memory for instant (`0ms`) navigation.

3. **5-Tab Keyboard-First Web Cockpit (`http://localhost:4242`)**
   - **1. Audit Report**: Executive summary card, Mermaid diagrams, and structured finding cards.
   - **2. Description & Conversation**: Full PR description, chronological commits, and interactive GitHub review threads (reply, resolve/reopen, or jump to diff line).
   - **3. Git Diff**: Collapsible folder tree, syntax highlighting, on-demand context expansion (`↑ 20` / `↓ 20` / `All`), click-and-drag multi-line inline comment composer, and full-screen Focus Diff (`z`).
   - **4. AI Proposals**: Editable AI and manual inline comments with 1-click batch Pending Review creation or direct GitHub publishing.
   - **5. Agent Rules**: Manage Common, Team, and Local DNA rules, False Positives, and Team Agent profiles.

---

## Quick Installation (For Colleagues & New Teams)

### Prerequisites
- macOS or Linux with **Node.js >= 18**
- **GitHub CLI (`gh`)** authenticated (`gh auth status`)
- **jq** (`brew install jq`)
- **Gemini CLI (`gemini`)** or **Claude Code CLI (`claude`)** for AI reviews & Q&A

### 1-Minute Setup
```bash
git clone git@github.com:fawr-ubi/pr-review-hub.git ~/.gemini/config/skills/my-review
cd ~/.gemini/config/skills/my-review
./install.sh
```

Start the Review Hub server:
```bash
npm start
# or: node ~/.gemini/config/skills/my-review/ui/server.mjs
```
Then open **[http://localhost:4242](http://localhost:4242)**.

---

## How to Add a New Team

A new engineering team can onboard in two ways:
1. **From the Web UI (`http://localhost:4242`)**:
   - Open tab **`5. Agent Rules`**, click **`+ New Team Profile`**, enter the team slug (e.g., `moneris-back`), tech stack, GitHub team slugs, and custom AI Agent instructions, then click **Create & Activate Profile**.
   - Click **`Scan Team PRs (1y)`** to mine the team's past GitHub reviews and approve the best rules directly into **Team DNA** (`references/teams/<team-id>/team-dna.md`).
2. **Via Git (Shared with the whole team)**:
   - Commit and push `references/teams/<team-id>/profile.json` and `references/teams/<team-id>/team-dna.md` so every teammate who runs `git pull` gets the team's agent preset and rules out of the box.

---

## Customizable Keyboard Shortcuts (`?` in UI)

All shortcuts are customizable in the `?` modal:

| Default Shortcut | Action |
| :--- | :--- |
| `j` / `k` | Next / Previous PR in queue |
| `q` | Back to full-page PR Queue (`All PRs`) |
| `1` — `5` | Switch tabs (`1. Audit Report` .. `5. Agent Rules`) |
| `←` / `→` (or `h` / `l`) | Previous / Next modified file in Diff |
| `n` / `p` | Next / Previous Hunk or Finding |
| `-` / `+` / `0` | Zoom out / Zoom in / Reset zoom (`100%`) in Diff |
| `b` | Show / Hide modified files sidebar in Diff |
| `z` or `f` / `Esc` | Toggle Full-Screen Focus Diff (`100%` viewport) |
| `r` / `s` / `o` / `c` / `g` / `m` | Re-run Review / Split View / Pop-out / Agent Q&A / Open GitHub / Submit Review |

---

## Automated Tests

```bash
npm test
# or: node --test ui/tests/hub.test.mjs
```
