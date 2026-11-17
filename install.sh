#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# PR Review Hub & my-review Agent — Full Colleague Setup (install.sh v1.3.0)
# Usage:
#   ./install.sh              # Streamlined interactive setup (3 quick prompts)
#   ./install.sh --yes        # Zero-prompt automatic setup using detected GitHub teams
# ==============================================================================

AUTO_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--non-interactive)
      AUTO_YES=1
      ;;
  esac
done

echo "============================================================"
echo "🚀 PR Review Hub & Agent Skill (my-review) — Setup v1.3.0"
echo "============================================================"

# 1. Core Prerequisites Check
if ! command -v node >/dev/null 2>&1; then
  echo "🔴 Error: Node.js (>= 18) is required. Install via Homebrew: brew install node"
  exit 1
fi
NODE_MAJOR="$(node -p 'parseInt(process.versions.node.split(".")[0], 10)')"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "🔴 Error: Node.js >= 18 is required (found $(node -v)). Upgrade via: brew upgrade node"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "🔴 Error: git is required. Install via: xcode-select --install"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "🔴 Error: GitHub CLI (gh) is required. Install via Homebrew: brew install gh"
  exit 1
fi

if ! gh auth token >/dev/null 2>&1 && ! gh auth status >/dev/null 2>&1; then
  echo "🟡 GitHub CLI (gh) is not authenticated yet."
  if [[ "${AUTO_YES}" -eq 0 ]]; then
    echo "Launching 'gh auth login'..."
    gh auth login
  else
    echo "🔴 Error: Run 'gh auth login' first, then re-run ./install.sh"
    exit 1
  fi
fi

# 2. Resolve Installation Directory (In-place for git clones; ~/.gemini/config/skills/my-review for zip bundles)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${REVIEW_HUB_INSTALL_DIR:-}" ]]; then
  TARGET_SKILL_DIR="${REVIEW_HUB_INSTALL_DIR}"
  mkdir -p "${TARGET_SKILL_DIR}"
  if [[ "${SCRIPT_DIR}" != "${TARGET_SKILL_DIR}" ]]; then
    SOURCE_COPY="${SCRIPT_DIR}"
    if [[ -d "${SCRIPT_DIR}/my-review" && -f "${SCRIPT_DIR}/my-review/SKILL.md" ]]; then
      SOURCE_COPY="${SCRIPT_DIR}/my-review"
    fi
    rsync -a \
      --exclude 'config.json' \
      --exclude 'references/*.local.md' \
      --exclude 'references/*.local.json' \
      --exclude '.DS_Store' \
      "${SOURCE_COPY}/" "${TARGET_SKILL_DIR}/"
  fi
elif [[ -f "${SCRIPT_DIR}/SKILL.md" && -f "${SCRIPT_DIR}/ui/server.mjs" ]]; then
  # Running directly inside a cloned git repository — configure in-place!
  TARGET_SKILL_DIR="${SCRIPT_DIR}"
elif [[ -d "${SCRIPT_DIR}/my-review" && -f "${SCRIPT_DIR}/my-review/SKILL.md" ]]; then
  # Running from a packaged .zip archive wrapper
  TARGET_SKILL_DIR="${HOME}/.gemini/config/skills/my-review"
  mkdir -p "${TARGET_SKILL_DIR}"
  rsync -a \
    --exclude 'config.json' \
    --exclude 'references/*.local.md' \
    --exclude 'references/*.local.json' \
    --exclude '.DS_Store' \
    "${SCRIPT_DIR}/my-review/" "${TARGET_SKILL_DIR}/"
else
  echo "🔴 Error: Could not locate PR Review Hub files from ${SCRIPT_DIR}"
  exit 1
fi

chmod +x "${TARGET_SKILL_DIR}/scripts/"*.sh "${TARGET_SKILL_DIR}/bin/pr-review-hub.mjs" 2>/dev/null || true

# 3. Auto-detect GitHub Identity, Teams, AI CLI, Jira CLI & Local Workspace
DEFAULT_ORG="${REVIEW_HUB_ORG:-ubitransports}"
DETECTED_USER="${REVIEW_HUB_USER:-$(gh api user --jq .login 2>/dev/null || echo "")}"
if [[ -z "${DETECTED_USER}" && -f "${HOME}/.config/gh/hosts.yml" ]]; then
  DETECTED_USER="$(awk '/user:/ {print $2; exit}' "${HOME}/.config/gh/hosts.yml" 2>/dev/null || echo "")"
