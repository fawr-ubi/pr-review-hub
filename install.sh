#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "PR Review Hub & Agent Skill (my-review) — Installer v1.2.0"
echo "============================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 18) is required. Install via Homebrew: brew install node"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: GitHub CLI (gh) is required. Install via Homebrew: brew install gh"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required. Install via Homebrew: brew install jq"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}"
if [[ -d "${SCRIPT_DIR}/my-review" && -f "${SCRIPT_DIR}/my-review/SKILL.md" ]]; then
  SOURCE_DIR="${SCRIPT_DIR}/my-review"
fi

TARGET_SKILL_DIR="${REVIEW_HUB_INSTALL_DIR:-${HOME}/.gemini/config/skills/my-review}"
mkdir -p "${TARGET_SKILL_DIR}"

if [[ "${SOURCE_DIR}" != "${TARGET_SKILL_DIR}" ]]; then
  rsync -a \
    --exclude 'config.json' \
    --exclude 'references/*.local.md' \
    --exclude 'references/*.local.json' \
    --exclude '.DS_Store' \
    "${SOURCE_DIR}/" "${TARGET_SKILL_DIR}/"
fi

chmod +x "${TARGET_SKILL_DIR}/scripts/"*.sh 2>/dev/null || true

DETECTED_USER="$(gh api user --jq .login 2>/dev/null || echo "")"
DEFAULT_ORG="ubitransports"
DETECTED_TEAMS="$(gh api user/teams --jq "[.[] | select(.organization.login == \"${DEFAULT_ORG}\") | .slug] | join(\", \")" 2>/dev/null || echo "")"

DEFAULT_PROJECTS_DIR="${HOME}/Ubitransport/projects"
if [[ ! -d "${DEFAULT_PROJECTS_DIR}" ]]; then
  DEFAULT_PROJECTS_DIR="${HOME}/projects"
fi
DEFAULT_REVIEWS_DIR="${DEFAULT_PROJECTS_DIR}/artifacts/reviews"
DEFAULT_JIRA_URL="https://ubitransport.atlassian.net/browse"
DEFAULT_JIRA_PREFIXES="PRD, HYB, WAN, POP, OPS, SEC"

read -r -p "GitHub username [${DETECTED_USER}]: " INPUT_USER
GITHUB_USER="${INPUT_USER:-$DETECTED_USER}"

read -r -p "GitHub organization [${DEFAULT_ORG}]: " INPUT_ORG
GITHUB_ORG="${INPUT_ORG:-$DEFAULT_ORG}"

read -r -p "GitHub team slugs (comma-separated) [${DETECTED_TEAMS}]: " INPUT_TEAMS
RAW_TEAMS="${INPUT_TEAMS:-$DETECTED_TEAMS}"

echo ""
echo "Available Team Agent Profiles (references/teams/<team-id>/):"
echo "  1) popcorn-back   — Popcorn & Backend PHP (Symfony / API Platform / 2cloud)"
echo "  2) frontend-web   — Frontend Web (TypeScript / VueJS / Angular)"
echo "  3) mobile-kotlin  — Mobile Android (Kotlin / WanFare / WanPay)"
echo "  4) qa-automation  — QA & E2E Automation (Cypress / TypeScript / Behat)"
read -r -p "Active Team Profile slug [popcorn-back]: " INPUT_TEAM_PROFILE
TEAM_PROFILE="${INPUT_TEAM_PROFILE:-popcorn-back}"
case "${TEAM_PROFILE}" in
  1) TEAM_PROFILE="popcorn-back" ;;
  2) TEAM_PROFILE="frontend-web" ;;
  3) TEAM_PROFILE="mobile-kotlin" ;;
  4) TEAM_PROFILE="qa-automation" ;;
esac

