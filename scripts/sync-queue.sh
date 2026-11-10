#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${REVIEW_HUB_CONFIG:-${SKILL_ROOT}/config.json}"

DEFAULT_PROJECTS_DIR="${HOME}/Ubitransport/projects"
if [[ ! -d "${DEFAULT_PROJECTS_DIR}" ]]; then
  DEFAULT_PROJECTS_DIR="${HOME}/projects"
fi
DEFAULT_REVIEWS_DIR="${DEFAULT_PROJECTS_DIR}/artifacts/reviews"

CFG_PROJECTS_DIR=""
CFG_REVIEWS_DIR=""
CFG_ORG=""
CFG_USER=""
CFG_JIRA=""
CFG_JIRA_REGEX=""
CFG_TEAMS_LABEL=""

if [[ -f "${CONFIG_FILE}" ]]; then
  CFG_PROJECTS_DIR=$(jq -r '.projectsDir // empty' "${CONFIG_FILE}" 2>/dev/null || true)
  CFG_REVIEWS_DIR=$(jq -r '.reviewsDir // empty' "${CONFIG_FILE}" 2>/dev/null || true)
  CFG_ORG=$(jq -r '.githubOrg // empty' "${CONFIG_FILE}" 2>/dev/null || true)
  CFG_USER=$(jq -r '.githubUser // empty' "${CONFIG_FILE}" 2>/dev/null || true)
  CFG_JIRA=$(jq -r '.jiraBaseUrl // empty' "${CONFIG_FILE}" 2>/dev/null || true)
  CFG_JIRA_REGEX=$(jq -r 'if (.jiraPrefixes | type == "array" and length > 0) then "(?:" + (.jiraPrefixes | join("|")) + ")-[0-9]+" else empty end' "${CONFIG_FILE}" 2>/dev/null || true)
  CFG_TEAMS_LABEL=$(jq -r 'if (.githubTeams | type == "array" and length > 0) then (.githubTeams | join(", ")) else empty end' "${CONFIG_FILE}" 2>/dev/null || true)
fi

PROJECTS_DIR="${PROJECTS_DIR:-${CFG_PROJECTS_DIR:-${DEFAULT_PROJECTS_DIR}}}"
REVIEWS_DIR="${REVIEWS_DIR:-${CFG_REVIEWS_DIR:-${DEFAULT_REVIEWS_DIR}}}"
ARCHIVE_DIR="${REVIEWS_DIR}/archive"
STATE_FILE="${REVIEWS_DIR}/.state.json"
INDEX_FILE="${REVIEWS_DIR}/INDEX.md"
ORG="${REVIEW_HUB_ORG:-${CFG_ORG:-ubitransports}}"
USER_LOGIN="${REVIEW_HUB_USER:-${CFG_USER:-$(gh api user --jq .login 2>/dev/null || echo "")}}"
JIRA_BASE_URL="${CFG_JIRA:-https://ubitransport.atlassian.net/browse}"
JIRA_SCAN_REGEX="${CFG_JIRA_REGEX:-(?:PRD|HYB|WAN|POP|OPS|SEC)-[0-9]+}"
DASHBOARD_SCOPE="\`${USER_LOGIN:-reviewer}\`"
if [[ -n "${CFG_TEAMS_LABEL}" ]]; then
  DASHBOARD_SCOPE="\`${USER_LOGIN:-reviewer}\` & \`${CFG_TEAMS_LABEL}\`"
fi

mkdir -p "${REVIEWS_DIR}" "${ARCHIVE_DIR}"

if [[ ! -f "${STATE_FILE}" ]]; then
  echo '{"prs":{}}' > "${STATE_FILE}"
fi