fi

if [[ -n "${REVIEW_HUB_TEAMS:-}" ]]; then
  DETECTED_TEAMS="${REVIEW_HUB_TEAMS}"
else
  DETECTED_TEAMS="$(gh api 'user/teams?per_page=100' --jq "[.[] | select(.organization.login == \"${DEFAULT_ORG}\") | .slug] | join(\", \")" 2>/dev/null || echo "")"
fi

DEFAULT_AGENT_CLI="agy"
if ! command -v agy >/dev/null 2>&1 && [[ ! -x "${HOME}/.local/bin/agy" ]] && [[ ! -x "/Applications/Antigravity.app/Contents/Resources/app/bin/agy" ]]; then
  if command -v gemini >/dev/null 2>&1; then
    DEFAULT_AGENT_CLI="gemini"
  elif command -v claude >/dev/null 2>&1; then
    DEFAULT_AGENT_CLI="claude"
  fi
fi

ACLI_STATUS="Optional (not installed — Product agent will use PR description)"
if command -v acli >/dev/null 2>&1; then
  ACLI_VER="$({ acli --version 2>&1 || true; } | sed -n '1s/\r$//p')"
  ACLI_STATUS="Active (${ACLI_VER:-acli found})"
fi

DEFAULT_PROJECTS_DIR="${HOME}/Ubitransport/projects"
if [[ ! -d "${DEFAULT_PROJECTS_DIR}" ]]; then
  if [[ -d "${HOME}/projects" ]]; then
    DEFAULT_PROJECTS_DIR="${HOME}/projects"
  else
    DEFAULT_PROJECTS_DIR="${HOME}/Ubitransport/projects"
  fi
fi

# Isolate reviewsDir & port automatically if testing a secondary clone alongside an active primary install
PRIMARY_SKILL_DIR="${HOME}/.gemini/config/skills/my-review"
IS_SECONDARY_CLONE=0
if [[ -d "${PRIMARY_SKILL_DIR}" && "$(cd "${TARGET_SKILL_DIR}" && pwd -P)" != "$(cd "${PRIMARY_SKILL_DIR}" && pwd -P)" ]]; then
  IS_SECONDARY_CLONE=1
fi

if [[ -n "${REVIEWS_DIR:-}" ]]; then
  DEFAULT_REVIEWS_DIR="${REVIEWS_DIR}"
elif [[ "${IS_SECONDARY_CLONE}" -eq 1 && -f "${DEFAULT_PROJECTS_DIR}/artifacts/reviews/.state.json" ]]; then
  DEFAULT_REVIEWS_DIR="${TARGET_SKILL_DIR}/artifacts/reviews"
else
  DEFAULT_REVIEWS_DIR="${DEFAULT_PROJECTS_DIR}/artifacts/reviews"
fi

DEFAULT_PORT="${PORT:-4242}"
if [[ -z "${PORT:-}" && "${IS_SECONDARY_CLONE}" -eq 1 ]] && lsof -iTCP:4242 -sTCP:LISTEN -t >/dev/null 2>&1; then
  DEFAULT_PORT="4243"
fi

echo ""
echo "Pre-flight Environment Summary:"
echo "  🟢 Node.js       : $(node -v)"
echo "  🟢 GitHub Auth   : @${DETECTED_USER:-unknown} (${DEFAULT_ORG})"
echo "  🟢 AI Agent CLI  : ${DEFAULT_AGENT_CLI}"
echo "  🔵 Jira CLI      : ${ACLI_STATUS}"
echo "  📂 Install Path  : ${TARGET_SKILL_DIR}"
echo ""

# 4. Three Quick Colleague Confirmations (skipped with --yes)
if [[ "${AUTO_YES}" -eq 1 ]]; then
  GITHUB_USER="${DETECTED_USER}"
  GITHUB_ORG="${DEFAULT_ORG}"
  RAW_TEAMS="${DETECTED_TEAMS}"
else
  read -r -p "1/3 Watched GitHub team slugs (comma-separated) [${DETECTED_TEAMS}]: " INPUT_TEAMS
  RAW_TEAMS="${INPUT_TEAMS:-$DETECTED_TEAMS}"
  GITHUB_USER="${DETECTED_USER}"
  GITHUB_ORG="${DEFAULT_ORG}"
fi

DEFAULT_TEAM_PROFILE="$(node --input-type=module -e "
  import { inferTeamProfileFromGithubTeams } from '${TARGET_SKILL_DIR}/ui/lib/config.mjs';
  const raw = process.argv[1] || '';
  const slugs = raw.split(',').map(s => s.trim()).filter(Boolean);
  console.log(inferTeamProfileFromGithubTeams(slugs));
" "${RAW_TEAMS}" 2>/dev/null || echo "popcorn-back")"

if [[ "${AUTO_YES}" -eq 1 ]]; then
  TEAM_PROFILE="${REVIEW_HUB_TEAM_PROFILE:-$DEFAULT_TEAM_PROFILE}"
  AGENT_CLI="${DEFAULT_AGENT_CLI}"
else
  echo ""
  echo "Available Squad Agent Profiles:"
  echo "  1) popcorn-back   — Popcorn Squad Backend PHP (Symfony / API Platform / 2cloud)"
  echo "  2) pili-back      — Pili Squad Backend PHP (Symfony / API Platform / 2cloud)"
  echo "  3) banana-back    — Banana Squad Backend PHP (Symfony / API Platform / 2cloud)"
  echo "  4) papaya-back    — Papaya Squad Backend PHP (Symfony / API Platform / 2cloud)"
  echo "  5) frontend-web   — Frontend Web (TypeScript / VueJS / Angular)"
  echo "  6) mobile-kotlin  — Mobile Android (Kotlin / WanFare / WanPay)"
  echo "  7) qa-automation  — QA & E2E Automation (Cypress / TypeScript / Behat)"
  read -r -p "2/3 Active Squad Profile [${DEFAULT_TEAM_PROFILE}]: " INPUT_TEAM_PROFILE
  TEAM_PROFILE="${INPUT_TEAM_PROFILE:-$DEFAULT_TEAM_PROFILE}"
  case "${TEAM_PROFILE}" in
    1) TEAM_PROFILE="popcorn-back" ;;
    2) TEAM_PROFILE="pili-back" ;;
    3) TEAM_PROFILE="banana-back" ;;
    4) TEAM_PROFILE="papaya-back" ;;
    5) TEAM_PROFILE="frontend-web" ;;
    6) TEAM_PROFILE="mobile-kotlin" ;;
    7) TEAM_PROFILE="qa-automation" ;;
  esac

  echo ""
  read -r -p "3/3 AI Agent CLI runner (agy / gemini / claude) [${DEFAULT_AGENT_CLI}]: " INPUT_AGENT_CLI
  AGENT_CLI="${INPUT_AGENT_CLI:-$DEFAULT_AGENT_CLI}"