DEFAULT_AGENT_CLI="agy"
if ! command -v agy >/dev/null 2>&1 && [[ ! -x "${HOME}/.local/bin/agy" ]]; then
  if command -v gemini >/dev/null 2>&1; then
    DEFAULT_AGENT_CLI="gemini"
  elif command -v claude >/dev/null 2>&1; then
    DEFAULT_AGENT_CLI="claude"
  fi
fi
read -r -p "AI Agent CLI runner (agy / gemini / claude) [${DEFAULT_AGENT_CLI}]: " INPUT_AGENT_CLI
AGENT_CLI="${INPUT_AGENT_CLI:-$DEFAULT_AGENT_CLI}"

read -r -p "Local repositories workspace (projectsDir) [${DEFAULT_PROJECTS_DIR}]: " INPUT_PROJECTS_DIR
PROJECTS_DIR="${INPUT_PROJECTS_DIR:-$DEFAULT_PROJECTS_DIR}"
PROJECTS_DIR="${PROJECTS_DIR/#\~/$HOME}"

read -r -p "Local reviews storage directory (reviewsDir) [${DEFAULT_REVIEWS_DIR}]: " INPUT_REVIEWS_DIR
REVIEWS_DIR="${INPUT_REVIEWS_DIR:-$DEFAULT_REVIEWS_DIR}"
REVIEWS_DIR="${REVIEWS_DIR/#\~/$HOME}"

read -r -p "Jira Base URL [${DEFAULT_JIRA_URL}]: " INPUT_JIRA_URL
JIRA_BASE_URL="${INPUT_JIRA_URL:-$DEFAULT_JIRA_URL}"

read -r -p "Jira ticket prefixes (comma-separated) [${DEFAULT_JIRA_PREFIXES}]: " INPUT_JIRA_PREFIXES
RAW_PREFIXES="${INPUT_JIRA_PREFIXES:-$DEFAULT_JIRA_PREFIXES}"

mkdir -p "${REVIEWS_DIR}/archive"

# Initialize local gitignored rule files from templates if they don't exist yet
if [[ ! -f "${TARGET_SKILL_DIR}/references/reviewer-dna.local.md" && -f "${TARGET_SKILL_DIR}/references/reviewer-dna.example.md" ]]; then
  cp "${TARGET_SKILL_DIR}/references/reviewer-dna.example.md" "${TARGET_SKILL_DIR}/references/reviewer-dna.local.md"
fi
if [[ ! -f "${TARGET_SKILL_DIR}/references/false-positives.local.md" && -f "${TARGET_SKILL_DIR}/references/false-positives.example.md" ]]; then
  cp "${TARGET_SKILL_DIR}/references/false-positives.example.md" "${TARGET_SKILL_DIR}/references/false-positives.local.md"
fi
if [[ ! -f "${TARGET_SKILL_DIR}/references/changelog.local.md" ]]; then
  echo -e "# Review Memory Changelog\n\n---\n" > "${TARGET_SKILL_DIR}/references/changelog.local.md"
fi

# Generate config.json
node -e '
const fs = require("fs");
const path = require("path");
const teams = process.argv[3].split(",").map(s => s.trim()).filter(Boolean);
const prefixes = process.argv[7].split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const cfg = {
  githubUser: process.argv[1],
  githubOrg: process.argv[2],
  githubTeams: teams,
  teamProfile: process.argv[9] || "popcorn-back",
  agentCli: process.argv[10] || "agy",
  projectsDir: process.argv[4],
  reviewsDir: process.argv[5],
  jiraBaseUrl: process.argv[6].replace(/\/+$/, ""),
  jiraPrefixes: prefixes,
  syncScript: path.join(process.argv[8], "scripts/sync-queue.sh"),
  port: 4242
};
fs.writeFileSync(path.join(process.argv[8], "config.json"), JSON.stringify(cfg, null, 2) + "\n");
' "${GITHUB_USER}" "${GITHUB_ORG}" "${RAW_TEAMS}" "${PROJECTS_DIR}" "${REVIEWS_DIR}" "${JIRA_BASE_URL}" "${RAW_PREFIXES}" "${TARGET_SKILL_DIR}" "${TEAM_PROFILE}" "${AGENT_CLI}"

