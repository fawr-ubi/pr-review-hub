import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';
import { extractJiraKey } from './metadata.mjs';
import { getActiveTeamProfile } from './rules.mjs';

const execFileAsync = promisify(execFile);

const BOT_AUTHOR_RE = /^(ci-cd-matawan|dependabot|renovate|github-actions)/i;

function readStateFile(stateFile) {
  try {
    if (fs.existsSync(stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        parsed.prs = parsed.prs && typeof parsed.prs === 'object' ? parsed.prs : {};
        return parsed;
      }
    }
  } catch {
    // ignore corrupted state file
  }
  return { prs: {} };
}

function writeStateFile(stateFile, stateData) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmpFile = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(stateData, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, stateFile);
}

function formatDateMinute(isoStr) {
  if (!isoStr || isoStr === '—') return '—';
  return String(isoStr).slice(0, 16).replace('T', ' ');
}

export function generateIndexMarkdown(customCfg = null) {
  const cfg = customCfg || loadConfig();
  const reviewsDir = cfg.reviewsDir;
  const archiveDir = path.join(reviewsDir, 'archive');
  const stateFile = path.join(reviewsDir, '.state.json');
  const indexFile = path.join(reviewsDir, 'INDEX.md');

  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const state = readStateFile(stateFile);
  const nowStr = formatDateMinute(new Date().toISOString());
  const userLogin = cfg.githubUser || 'reviewer';
  const teamsLabel = Array.isArray(cfg.githubTeams) && cfg.githubTeams.length > 0
    ? cfg.githubTeams.join(', ')
    : '';
  const dashboardScope = teamsLabel
    ? `\`${userLogin}\` & \`${teamsLabel}\``
    : `\`${userLogin}\``;
  const jiraBase = (cfg.jiraBaseUrl || 'https://ubitransport.atlassian.net/browse').replace(/\/+$/, '');

  const allEntries = Object.values(state.prs || {});
  const openPrs = allEntries
    .filter((pr) => pr && pr.state === 'OPEN')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const archivedPrs = allEntries
    .filter((pr) => pr && pr.state !== 'OPEN' && pr.reviewFile)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const lines = [
    `# PR Review Queue — Dashboard (${dashboardScope})`,
    '',
    `*Last synced: \`${nowStr}\`*`,
    '',
    '## 🟢 Active Open PRs',
    '',
    '| PR | Author | Jira | Status | Head SHA | Findings | Review File | Updated At |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  ];

  if (openPrs.length === 0) {
    lines.push('| *No active PRs* | — | — | — | — | — | — | — |');
  } else {
    for (const pr of openPrs) {
      const safeTitle = String(pr.title || '').replace(/\|/g, '/');
      const jiraCell =
        pr.jiraKey && pr.jiraKey !== '—'
          ? `[${pr.jiraKey}](${jiraBase}/${pr.jiraKey})`
          : '—';
      const shaShort = String(pr.lastReviewedSha || pr.headRefOid || '—').slice(0, 7);
      const fileCell =
        pr.lastReviewedSha && pr.reviewFile
          ? `[${pr.reviewFile}](./${pr.reviewFile})`
          : '—';
      const updatedCell = formatDateMinute(pr.lastReviewedAt || pr.updatedAt || '—');
      lines.push(
        `| [${pr.repo} #${pr.number}](${pr.url || '#'}) — ${safeTitle} | \`${pr.author || 'unknown'}\` | ${jiraCell} | ${pr.reviewStatus || 'PENDING'} | \`${shaShort}\` | ${pr.findingsSummary || '—'} | ${fileCell} | \`${updatedCell}\` |`
      );
    }
  }

  lines.push(
    '',
    '---',
    '',
    '## 📦 Archived Reviews (Merged / Closed)',
    '',
    '| PR | Author | Jira | Final State | Last SHA | Findings | Archived File |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
  );

  if (archivedPrs.length === 0) {
    lines.push('| *No archived reviews yet* | — | — | — | — | — | — |');
  } else {
    for (const pr of archivedPrs) {
      const safeTitle = String(pr.title || '').replace(/\|/g, '/');
      const jiraCell =
        pr.jiraKey && pr.jiraKey !== '—'
          ? `[${pr.jiraKey}](${jiraBase}/${pr.jiraKey})`
          : '—';
      const shaShort = String(pr.lastReviewedSha || pr.headRefOid || '—').slice(0, 7);
      const fileCell = pr.reviewFile
        ? `[archive/${pr.reviewFile}](./archive/${pr.reviewFile})`
        : '—';
      lines.push(
        `| [${pr.repo} #${pr.number}](${pr.url || '#'}) — ${safeTitle} | \`${pr.author || 'unknown'}\` | ${jiraCell} | \`${pr.state || 'CLOSED'}\` | \`${shaShort}\` | ${pr.findingsSummary || '—'} | ${fileCell} |`
      );
    }
  }

  fs.writeFileSync(indexFile, lines.join('\n') + '\n', 'utf8');
  return indexFile;
}

export function recordPrReview({
  cfg: customCfg = null,
  repo,
  number,
  headSha,
  reviewStatus,
  findingsSummary = '0 findings',
  jiraKey = '—',
  reviewFile = '',
}) {
  const cfg = customCfg || loadConfig();
  const reviewsDir = cfg.reviewsDir;
  const stateFile = path.join(reviewsDir, '.state.json');
  fs.mkdirSync(reviewsDir, { recursive: true });

  const prNum = Number(number);
  const key = `${repo}#${prNum}`;
  const resolvedFile = reviewFile || `review-${repo}-${prNum}.md`;
  const nowIso = new Date().toISOString();

  const state = readStateFile(stateFile);
  const existing = state.prs[key] || {};
  state.prs[key] = {
    ...existing,
    repo: existing.repo || repo,
    number: existing.number || prNum,
    state: existing.state || 'OPEN',
    lastReviewedSha: headSha,
    headRefOid: headSha,
    reviewStatus,
    findingsSummary,
    jiraKey: jiraKey || existing.jiraKey || '—',
    reviewFile: resolvedFile,
    lastReviewedAt: nowIso,
  };

  writeStateFile(stateFile, state);
  const indexFile = generateIndexMarkdown(cfg);
  return { key, indexFile, entry: state.prs[key] };
}

async function runGraphql(query, timeoutMs = 45000, maxRetries = 3) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const { stdout } = await execFileAsync('gh', ['api', 'graphql', '-f', `query=${query}`], {
        maxBuffer: 30 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return JSON.parse(stdout || '{}');
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      attempt++;
      console.warn(`GraphQL attempt ${attempt} failed (502 Bad Gateway?), retrying in 5s...`);
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    }
  }
}