fi

HUB_ROLE="${REVIEW_HUB_ROLE:-reader}"
if [[ "${HUB_ROLE}" != "worker" ]]; then
  HUB_ROLE="reader"
fi
PROJECTS_DIR="${DEFAULT_PROJECTS_DIR/#\~/$HOME}"
REVIEWS_DIR_RESOLVED="${DEFAULT_REVIEWS_DIR/#\~/$HOME}"
JIRA_BASE_URL="https://ubitransport.atlassian.net/browse"
RAW_PREFIXES="PRD, HYB, WAN, POP, OPS, SEC, SUP, DEV"

mkdir -p "${REVIEWS_DIR_RESOLVED}/archive"

# 5. Initialize Local Gitignored Personal Rule Files
if [[ ! -f "${TARGET_SKILL_DIR}/references/reviewer-dna.local.md" && -f "${TARGET_SKILL_DIR}/references/reviewer-dna.example.md" ]]; then
  cp "${TARGET_SKILL_DIR}/references/reviewer-dna.example.md" "${TARGET_SKILL_DIR}/references/reviewer-dna.local.md"
fi
if [[ ! -f "${TARGET_SKILL_DIR}/references/false-positives.local.md" && -f "${TARGET_SKILL_DIR}/references/false-positives.example.md" ]]; then
  cp "${TARGET_SKILL_DIR}/references/false-positives.example.md" "${TARGET_SKILL_DIR}/references/false-positives.local.md"
fi
if [[ ! -f "${TARGET_SKILL_DIR}/references/changelog.local.md" ]]; then
  printf "# Review Memory Changelog\n\n---\n" > "${TARGET_SKILL_DIR}/references/changelog.local.md"
fi