# Synchronize 3-layer combined rule files (Common DNA + Team DNA + Local DNA)
node --input-type=module -e "
  import { syncCombinedReferenceFiles } from '${TARGET_SKILL_DIR}/ui/lib/rules.mjs';
  syncCombinedReferenceFiles('${TEAM_PROFILE}');
" || true

# Also symlink for Claude Code if ~/.claude exists or agentCli is claude
if [[ -d "${HOME}/.claude" || "${AGENT_CLI}" == "claude" ]]; then
  mkdir -p "${HOME}/.claude/skills"
  if [[ ! -e "${HOME}/.claude/skills/my-review" ]]; then
    ln -s "${TARGET_SKILL_DIR}" "${HOME}/.claude/skills/my-review" || true
  fi
fi

read -r -p "Analyze last 1 year (365 days) of team PR review comments to propose candidate rules now? [Y/n]: " RUN_BOOTSTRAP
RUN_BOOTSTRAP="${RUN_BOOTSTRAP:-Y}"
if [[ "${RUN_BOOTSTRAP}" =~ ^[Yy]$ ]]; then
  echo "Analyzing last 365 days of GitHub PR review comments for ${GITHUB_USER} / ${RAW_TEAMS}..."
  node --input-type=module -e "
    import { loadConfig } from '${TARGET_SKILL_DIR}/ui/lib/config.mjs';
    import { bootstrapTeamCandidateRules } from '${TARGET_SKILL_DIR}/ui/lib/onboarding.mjs';
    const cfg = loadConfig('${TARGET_SKILL_DIR}/config.json');
    const res = await bootstrapTeamCandidateRules({ cfg, days: 365 });
    console.log(\`Synthesized \${res.addedCandidatesCount} candidate rule(s) from \${res.analyzedCommentsCount} comments across \${res.analyzedPrsCount} PRs.\`);
    console.log('Open Tab 5 (5. Agent Rules -> Candidates) in PR Review Hub to approve or reject them.');
  " || true
fi

read -r -p "Run initial GitHub PR queue sync right now? [Y/n]: " RUN_INITIAL_SYNC
RUN_INITIAL_SYNC="${RUN_INITIAL_SYNC:-Y}"
if [[ "${RUN_INITIAL_SYNC}" =~ ^[Yy]$ ]]; then
  echo "Syncing open Pull Requests from GitHub..."
  "${TARGET_SKILL_DIR}/scripts/sync-queue.sh" scan >/dev/null || true
  echo "Initial PR queue synced!"
fi

LAUNCHER="${REVIEWS_DIR}/Open Review Hub.command"
cat << 'LAUNCH_EOF' > "${LAUNCHER}"
#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4242}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_SCRIPT="${HOME}/.gemini/config/skills/my-review/ui/server.mjs"
LOG_FILE="${SCRIPT_DIR}/.hub-server.log"

if ! lsof -iTCP:${PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Starting PR Review Hub on http://localhost:${PORT} ..."
  nohup node "${SERVER_SCRIPT}" > "${LOG_FILE}" 2>&1 &
  sleep 0.8
else
  echo "PR Review Hub is already running on http://localhost:${PORT}"
fi

open "http://localhost:${PORT}"
LAUNCH_EOF
chmod +x "${LAUNCHER}"

echo ""
echo "Installation complete!"
echo "  • Skill directory : ${TARGET_SKILL_DIR}"
echo "  • Team Profile    : ${TEAM_PROFILE}"
echo "  • Agent CLI       : ${AGENT_CLI}"
echo "  • Reviews folder  : ${REVIEWS_DIR}"
echo "  • macOS Launcher  : ${LAUNCHER}"
echo ""
echo "To start the web interface right now:"
echo "  node ${TARGET_SKILL_DIR}/ui/server.mjs"
echo "  Then open http://localhost:4242"