export async function scanPrQueue(customCfg = null) {
  const cfg = customCfg || loadConfig();
  const reviewsDir = cfg.reviewsDir;
  const projectsDir = cfg.projectsDir;
  const archiveDir = path.join(reviewsDir, 'archive');
  const stateFile = path.join(reviewsDir, '.state.json');
  const org = cfg.githubOrg || 'ubitransports';

  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  let userLogin = cfg.githubUser || '';
  if (!userLogin || userLogin === 'your-github-login' || userLogin === 'github-user') {
    try {
      const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], {
        timeout: 5000,
      });
      userLogin = String(stdout || '').trim();
    } catch {
      // ignore
    }
  }

  const state = readStateFile(stateFile);
  const cutoffDate = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);

  // 1. Bootstrap any existing review-*.md files in reviewsDir that aren't in .state.json yet
  const filesOnDisk = fs.existsSync(reviewsDir)
    ? fs.readdirSync(reviewsDir).filter((f) => f.startsWith('review-') && f.endsWith('.md'))
    : [];

  for (const base of filesOnDisk) {
    const m = base.match(/^review-(.+)-([0-9]+)\.md$/);
    if (!m) continue;
    let repoPart = m[1];
    const prNum = Number(m[2]);
    const multiMatch = repoPart.match(/^(.+)-([0-9]+)$/);
    if (multiMatch) {
      repoPart = multiMatch[1];
    }
    const key = `${repoPart}#${prNum}`;
    if (state.prs[key]) continue;

    try {
      const data = await runGraphql(
        `{
          repository(owner: "${org}", name: "${repoPart}") {
            pullRequest(number: ${prNum}) {
              number title state updatedAt headRefOid baseRefName headRefName mergeable url
              author { login ... on User { name } }
              commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
            }
          }
        }`,
        15000
      );
      const pr = data?.data?.repository?.pullRequest;
      if (pr && pr.number) {
        state.prs[key] = {
          repo: repoPart,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.author?.login || 'unknown',
          authorName: pr.author?.name || null,
          baseRefName: pr.baseRefName || null,
          headRefName: pr.headRefName || null,
          mergeable: pr.mergeable || null,
          ciState: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
          url: pr.url,
          headRefOid: pr.headRefOid,
          lastReviewedSha: pr.headRefOid,
          updatedAt: pr.updatedAt,
          reviewStatus: '✅ Reviewed',
          reviewFile: base,
        };
      }
    } catch {
      // ignore individual bootstrap error
    }
  }

  // 2. Refresh existing OPEN PRs in .state.json to see if any were MERGED or CLOSED
  const keysToCheck = Object.entries(state.prs)
    .filter(([, val]) => val && (val.state === 'OPEN' || val.changedFiles == null))
    .map(([k]) => k);

  for (const key of keysToCheck) {
    const [repo, numStr] = key.split('#');
    const num = Number(numStr);
    if (!repo || !num) continue;
    try {
      const data = await runGraphql(
        `{
          repository(owner: "${org}", name: "${repo}") {
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
        }`,
        15000
      );
      const pr = data?.data?.repository?.pullRequest;
      if (pr) {
        const cur = state.prs[key] || {};
        state.prs[key] = {
          ...cur,
          state: pr.state,
          isDraft: Boolean(pr.isDraft),
          headRefOid: pr.headRefOid,
          updatedAt: pr.updatedAt,
          createdAt: pr.createdAt ?? cur.createdAt ?? null,
          authorName: pr.author?.name ?? cur.authorName ?? null,
          additions: pr.additions ?? cur.additions ?? null,
          deletions: pr.deletions ?? cur.deletions ?? null,
          changedFiles: pr.changedFiles ?? cur.changedFiles ?? null,
          changedFilePaths: Array.isArray(pr.files?.nodes)
            ? pr.files.nodes.map((n) => n?.path).filter(Boolean)
            : cur.changedFilePaths || [],
          mergeable: pr.mergeable ?? cur.mergeable ?? null,
          mergeStateStatus: pr.mergeStateStatus ?? cur.mergeStateStatus ?? null,
          reviewDecision: pr.reviewDecision ?? cur.reviewDecision ?? null,
          labels: (pr.labels?.nodes || []).filter(Boolean).map((l) => ({
            name: l.name,
            color: l.color,
          })),
          latestReviews: (pr.latestOpinionatedReviews?.nodes || [])
            .filter((r) => r && r.author?.login)
            .map((r) => ({
              login: r.author.login,
              name: r.author.name || null,
              state: r.state,
              submittedAt: r.submittedAt,
            })),
          pendingReviewers: (pr.reviewRequests?.nodes || [])
            .map((n) => n?.requestedReviewer)
            .filter(Boolean)
            .map((req) => ({
              login: req.login || req.slug || null,
              name: req.name || req.login || req.slug || null,
              isTeam: Boolean(req.slug),
            })),
        };
      }
    } catch {
      // ignore individual refresh error
    }
  }

  // 3. Archive review files for any PR in .state.json whose state is MERGED or CLOSED
  const archivedList = [];
  const worktreesBase = path.join(projectsDir, '.review-worktrees');
  for (const [key, pr] of Object.entries(state.prs)) {
    if (!pr || pr.state === 'OPEN') continue;
    const [repoC, numC] = key.split('#');
    const wtDir = path.join(worktreesBase, `${repoC}-pr-${numC}`);
    if (fs.existsSync(wtDir)) {
      try {
        await execFileAsync(
          'git',
          ['-C', path.join(projectsDir, repoC), 'worktree', 'remove', '--force', wtDir],
          { timeout: 10000 }
        );
      } catch {
        try {
          fs.rmSync(wtDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
    const rFile = pr.reviewFile || '';
    if (rFile && fs.existsSync(path.join(reviewsDir, rFile))) {
      const sharedOpen = Object.values(state.prs).some(
        (other) => other && other.state === 'OPEN' && other.reviewFile === rFile
      );
      if (!sharedOpen) {
        fs.renameSync(path.join(reviewsDir, rFile), path.join(archiveDir, rFile));
        archivedList.push({ pr: key, file: rFile });
      }
    }
  }

  // 4. Query GitHub GraphQL for all open PRs requested for the configured user or teams
  const prFragment = `
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
    files(first: 100) { nodes { path } }
    labels(first: 10) { nodes { name color } }
    commits(last: 1) {
      totalCount
      nodes { commit { statusCheckRollup { state } } }
    }
    comments { totalCount }
    reviewThreads { totalCount }
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
  `;

  const queryBlocks = [];
  if (userLogin) {
    queryBlocks.push(`
      me: search(query: "org:${org} is:pr is:open updated:>=${cutoffDate} review-requested:${userLogin}", type: ISSUE, first: 30) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
      reviewedByMe: search(query: "org:${org} is:pr is:open updated:>=${cutoffDate} reviewed-by:${userLogin}", type: ISSUE, first: 30) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
      authoredByMe: search(query: "org:${org} is:pr is:open updated:>=${cutoffDate} author:${userLogin}", type: ISSUE, first: 30) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
      myDrafts: search(query: "org:${org} is:pr is:open is:draft updated:>=${cutoffDate} author:${userLogin}", type: ISSUE, first: 20) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
    `);
  }

  const githubTeams = Array.isArray(cfg.githubTeams) ? cfg.githubTeams : [];
  githubTeams.forEach((rawSlug, idx) => {
    const cleanSlug = String(rawSlug || '').trim().replace(new RegExp(`^${org}/`, 'i'), '');
    if (!cleanSlug) return;
    queryBlocks.push(`
      team_${idx}: search(query: "org:${org} is:pr is:open updated:>=${cutoffDate} team-review-requested:${org}/${cleanSlug}", type: ISSUE, first: 30) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
    `);
  });

  // Include drafts from the active Team Profile's primary repositories (instead of hardcoding 2cloud-services)
  const activeProfile = getActiveTeamProfile(cfg.teamProfile);
  const profileRepos = Array.isArray(activeProfile?.repos) && activeProfile.repos.length > 0
    ? activeProfile.repos.slice(0, 3)
    : ['2cloud-services'];
  profileRepos.forEach((repoName, idx) => {
    const cleanRepo = String(repoName || '').trim();
    if (!cleanRepo) return;
    queryBlocks.push(`
      draftsRepo_${idx}: search(query: "repo:${org}/${cleanRepo} is:pr is:open is:draft updated:>=${cutoffDate}", type: ISSUE, first: 20) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
    `);
  });

  const searchRes = await runGraphql(`{ ${queryBlocks.join('\n')} }`, 60000);
  const dataBuckets = searchRes?.data || {};

  const uniquePrsMap = new Map();
  for (const bucket of Object.values(dataBuckets)) {
    for (const node of bucket?.nodes || []) {
      if (!node || !node.number || !node.repository?.name) continue;
      const authorLogin = node.author?.login || '';
      if (BOT_AUTHOR_RE.test(authorLogin)) continue;
      const key = `${node.repository.name}#${node.number}`;
      if (!uniquePrsMap.has(key)) {
        uniquePrsMap.set(key, node);
      }
    }
  }

  const activePrs = [];
  for (const [key, pr] of uniquePrsMap.entries()) {
    const st = state.prs[key] || null;
    const userReviews = (pr.reviews?.nodes || []).filter(
      (r) => r && r.author?.login && r.author.login.toLowerCase() === userLogin.toLowerCase()
    );
    const lastGhReview = userReviews.length > 0 ? userReviews[userReviews.length - 1] : null;
    const localSha = st?.lastReviewedSha || null;
    const ghSha = lastGhReview?.commit?.oid || null;
    const defaultRFile = st?.reviewFile || `review-${pr.repository.name}-${pr.number}.md`;

    let syncStatus = 'NEEDS_REVIEW';
    if (localSha && localSha === pr.headRefOid) {
      syncStatus = 'UP_TO_DATE';
    } else if (pr.isDraft) {
      syncStatus = 'DRAFT';
    } else if (localSha && localSha !== pr.headRefOid) {
      syncStatus = 'NEEDS_UPDATE';
    } else if (ghSha && ghSha === pr.headRefOid) {
      syncStatus = 'REVIEWED_ON_GITHUB';
    } else if (ghSha && ghSha !== pr.headRefOid) {
      syncStatus = 'NEEDS_UPDATE';
    }

    let reviewStatus = '⏳ Pending Review';
    if (syncStatus === 'UP_TO_DATE') {
      reviewStatus = st?.reviewStatus || '✅ Reviewed';
    } else if (syncStatus === 'DRAFT') {
      reviewStatus = '📝 Draft (Manual Audit)';
    } else if (syncStatus === 'REVIEWED_ON_GITHUB') {
      reviewStatus = `✅ Reviewed on GH (${lastGhReview?.state || 'REVIEWED'})`;
    } else if (syncStatus === 'NEEDS_UPDATE') {
      reviewStatus = '🔄 Update Needed (new commits)';
    }

    const detectedJira =
      (st?.jiraKey && st.jiraKey !== '—' ? st.jiraKey : null) ||
      extractJiraKey({ title: pr.title, headRefName: pr.headRefName }, cfg.jiraPrefixes) ||
      '—';

    const item = {
      key,
      repo: pr.repository.name,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      author: pr.author?.login || 'unknown',
      authorName: pr.author?.name || st?.authorName || null,
      reviewMode:
        userLogin && pr.author?.login?.toLowerCase() === userLogin.toLowerCase()
          ? 'Self-Review'
          : 'Peer-Review',
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      createdAt: pr.createdAt || st?.createdAt || null,
      additions: pr.additions ?? st?.additions ?? null,
      deletions: pr.deletions ?? st?.deletions ?? null,
      changedFiles: pr.changedFiles ?? st?.changedFiles ?? null,
      commitsCount: pr.commits?.totalCount ?? st?.commitsCount ?? null,
      githubCommentsCount:
        (pr.comments?.totalCount || 0) + (pr.reviewThreads?.totalCount || 0) ||
        st?.githubCommentsCount ||
        0,
      changedFilePaths: Array.isArray(pr.files?.nodes)
        ? pr.files.nodes.map((n) => n?.path).filter(Boolean)
        : st?.changedFilePaths || [],
      mergeable: pr.mergeable ?? st?.mergeable ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? st?.mergeStateStatus ?? null,
      reviewDecision: pr.reviewDecision ?? st?.reviewDecision ?? null,
      labels: (pr.labels?.nodes || []).filter(Boolean).map((l) => ({
        name: l.name,
        color: l.color,
      })),
      latestReviews: (pr.latestOpinionatedReviews?.nodes || [])
        .filter((r) => r && r.author?.login)
        .map((r) => ({
          login: r.author.login,
          name: r.author.name || null,
          state: r.state,
          submittedAt: r.submittedAt,
        })),
      pendingReviewers: (pr.reviewRequests?.nodes || [])
        .map((n) => n?.requestedReviewer)
        .filter(Boolean)
        .map((req) => ({
          login: req.login || req.slug || null,
          name: req.name || req.login || req.slug || null,
          isTeam: Boolean(req.slug),
        })),
      ciState: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? st?.ciState ?? null,
      previousReviewedSha: localSha || ghSha || null,
      lastReviewedSha: localSha,
      lastGithubReviewSha: ghSha,
      lastGithubReviewState: lastGhReview?.state || null,
      updatedAt: pr.updatedAt,
      url: pr.url,
      syncStatus,
      reviewStatus,
      jiraKey: detectedJira,
      findingsSummary: st?.findingsSummary || '—',
      reviewFile:
        (syncStatus === 'REVIEWED_ON_GITHUB' || syncStatus === 'DRAFT') && !st
          ? ''
          : defaultRFile,
      lastReviewedAt: st?.lastReviewedAt || lastGhReview?.submittedAt || null,
    };

    activePrs.push(item);
    state.prs[key] = {
      ...(state.prs[key] || {}),
      ...item,
    };
  }

  writeStateFile(stateFile, state);
  generateIndexMarkdown(cfg);

  return {
    archived: archivedList,
    actionable: activePrs.filter(
      (p) => p.syncStatus === 'NEEDS_REVIEW' || p.syncStatus === 'NEEDS_UPDATE'
    ),
    drafts: activePrs.filter((p) => p.syncStatus === 'DRAFT'),
    upToDate: activePrs.filter(
      (p) => p.syncStatus === 'UP_TO_DATE' || p.syncStatus === 'REVIEWED_ON_GITHUB'
    ),
  };
}

// Allow direct CLI execution: node ui/lib/sync.mjs [scan|record|index] ...
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const cmd = process.argv[2] || 'scan';
  (async () => {
    if (cmd === 'record') {
      const [repo, prNumber, headSha, reviewStatus, findingsSummary, jiraKey, reviewFile] =
        process.argv.slice(3);
      if (!repo || !prNumber || !headSha || !reviewStatus) {
        console.error(
          'Usage: sync-queue.sh record <repo> <pr_number> <head_sha> <review_status> [findings_summary] [jira_key] [review_file]'
        );
        process.exit(1);
      }
      const res = recordPrReview({
        repo,
        number: Number(prNumber),
        headSha,
        reviewStatus,
        findingsSummary: findingsSummary || '0 findings',
        jiraKey: jiraKey || '—',
        reviewFile: reviewFile || `review-${repo}-${prNumber}.md`,
      });
      console.log(
        `Recorded review for ${res.key} at SHA ${String(headSha).slice(0, 7)} and updated ${res.indexFile}`
      );
      process.exit(0);
    }

    if (cmd === 'index') {
      const indexFile = generateIndexMarkdown();
      console.log(`Regenerated ${indexFile}`);
      process.exit(0);
    }

    const report = await scanPrQueue();
    console.log(JSON.stringify(report, null, 2));
  })().catch((err) => {
    console.error(err.message || String(err));
    process.exit(1);
  });
}