# 6. Write config.json & Synchronize Combined Rules + Skill Symlinks
node --input-type=module -e "
  import path from 'node:path';
  import { saveConfig, ensureSkillSymlinks } from '${TARGET_SKILL_DIR}/ui/lib/config.mjs';
  import { syncCombinedReferenceFiles } from '${TARGET_SKILL_DIR}/ui/lib/rules.mjs';

  const configPath = path.join(process.argv[1], 'config.json');
  const teams = (process.argv[4] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const prefixes = (process.argv[9] || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const role = process.argv[7] === 'worker' ? 'worker' : 'reader';

  saveConfig({
    githubUser: process.argv[2],
    githubOrg: process.argv[3],
    githubTeams: teams,
    teamProfile: process.argv[5] || 'popcorn-back',
    agentCli: process.argv[6] || 'agy',
    hubRole: role,
    autoReviewEnabled: role === 'worker',
    sharedStoreRepo: '',
    projectsDir: process.argv[8],
    reviewsDir: process.argv[10],
    jiraBaseUrl: 'https://ubitransport.atlassian.net/browse',
    jiraPrefixes: prefixes,
    syncScript: path.join(process.argv[1], 'scripts/sync-queue.sh'),
    port: Number(process.argv[11]) || 4242,
    onboardingCompleted: true,
  }, configPath);

  syncCombinedReferenceFiles(process.argv[5] || 'popcorn-back');
  if (process.argv[12] !== '1') {
    ensureSkillSymlinks();
  }
" "${TARGET_SKILL_DIR}" "${GITHUB_USER}" "${GITHUB_ORG}" "${RAW_TEAMS}" "${TEAM_PROFILE}" "${AGENT_CLI}" "${HUB_ROLE}" "${PROJECTS_DIR}" "${RAW_PREFIXES}" "${REVIEWS_DIR_RESOLVED}" "${DEFAULT_PORT}" "${IS_SECONDARY_CLONE}"

# 7. Create Double-Clickable macOS Finder Launcher
LAUNCHER="${REVIEWS_DIR_RESOLVED}/Open Review Hub.command"
cat << LAUNCH_EOF > "${LAUNCHER}"
#!/usr/bin/env bash
set -euo pipefail
cd "${TARGET_SKILL_DIR}"
node "${TARGET_SKILL_DIR}/bin/pr-review-hub.mjs" start --bg --port "${DEFAULT_PORT}"
LAUNCH_EOF
chmod +x "${LAUNCHER}"

# 8. Sync Open Pull Requests from GitHub Immediately
echo ""
echo "🔄 Syncing open GitHub Pull Requests for @${GITHUB_USER} (${RAW_TEAMS:-personal queue})..."
if SYNC_JSON="$(REVIEW_HUB_CONFIG="${TARGET_SKILL_DIR}/config.json" "${TARGET_SKILL_DIR}/scripts/sync-queue.sh" scan 2>/dev/null)"; then
  SYNC_SUMMARY="$(node -e '
    try {
      const d = JSON.parse(process.argv[1] || "{}");
      const act = (d.actionable || []).length;
      const up = (d.upToDate || []).length;
      const dr = (d.drafts || []).length;
      console.log(`🟢 Synced ${act + up + dr} open PR(s) (${act} actionable, ${up} reviewed, ${dr} draft).`);
    } catch {
      console.log("🟢 Initial PR queue synced!");
    }
  ' "${SYNC_JSON}")"
  echo "   ${SYNC_SUMMARY}"
else
  echo "   🟡 Initial GitHub sync skipped or offline (you can click 'Sync GitHub' inside the UI)."
fi

# 9. Run Environment Doctor Verification
echo ""
REVIEW_HUB_CONFIG="${TARGET_SKILL_DIR}/config.json" node "${TARGET_SKILL_DIR}/bin/pr-review-hub.mjs" doctor || true

# 10. Start Background Daemon & Open Browser
echo ""
REVIEW_HUB_CONFIG="${TARGET_SKILL_DIR}/config.json" node "${TARGET_SKILL_DIR}/bin/pr-review-hub.mjs" start --bg --port "${DEFAULT_PORT}"

echo ""
echo "✅ Full setup complete! Useful commands inside ${TARGET_SKILL_DIR}:"
echo "   • npm run status     — Check running daemon & PR count"
echo "   • npm run stop       — Stop background server"
echo "   • npm run start:bg   — Start background server & open browser"
echo "   • npm run doctor     — Run full health diagnostics"
echo "   • Finder Launcher    — Double-click '${LAUNCHER}'"