# Helper: Regenerate INDEX.md from .state.json
generate_index() {
  local now
  now=$(date "+%Y-%m-%d %H:%M")

  cat <<EOF > "${INDEX_FILE}"
# PR Review Queue — Dashboard (${DASHBOARD_SCOPE})

*Last synced: \`${now}\`*

## 🟢 Active Open PRs

| PR | Author | Jira | Status | Head SHA | Findings | Review File | Updated At |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
EOF

  jq -r --arg jiraBase "${JIRA_BASE_URL}" '
    .prs | to_entries
    | map(select(.value.state == "OPEN"))
    | sort_by(.value.updatedAt) | reverse
    | if length == 0 then
        "| *No active PRs* | — | — | — | — | — | — | — |"
      else
        .[] | .value |
        "| [\(.repo) #\(.number)](\(.url)) — \(.title | gsub("\\|"; "/")) | `\(.author)` | " +
        (if (.jiraKey // "") != "" and (.jiraKey // "—") != "—" then "[\(.jiraKey)](\($jiraBase)/\(.jiraKey))" else "—" end) +
        " | \(.reviewStatus // "PENDING") | `\((.lastReviewedSha // .headRefOid // "—")[0:7])` | \(.findingsSummary // "—") | " +
        (if (.lastReviewedSha // null) != null and (.reviewFile // "") != "" then "[\(.reviewFile)](./\(.reviewFile))" else "—" end) +
        " | `\((.lastReviewedAt // .updatedAt // "—")[0:16] | gsub("T"; " "))` |"
      end
  ' "${STATE_FILE}" >> "${INDEX_FILE}"

  cat <<EOF >> "${INDEX_FILE}"

---

## 📦 Archived Reviews (Merged / Closed)

| PR | Author | Jira | Final State | Last SHA | Findings | Archived File |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
EOF

  jq -r --arg jiraBase "${JIRA_BASE_URL}" '
    .prs | to_entries
    | map(select(.value.state != "OPEN" and (.value.reviewFile // "") != ""))
    | sort_by(.value.updatedAt) | reverse
    | if length == 0 then
        "| *No archived reviews yet* | — | — | — | — | — | — |"
      else
        .[] | .value |
        "| [\(.repo) #\(.number)](\(.url)) — \(.title | gsub("\\|"; "/")) | `\(.author)` | " +
        (if (.jiraKey // "") != "" and (.jiraKey // "—") != "—" then "[\(.jiraKey)](\($jiraBase)/\(.jiraKey))" else "—" end) +
        " | `\(.state)` | `\((.lastReviewedSha // .headRefOid // "—")[0:7])` | \(.findingsSummary // "—") | " +
        (if (.reviewFile // "") != "" then "[archive/\(.reviewFile)](./archive/\(.reviewFile))" else "—" end) +
        " |"
      end
  ' "${STATE_FILE}" >> "${INDEX_FILE}"
}

COMMAND="${1:-scan}"

if [[ "${COMMAND}" == "record" ]]; then
  # Usage: sync-queue.sh record <repo> <pr_number> <head_sha> <review_status> <findings_summary> <jira_key> [review_file]
  REPO="${2:?Missing repo}"
  PR_NUMBER="${3:?Missing pr_number}"
  HEAD_SHA="${4:?Missing head_sha}"
  REVIEW_STATUS="${5:?Missing review_status}"
  FINDINGS_SUMMARY="${6:-0 findings}"
  JIRA_KEY="${7:-—}"
  REVIEW_FILE="${8:-review-${REPO}-${PR_NUMBER}.md}"
  KEY="${REPO}#${PR_NUMBER}"
  NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  TMP_STATE=$(mktemp)
  jq \
    --arg key "${KEY}" \
    --arg repo "${REPO}" \
    --arg num "${PR_NUMBER}" \
    --arg sha "${HEAD_SHA}" \
    --arg status "${REVIEW_STATUS}" \
    --arg findings "${FINDINGS_SUMMARY}" \
    --arg jira "${JIRA_KEY}" \
    --arg file "${REVIEW_FILE}" \
    --arg now "${NOW_ISO}" \
    '.prs[$key] = ((.prs[$key] // {}) + {
      repo: (.prs[$key].repo // $repo),
      number: (.prs[$key].number // ($num | tonumber)),
      state: (.prs[$key].state // "OPEN"),
      lastReviewedSha: $sha,
      headRefOid: $sha,
      reviewStatus: $status,
      findingsSummary: $findings,
      jiraKey: $jira,
      reviewFile: $file,
      lastReviewedAt: $now
    })' "${STATE_FILE}" > "${TMP_STATE}" && mv "${TMP_STATE}" "${STATE_FILE}"

  generate_index
  echo "Recorded review for ${KEY} at SHA ${HEAD_SHA:0:7} and updated ${INDEX_FILE}"
  exit 0
fi

if [[ "${COMMAND}" == "index" ]]; then
  generate_index
  echo "Regenerated ${INDEX_FILE}"
  exit 0
fi

# Default command: scan
CUTOFF_DATE=$(date -v-14d +%Y-%m-%d)

# 1. Bootstrap any existing review-*.md files in REVIEWS_DIR that aren't in .state.json yet
for f in "${REVIEWS_DIR}"/review-*.md; do
  [[ -e "$f" ]] || continue
  base=$(basename "$f")
  # Extract repo and PR number(s) from review-<repo>-<number>.md
  if [[ "$base" =~ ^review-(.+)-([0-9]+)\.md$ ]]; then
    repo_part="${BASH_REMATCH[1]}"
    pr_num="${BASH_REMATCH[2]}"
    # Handle multi-PR file name like review-2cloud-services-5578-5579.md
    if [[ "$repo_part" =~ ^(.+)-([0-9]+)$ ]]; then
      repo_part="${BASH_REMATCH[1]}"
    fi
    key="${repo_part}#${pr_num}"
    has_key=$(jq -r --arg k "$key" '.prs | has($k)' "${STATE_FILE}")
    if [[ "$has_key" == "false" ]]; then
      pr_info=$(gh api graphql -f query="{
        repository(owner: \"${ORG}\", name: \"${repo_part}\") {
          pullRequest(number: ${pr_num}) {
            number title state updatedAt headRefOid baseRefName headRefName mergeable url
            author { login ... on User { name } }
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          }
        }
      }" --jq '.data.repository.pullRequest' 2>/dev/null || echo "null")
      if [[ "$pr_info" != "null" && -n "$pr_info" ]] && echo "$pr_info" | jq -e 'type == "object"' >/dev/null 2>&1; then
        TMP_STATE=$(mktemp)
        jq --arg k "$key" --arg repo "$repo_part" --arg file "$base" --argjson pr "$pr_info" '
          .prs[$k] = {
            repo: $repo,
            number: $pr.number,
            title: $pr.title,
            state: $pr.state,
            author: $pr.author.login,
            authorName: ($pr.author.name // null),
            baseRefName: ($pr.baseRefName // null),
            headRefName: ($pr.headRefName // null),
            mergeable: ($pr.mergeable // null),
            ciState: ($pr.commits.nodes[0].commit.statusCheckRollup.state // null),
            url: $pr.url,
            headRefOid: $pr.headRefOid,
            lastReviewedSha: $pr.headRefOid,
            updatedAt: $pr.updatedAt,
            reviewStatus: "✅ Reviewed",
            reviewFile: $file
          }
        ' "${STATE_FILE}" > "${TMP_STATE}" && mv "${TMP_STATE}" "${STATE_FILE}"
      fi
    fi
  fi
done

# 2. Check existing OPEN PRs (or PRs missing rich metadata) in .state.json to see if any were MERGED or CLOSED
CHECK_KEYS=$(jq -r '.prs | to_entries[] | select(.value.state == "OPEN" or (.value.changedFiles == null)) | .key' "${STATE_FILE}")
for key in ${CHECK_KEYS}; do
  repo="${key%#*}"
  num="${key#*#}"
  pr_info=$(gh api graphql -f query="{
    repository(owner: \"${ORG}\", name: \"${repo}\") {
      pullRequest(number: ${num}) {
        state isDraft headRefOid updatedAt createdAt additions deletions changedFiles mergeable mergeStateStatus reviewDecision
        author { login ... on User { name } }
        labels(first: 10) { nodes { name color } }
        files(first: 100) { nodes { path } }
        latestOpinionatedReviews(first: 20) {
          nodes {
            state
            submittedAt
            author { login ... on User { name } }
          }
        }
        reviewRequests(first: 15) {
          nodes {
            requestedReviewer {
              ... on User { login name }
              ... on Team { name slug }
            }
          }
        }
      }
    }
  }" --jq '.data.repository.pullRequest' 2>/dev/null || echo "null")
  if [[ "$pr_info" != "null" && -n "$pr_info" ]] && echo "$pr_info" | jq -e 'type == "object"' >/dev/null 2>&1; then
    TMP_STATE=$(mktemp)
    jq --arg k "$key" --argjson pr "$pr_info" '
      .prs[$k].state = $pr.state |
      .prs[$k].isDraft = ($pr.isDraft // false) |
      .prs[$k].headRefOid = $pr.headRefOid |
      .prs[$k].updatedAt = $pr.updatedAt |
      .prs[$k].createdAt = ($pr.createdAt // .prs[$k].createdAt // null) |
      .prs[$k].authorName = ($pr.author.name // .prs[$k].authorName // null) |
      .prs[$k].additions = ($pr.additions // .prs[$k].additions // null) |
      .prs[$k].deletions = ($pr.deletions // .prs[$k].deletions // null) |
      .prs[$k].changedFiles = ($pr.changedFiles // .prs[$k].changedFiles // null) |
      .prs[$k].changedFilePaths = ([$pr.files.nodes[]?.path] // .prs[$k].changedFilePaths // []) |
      .prs[$k].mergeable = ($pr.mergeable // .prs[$k].mergeable // null) |
      .prs[$k].mergeStateStatus = ($pr.mergeStateStatus // .prs[$k].mergeStateStatus // null) |
      .prs[$k].reviewDecision = ($pr.reviewDecision // .prs[$k].reviewDecision // null) |
      .prs[$k].labels = ([$pr.labels.nodes[]? | { name: .name, color: .color }]) |
      .prs[$k].latestReviews = ([$pr.latestOpinionatedReviews.nodes[]? | select(.author.login != null) | {
        login: .author.login,
        name: (.author.name // null),
        state: .state,
        submittedAt: .submittedAt
      }]) |
      .prs[$k].pendingReviewers = ([$pr.reviewRequests.nodes[]?.requestedReviewer | select(. != null) | {
        login: (.login // .slug // null),
        name: (.name // .login // .slug // null),
        isTeam: (has("slug"))
      }])
    ' "${STATE_FILE}" > "${TMP_STATE}" && mv "${TMP_STATE}" "${STATE_FILE}"
  fi
done

# 3. Archive review files for any PR in .state.json whose state is MERGED or CLOSED
ARCHIVED_LIST="[]"
WORKTREES_BASE="${PROJECTS_DIR}/.review-worktrees"
NON_OPEN_KEYS=$(jq -r '.prs | to_entries[] | select(.value.state != "OPEN") | .key' "${STATE_FILE}")
for key in ${NON_OPEN_KEYS}; do
  repo_c="${key%#*}"
  num_c="${key#*#}"
  wt_dir="${WORKTREES_BASE}/${repo_c}-pr-${num_c}"
  if [[ -d "${wt_dir}" ]]; then
    git -C "${PROJECTS_DIR}/${repo_c}" worktree remove --force "${wt_dir}" 2>/dev/null || rm -rf "${wt_dir}"
  fi
  file=$(jq -r --arg k "$key" '.prs[$k].reviewFile // ""' "${STATE_FILE}")
  if [[ -n "$file" && -f "${REVIEWS_DIR}/${file}" ]]; then
    # Only archive if no other still-OPEN PR shares the same reviewFile
    shared_open=$(jq -r --arg f "$file" '[.prs[] | select(.state == "OPEN" and .reviewFile == $f)] | length' "${STATE_FILE}")
    if [[ "$shared_open" == "0" ]]; then
      mv "${REVIEWS_DIR}/${file}" "${ARCHIVE_DIR}/${file}"
      ARCHIVED_LIST=$(echo "${ARCHIVED_LIST}" | jq --arg k "$key" --arg f "$file" '. + [{pr: $k, file: $f}]')
    fi
  fi
done

# 4. Query GitHub GraphQL for all open PRs requested for the configured user or teams, or reviewed/authored by user
PR_FRAGMENT='
  number
  title
  state
  isDraft
  createdAt
  updatedAt
  additions
  deletions
  changedFiles
  headRefOid
  baseRefName
  headRefName
  mergeable
  mergeStateStatus
  reviewDecision
  url
  author { login ... on User { name } }
  repository { name }
  files(first: 100) {
    nodes {
      path
    }
  }
  labels(first: 10) {
    nodes {
      name
      color
    }
  }
  commits(last: 1) {
    totalCount
    nodes {
      commit {
        statusCheckRollup {
          state
        }
      }
    }
  }
  comments {
    totalCount
  }
  reviewThreads {
    totalCount
  }
  latestOpinionatedReviews(first: 20) {
    nodes {
      author { login ... on User { name } }
      state
      submittedAt
    }
  }
  reviewRequests(first: 15) {
    nodes {
      requestedReviewer {
        ... on User { login name }
        ... on Team { name slug }
      }
    }
  }
  reviews(last: 20) {
    nodes {
      author { login ... on User { name } }
      state
      commit { oid }
      submittedAt
    }
  }
'

TEAM_QUERIES=""
if [[ -f "${CONFIG_FILE}" ]] && jq -e '.githubTeams | type == "array" and length > 0' "${CONFIG_FILE}" >/dev/null 2>&1; then
  idx=0
  while IFS= read -r team_slug; do
    [[ -n "${team_slug}" ]] || continue
    clean_slug="${team_slug#${ORG}/}"
    TEAM_QUERIES+="
  team_${idx}: search(query: \"org:${ORG} is:pr is:open updated:>=${CUTOFF_DATE} team-review-requested:${ORG}/${clean_slug}\", type: ISSUE, first: 30) {
    nodes { ... on PullRequest { ${PR_FRAGMENT} } }
  }"
    idx=$((idx + 1))
  done < <(jq -r '.githubTeams[]' "${CONFIG_FILE}")
fi

RAW_SEARCH=$(gh api graphql -f query="{
  me: search(query: \"org:${ORG} is:pr is:open updated:>=${CUTOFF_DATE} review-requested:${USER_LOGIN}\", type: ISSUE, first: 30) {
    nodes { ... on PullRequest { ${PR_FRAGMENT} } }
  }${TEAM_QUERIES}
  reviewedByMe: search(query: \"org:${ORG} is:pr is:open updated:>=${CUTOFF_DATE} reviewed-by:${USER_LOGIN}\", type: ISSUE, first: 30) {
    nodes { ... on PullRequest { ${PR_FRAGMENT} } }
  }
  authoredByMe: search(query: \"org:${ORG} is:pr is:open updated:>=${CUTOFF_DATE} author:${USER_LOGIN}\", type: ISSUE, first: 30) {
    nodes { ... on PullRequest { ${PR_FRAGMENT} } }
  }
  draftsInMainRepos: search(query: \"repo:${ORG}/2cloud-services is:pr is:open is:draft updated:>=${CUTOFF_DATE}\", type: ISSUE, first: 20) {
    nodes { ... on PullRequest { ${PR_FRAGMENT} } }
  }
}")

# 5. Merge search results, filter out bots, compare SHAs with .state.json and GitHub reviews
SCAN_RESULT=$(jq -n \
  --argjson search "${RAW_SEARCH}" \
  --argjson state "$(cat "${STATE_FILE}")" \
  --argjson archived "${ARCHIVED_LIST}" \
  --arg user "${USER_LOGIN}" \
  --arg jiraRegex "${JIRA_SCAN_REGEX}" '
  ([ $search.data | to_entries[] | .value.nodes[]? ])
  | map(select(.number != null))
  | unique_by("\(.repository.name)#\(.number)")
  | map(select(.author.login | test("^(ci-cd-matawan|dependabot|renovate|github-actions)") | not))
  | map(
      . as $pr |
      "\($pr.repository.name)#\($pr.number)" as $key |
      ($state.prs[$key] // null) as $st |
      ([$pr.reviews.nodes[]? | select(.author.login == $user)] | last) as $lastGhReview |
      ($st.lastReviewedSha // null) as $localSha |
      ($lastGhReview.commit.oid // null) as $ghSha |
      ($st.reviewFile // "review-\($pr.repository.name)-\($pr.number).md") as $rFile |
      (
        if $localSha == $pr.headRefOid then
          "UP_TO_DATE"
        elif ($pr.isDraft == true) then
          "DRAFT"
        elif $localSha != null and $localSha != $pr.headRefOid then
          "NEEDS_UPDATE"
        elif $ghSha == $pr.headRefOid then
          "REVIEWED_ON_GITHUB"
        elif $ghSha != null and $ghSha != $pr.headRefOid then
          "NEEDS_UPDATE"
        else
          "NEEDS_REVIEW"
        end
      ) as $syncStatus |
      {
        key: $key,
        repo: $pr.repository.name,
        number: $pr.number,
        title: $pr.title,
        state: $pr.state,
        isDraft: ($pr.isDraft // false),
        author: $pr.author.login,
        authorName: ($pr.author.name // $st.authorName // null),
        reviewMode: (if $pr.author.login == $user then "Self-Review" else "Peer-Review" end),
        baseRefName: $pr.baseRefName,
        headRefName: $pr.headRefName,
        headRefOid: $pr.headRefOid,
        createdAt: ($pr.createdAt // $st.createdAt // null),
        additions: ($pr.additions // $st.additions // null),
        deletions: ($pr.deletions // $st.deletions // null),
        changedFiles: ($pr.changedFiles // $st.changedFiles // null),
        commitsCount: ($pr.commits.totalCount // $st.commitsCount // null),
        githubCommentsCount: ((($pr.comments.totalCount // 0) + ($pr.reviewThreads.totalCount // 0)) // $st.githubCommentsCount // 0),
        changedFilePaths: ([$pr.files.nodes[]?.path] // $st.changedFilePaths // []),
        mergeable: ($pr.mergeable // $st.mergeable // null),
        mergeStateStatus: ($pr.mergeStateStatus // $st.mergeStateStatus // null),
        reviewDecision: ($pr.reviewDecision // $st.reviewDecision // null),
        labels: ([$pr.labels.nodes[]? | { name: .name, color: .color }]),
        latestReviews: ([$pr.latestOpinionatedReviews.nodes[]? | select(.author.login != null) | {
          login: .author.login,
          name: (.author.name // null),
          state: .state,
          submittedAt: .submittedAt
        }]),
        pendingReviewers: ([$pr.reviewRequests.nodes[]?.requestedReviewer | select(. != null) | {
          login: (.login // .slug // null),
          name: (.name // .login // .slug // null),
          isTeam: (has("slug"))
        }]),
        ciState: ($pr.commits.nodes[0].commit.statusCheckRollup.state // $st.ciState // null),
        previousReviewedSha: ($localSha // $ghSha),
        lastReviewedSha: $localSha,
        lastGithubReviewSha: $ghSha,
        lastGithubReviewState: ($lastGhReview.state // null),
        updatedAt: $pr.updatedAt,
        url: $pr.url,
        syncStatus: $syncStatus,
        reviewStatus: (
          if $syncStatus == "UP_TO_DATE" then ($st.reviewStatus // "✅ Reviewed")
          elif $syncStatus == "DRAFT" then "📝 Draft (audit manuel)"
          elif $syncStatus == "REVIEWED_ON_GITHUB" then "✅ Reviewed on GH (\($lastGhReview.state))"
          elif $syncStatus == "NEEDS_UPDATE" then "🔄 Update Needed (new commits)"
          else "⏳ Pending Review"
          end
        ),
        jiraKey: ($st.jiraKey // ([($pr.title + " " + $pr.headRefName) | scan($jiraRegex)] | first // "—")),
        findingsSummary: ($st.findingsSummary // "—"),
        reviewFile: (if ($syncStatus == "REVIEWED_ON_GITHUB" or $syncStatus == "DRAFT") and ($st == null) then "" else $rFile end),
        lastReviewedAt: ($st.lastReviewedAt // $lastGhReview.submittedAt // null)
      }
    ) as $activePrs |
  {
    updatedState: (
      reduce $activePrs[] as $item ($state;
        .prs[$item.key] = ((.prs[$item.key] // {}) + $item)
      )
    ),
    report: {
      archived: $archived,
      actionable: ($activePrs | map(select(.syncStatus == "NEEDS_REVIEW" or .syncStatus == "NEEDS_UPDATE"))),
      drafts: ($activePrs | map(select(.syncStatus == "DRAFT"))),
      upToDate: ($activePrs | map(select(.syncStatus == "UP_TO_DATE" or .syncStatus == "REVIEWED_ON_GITHUB")))
    }
  }
')

echo "${SCAN_RESULT}" | jq '.updatedState' > "${STATE_FILE}"
generate_index
echo "${SCAN_RESULT}" | jq '.report'
