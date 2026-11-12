#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  parseFindingsFromMarkdown,
  resolveFindingAgainstDiff,
} from './lib/parser.mjs';
import {
  loadConfig,
  saveConfig,
  discoverGithubIdentityAndTeams,
  ensureConfigBootstrapped,
} from './lib/config.mjs';
import {
  computeAuthorInitials,
  resolveAuthorDisplayName,
  formatPersonDisplayName,
  extractJiraKey,
  detectStackedPr,
  normalizeCiState,
  DEFAULT_TEAM_MEMBERS,
  parseCodeOwners,
  computeMergeReadiness,
} from './lib/metadata.mjs';
import {
  getProjectsDir,
  getLocalRepoPath,
  getWorktreePath,
  ensurePrCommitFetched,
  listTreeAtCommit,
  readBlobAtCommit,
  grepAtCommit,
  getWorktreeStatus,
  mountWorktree,
  unmountWorktree,
  openWorktreeInIde,
} from './lib/worktree.mjs';
import {
  getAgentJobs,
  getPrChatHistory,
  getPrChatStatus,
  triggerPrReview,
  sendPrChatMessage,
  dismissFindingAsFalsePositive,
} from './lib/agent.mjs';
import {
  listAllRules,
  listTeamProfiles,
  saveTeamProfile,
  addRule,
  updateRule,
  deleteRule,
  decideCandidateRule,
  approveAllCandidateRules,
  syncCombinedReferenceFiles,
} from './lib/rules.mjs';
import { bootstrapTeamCandidateRules } from './lib/onboarding.mjs';
import {
  runDoctor,
  listRexFeedback,
  addRexFeedback,
  deleteRexFeedback,
  formatRexMarkdownReport,
} from './lib/doctor.mjs';
import { scanPrQueue } from './lib/sync.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT_DIR = path.resolve(__dirname, '..');

function getAppVersion() {
  try {
    return fs.readFileSync(path.join(SKILL_ROOT_DIR, 'VERSION'), 'utf8').trim() || '1.1.0';
  } catch {
    return '1.1.0';
  }
}

const prOverviewCache = new Map();
let customOverviewHandlerForTests = null;

export function setCustomOverviewHandlerForTests(fn) {
  customOverviewHandlerForTests = fn;
}

function getOverviewCacheFilePath(cacheDir, repo, number) {
  const safeRepo = String(repo || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(cacheDir, `overview-${safeRepo}-${Number(number)}.json`);
}

function invalidatePrOverviewCache(repo, number) {
  if (!repo || !number) return;
  prOverviewCache.delete(`${repo}#${number}`);
  try {
    const { cacheDir } = getPaths();
    const cacheFile = getOverviewCacheFilePath(cacheDir, repo, number);
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
  } catch {
    // ignore unlink error
  }
}

async function fetchPrOverviewFromGitHub(cfg, repo, number, forceRefresh = false) {
  if (customOverviewHandlerForTests) {
    return customOverviewHandlerForTests({ action: 'overview', cfg, repo, number, forceRefresh });
  }
  const cacheKey = `${repo}#${number}`;
  const now = Date.now();
  const cached = prOverviewCache.get(cacheKey);
  if (!forceRefresh && cached && now - cached.fetchedAt < 180_000) {
    return cached.data;
  }

  let cacheFile = null;
  let statePr = null;
  try {
    const { cacheDir, stateFile } = getPaths();
    cacheFile = getOverviewCacheFilePath(cacheDir, repo, number);
    const state = readJsonSafe(stateFile, { prs: {} });
    statePr = state.prs?.[cacheKey] || null;
    if (!forceRefresh && cacheFile && fs.existsSync(cacheFile)) {
      const diskPayload = readJsonSafe(cacheFile, null);
      if (diskPayload && diskPayload.data && typeof diskPayload.data === 'object') {
        const expectedSha = statePr?.headRefOid || '';
        const cachedSha = diskPayload.data.headRefOid || '';
        const shaMatches = !expectedSha || !cachedSha || expectedSha === cachedSha;
        if (shaMatches) {
          prOverviewCache.set(cacheKey, {
            fetchedAt: diskPayload.fetchedAt || now,
            data: diskPayload.data,
          });
          return diskPayload.data;
        }
      }
    }
  } catch {
    // ignore disk cache read errors
  }

  const org = cfg.githubOrg || 'ubitransports';
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          number
          title
          body
          state
          isDraft
          createdAt
          updatedAt
          url
          additions
          deletions
          changedFiles
          baseRefName
          headRefName
          headRefOid
          author {
            login
            ... on User { name }
          }
          commits(first: 100) {
            totalCount
            nodes {
              commit {
                oid
                abbreviatedOid
                messageHeadline
                messageBody
                committedDate
                url
                author {
                  name
                  user { login }
                }
              }
            }
          }
          comments(first: 100) {
            totalCount
            nodes {
              id
              databaseId
              body
              createdAt
              url
              author {
                login
                ... on User { name }
              }
            }
          }
          reviews(first: 50) {
            totalCount
            nodes {
              id
              databaseId
              state
              body
              submittedAt
              url
              commit { abbreviatedOid }
              author {
                login
                ... on User { name }
              }
            }
          }
          reviewThreads(first: 100) {
            totalCount
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              startLine
              diffSide
              comments(first: 50) {
                nodes {
                  id
                  databaseId
                  body
                  createdAt
                  url
                  diffHunk
                  author {
                    login
                    ... on User { name }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${org}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `number=${Number(number)}`,
      ],
      { maxBuffer: 25 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout);
    const prNode = parsed?.data?.repository?.pullRequest;
    if (!prNode) {
      throw new Error(`Pull request ${repo}#${number} not found on GitHub`);
    }

    const commits = (prNode.commits?.nodes || [])
      .map((n) => n?.commit)
      .filter(Boolean)
      .map((c) => ({
        oid: c.oid,
        shortOid: c.abbreviatedOid || String(c.oid || '').slice(0, 7),
        messageHeadline: c.messageHeadline || '',
        messageBody: c.messageBody || '',
        committedDate: c.committedDate || null,
        url: c.url || '',
        authorLogin: c.author?.user?.login || '',
        authorName: formatPersonDisplayName({
          login: c.author?.user?.login || '',
          name: c.author?.name || '',
        }),
      }));

    const generalComments = (prNode.comments?.nodes || [])
      .filter(
        (c) => c && !/^(ci-cd-matawan|dependabot|renovate|github-actions)/i.test(c.author?.login || '')
      )
      .map((c) => ({
        id: c.id,
        databaseId: c.databaseId,
        body: c.body || '',
        createdAt: c.createdAt,
        url: c.url || '',
        authorLogin: c.author?.login || '',
        authorName: formatPersonDisplayName({
          login: c.author?.login || '',
          name: c.author?.name || '',
        }),
      }));

    const reviews = (prNode.reviews?.nodes || [])
      .filter(
        (r) =>
          r &&
          (r.body?.trim() || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') &&
          !/^(ci-cd-matawan|dependabot|renovate|github-actions)/i.test(r.author?.login || '')
      )
      .map((r) => ({
        id: r.id,
        databaseId: r.databaseId,
        state: r.state,
        body: r.body || '',
        submittedAt: r.submittedAt,
        url: r.url || '',
        commitShortOid: r.commit?.abbreviatedOid || '',
        authorLogin: r.author?.login || '',
        authorName: formatPersonDisplayName({
          login: r.author?.login || '',
          name: r.author?.name || '',
        }),
      }));

    const reviewThreads = (prNode.reviewThreads?.nodes || [])
      .filter((t) => t && (t.comments?.nodes || []).length > 0)
      .map((t) => {
        const comments = (t.comments?.nodes || []).map((c) => ({
          id: c.id,
          databaseId: c.databaseId,
          body: c.body || '',
          createdAt: c.createdAt,
          url: c.url || '',
          diffHunk: c.diffHunk || '',
          authorLogin: c.author?.login || '',
          authorName: formatPersonDisplayName({
            login: c.author?.login || '',
            name: c.author?.name || '',
          }),
        }));
        return {
          id: t.id,
          isResolved: Boolean(t.isResolved),
          isOutdated: Boolean(t.isOutdated),
          path: t.path || '',
          line: t.line || t.startLine || null,
          startLine: t.startLine || null,
          diffSide: t.diffSide || 'RIGHT',
          createdAt: comments[0]?.createdAt || null,
          comments,
        };
      });

    const data = {
      repo,
      number: Number(number),
      title: prNode.title || '',
      body: prNode.body || '',
      state: prNode.state || 'OPEN',
      isDraft: Boolean(prNode.isDraft),
      createdAt: prNode.createdAt,
      updatedAt: prNode.updatedAt,
      url: prNode.url || '',
      baseRefName: prNode.baseRefName || '',
      headRefName: prNode.headRefName || '',
      headRefOid: prNode.headRefOid || '',
      authorLogin: prNode.author?.login || '',
      authorName: formatPersonDisplayName({
        login: prNode.author?.login || '',
        name: prNode.author?.name || '',
      }),
      commitsCount: prNode.commits?.totalCount ?? commits.length,
      commentsCount: generalComments.length + reviewThreads.length,
      commits,
      generalComments,
      reviews,
      reviewThreads,
    };

    prOverviewCache.set(cacheKey, { fetchedAt: now, data });
    if (cacheFile) {
      try {
        writeJsonSafe(cacheFile, { fetchedAt: now, data });
      } catch {
        // ignore disk cache write errors
      }
    }
    return data;
  } catch (err) {
    return {
      repo,
      number: Number(number),
      title: '',
      body: '',
      state: 'OPEN',
      isDraft: false,
      commitsCount: 0,
      commentsCount: 0,
      commits: [],
      generalComments: [],
      reviews: [],
      reviewThreads: [],
      offlineError: err.message,
    };
  }
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getPaths() {
  const cfg = loadConfig();
  const reviewsDir = cfg.reviewsDir;
  const archiveDir = path.join(reviewsDir, 'archive');
  const cacheDir = path.join(reviewsDir, '.cache');
  const stateFile = path.join(reviewsDir, '.state.json');
  const uiStateFile = path.join(reviewsDir, '.ui-state.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  return { cfg, reviewsDir, archiveDir, cacheDir, stateFile, uiStateFile };
}

async function fetchPrDiffFiles(repo, number, sha = 'latest') {
  const { cfg, cacheDir } = getPaths();
  const safeSha = (sha || 'latest').slice(0, 12);
  const cacheFile = path.join(cacheDir, `diff-${repo}-${number}-${safeSha}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = readJsonSafe(cacheFile, []);
    // If legacy non-paginated cache hit the exact 100-file boundary, re-fetch with pagination
    if (Array.isArray(cached) && cached.length !== 100) {
      return cached;
    }
  }

  const { stdout } = await execFileAsync(
    'gh',
    ['api', '--paginate', '--slurp', `repos/${cfg.githubOrg}/${repo}/pulls/${number}/files?per_page=100`],
    { maxBuffer: 50 * 1024 * 1024 }
  );

  const parsed = JSON.parse(stdout);
  const files = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed.flat() : parsed;
  writeJsonSafe(cacheFile, files);
  return files;
}

const codeOwnersCache = new Map();

function loadRepoCodeOwners(projectsDir, repo) {
  if (!repo) return [];
  if (codeOwnersCache.has(repo)) {
    return codeOwnersCache.get(repo);
  }
  const repoPath = getLocalRepoPath(projectsDir, repo);
  const candidates = [
    path.join(repoPath, '.github', 'CODEOWNERS'),
    path.join(repoPath, 'CODEOWNERS'),
    path.join(repoPath, 'docs', 'CODEOWNERS'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const rules = parseCodeOwners(fs.readFileSync(candidate, 'utf8'));
        codeOwnersCache.set(repo, rules);
        return rules;
      } catch {
        // ignore read error
      }
    }
  }
  codeOwnersCache.set(repo, []);
  return [];
}

let teamMembersRefreshInFlight = false;

function loadTeamMembersMap(cacheDir, githubOrg = 'ubitransports') {
  const cacheFile = path.join(cacheDir, 'team-members.json');
  const cached = readJsonSafe(cacheFile, null);
  const now = Date.now();
  const ttlMs = 6 * 3600 * 1000;

  if ((!cached || !cached.updatedAt || now - cached.updatedAt > ttlMs) && !teamMembersRefreshInFlight) {
    teamMembersRefreshInFlight = true;
    const slugs = Object.keys(DEFAULT_TEAM_MEMBERS);
    Promise.all(
      slugs.map(async (slug) => {
        try {
          const { stdout } = await execFileAsync(
            'gh',
            ['api', `orgs/${githubOrg}/teams/${slug}/members`, '--jq', '[.[].login]'],
            { timeout: 10000 }
          );
          const logins = JSON.parse(stdout);
          return [slug, Array.isArray(logins) && logins.length > 0 ? logins : DEFAULT_TEAM_MEMBERS[slug]];
        } catch {
          return [slug, DEFAULT_TEAM_MEMBERS[slug]];
        }
      })
    )
      .then((entries) => {
        const members = { ...DEFAULT_TEAM_MEMBERS, ...Object.fromEntries(entries) };
        writeJsonSafe(cacheFile, { updatedAt: Date.now(), members });
      })
      .catch(() => {})
      .finally(() => {
        teamMembersRefreshInFlight = false;
      });
  }

  return {
    ...DEFAULT_TEAM_MEMBERS,
    ...(cached && typeof cached.members === 'object' ? cached.members : {}),
  };
}

let prCachesWarmInFlight = false;

function warmOpenPrCachesInBackground(prs, cfg) {
  if (prCachesWarmInFlight || process.env.NODE_ENV === 'test' || process.env.REVIEW_HUB_CONFIG) {
    return;
  }
  const openPrs = (Array.isArray(prs) ? prs : []).filter(
    (p) => !p.isArchived && p.repo && p.number
  );
  if (openPrs.length === 0) return;

  prCachesWarmInFlight = true;
  (async () => {
    try {
      const { cacheDir } = getPaths();
      // Warm non-draft open PRs first, then drafts
      const ordered = [
        ...openPrs.filter((p) => !p.isDraft),
        ...openPrs.filter((p) => p.isDraft),
      ];
      const concurrency = 2;
      let idx = 0;
      const worker = async () => {
        while (idx < ordered.length) {
          const pr = ordered[idx++];
          if (!pr) continue;
          const safeSha = (pr.headRefOid || pr.lastReviewedSha || 'latest').slice(0, 12);
          const diffCacheFile = path.join(cacheDir, `diff-${pr.repo}-${pr.number}-${safeSha}.json`);
          const ovCacheFile = getOverviewCacheFilePath(cacheDir, pr.repo, pr.number);
          try {
            if (!fs.existsSync(diffCacheFile)) {
              await fetchPrDiffFiles(pr.repo, pr.number, pr.headRefOid || pr.lastReviewedSha || 'latest');
            }
          } catch {
            // ignore background diff warm error
          }
          try {
            let needOverview = !fs.existsSync(ovCacheFile);
            if (!needOverview) {
              const diskOv = readJsonSafe(ovCacheFile, null);
              if (
                !diskOv?.data ||
                (pr.headRefOid && diskOv.data.headRefOid && diskOv.data.headRefOid !== pr.headRefOid)
              ) {
                needOverview = true;
              }
            }
            if (needOverview) {
              await fetchPrOverviewFromGitHub(cfg, pr.repo, pr.number, false);
            }
          } catch {
            // ignore background overview warm error
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      prCachesWarmInFlight = false;
    }
  })();
}

export function buildStateResponse() {
  const { cfg, reviewsDir, archiveDir, cacheDir, stateFile, uiStateFile } = getPaths();
  const projectsDir = getProjectsDir(cfg);
  const state = readJsonSafe(stateFile, { prs: {} });
  const uiState = readJsonSafe(uiStateFile, { comments: {}, manualComments: {} });
  const prsMap = state.prs || {};
  const jobs = getAgentJobs();
  const teamMembersMap = loadTeamMembersMap(cacheDir, cfg.githubOrg);

  const activeFiles = fs.existsSync(reviewsDir)
    ? fs.readdirSync(reviewsDir).filter((f) => f.startsWith('review-') && f.endsWith('.md'))
    : [];
  const archivedFiles = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((f) => f.startsWith('review-') && f.endsWith('.md'))
    : [];

  const prs = Object.entries(prsMap).map(([key, pr]) => {
    const reviewFile = pr.reviewFile || '';
    const isArchivedFile = Boolean(reviewFile && archivedFiles.includes(reviewFile));
    const hasActiveFile = Boolean(reviewFile && activeFiles.includes(reviewFile));

    let findingsCount = 0;
    let postedCount = 0;
    let dismissedCount = 0;
    if (reviewFile && (hasActiveFile || isArchivedFile)) {
      const fullPath = isArchivedFile ? path.join(archiveDir, reviewFile) : path.join(reviewsDir, reviewFile);
      try {
        const md = fs.readFileSync(fullPath, 'utf8');
        const parsed = parseFindingsFromMarkdown(md);
        findingsCount = parsed.length;
        for (const f of parsed) {
          const cid = `${key}::${f.id}`;
          if (uiState.comments?.[cid]?.posted) postedCount++;
          if (uiState.comments?.[cid]?.dismissed) dismissedCount++;
        }
      } catch {
        // ignore read error
      }
    }

    const manualForPr = Array.isArray(uiState.manualComments?.[key]) ? uiState.manualComments[key] : [];
    for (const m of manualForPr) {
      findingsCount++;
      if (uiState.comments?.[m.cid]?.posted || m.posted) postedCount++;
      if (uiState.comments?.[m.cid]?.dismissed || m.dismissed) dismissedCount++;
    }

    const authorInitials = computeAuthorInitials({ login: pr.author, name: pr.authorName });
    const authorDisplayName = resolveAuthorDisplayName({ login: pr.author, name: pr.authorName });
    const resolvedJira = extractJiraKey(pr, cfg.jiraPrefixes);
    const stackInfo = detectStackedPr(pr);
    const ciStatus = normalizeCiState(pr.ciState);
    const wtPath = getWorktreePath(projectsDir, pr.repo, pr.number);
    const worktreeMounted = fs.existsSync(wtPath);
    const runningJob = jobs.find((j) => j.prKey === key && j.status === 'running') || null;
    const lastFailedJob =
      jobs.find((j) => j.prKey === key && j.status === 'failed') || null;

    // Resolve full names for approvals, changes requested, comments, and pending reviewers
    const latestReviews = Array.isArray(pr.latestReviews) ? pr.latestReviews : [];
    const approvedBy = [];
    const changesRequestedBy = [];
    const commentedBy = [];
    for (const rev of latestReviews) {
      if (!rev || !rev.login) continue;
      // Skip bots
      if (/^(ci-cd-matawan|dependabot|renovate|github-actions)/i.test(rev.login)) continue;
      const personLabel = formatPersonDisplayName({ login: rev.login, name: rev.name });
      if (rev.state === 'APPROVED' && !approvedBy.includes(personLabel)) {
        approvedBy.push(personLabel);
      } else if (rev.state === 'CHANGES_REQUESTED' && !changesRequestedBy.includes(personLabel)) {
        changesRequestedBy.push(personLabel);
      } else if (rev.state === 'COMMENTED' && !commentedBy.includes(personLabel)) {
        commentedBy.push(personLabel);
      }
    }

    const pendingReviewers = (Array.isArray(pr.pendingReviewers) ? pr.pendingReviewers : [])
      .map((req) => {
        if (!req) return null;
        if (req.isTeam) {
          return req.name || req.login;
        }
        return formatPersonDisplayName({
          login: req.login,
          name: req.name && req.name !== req.login ? req.name : '',
        });
      })
      .filter(Boolean);

    const codeOwnersRules = loadRepoCodeOwners(projectsDir, pr.repo);
    const mergeReadiness = computeMergeReadiness({
      pr,
      ciStatus,
      codeOwnersRules,
      teamMembersMap,
    });

    return {
      ...pr,
      key,
      isDraft: Boolean(pr.isDraft),
      jiraKey: resolvedJira || pr.jiraKey || '—',
      authorInitials,
      authorDisplayName,
      approvedBy,
      changesRequestedBy,
      commentedBy,
      pendingReviewers,
      mergeReadiness,
      requiredOwnerTeams: mergeReadiness.requiredOwnerTeams,
      isMergeable: mergeReadiness.isMergeable,
      isStacked: stackInfo.isStacked,
      ciStatus,
      worktreeMounted,
      worktreePath: worktreeMounted ? wtPath : null,
      runningJob,
      lastFailedJob,
      isArchived: Boolean(pr.state !== 'OPEN' || isArchivedFile),
      hasReviewFile: Boolean(hasActiveFile || isArchivedFile),
      findingsCount,
      postedCount,
      dismissedCount,
    };
  });

  prs.sort((a, b) => {
    if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
    return String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || ''));
  });

  return {
    prs,
    uiState,
    config: cfg,
    jobs,
    version: getAppVersion(),
    neverSynced: !fs.existsSync(stateFile),
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

export function createHubServer() {
  try {
    ensureConfigBootstrapped();
  } catch {
    // ignore bootstrap error
  }
  try {
    const initialCfg = loadConfig();
    syncCombinedReferenceFiles(initialCfg.teamProfile);
  } catch {
    // ignore startup sync error
  }
  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const pathname = urlObj.pathname;
      const { cfg, reviewsDir, archiveDir, stateFile, uiStateFile } = getPaths();
      const projectsDir = getProjectsDir(cfg);

      if (req.method === 'GET' && pathname === '/api/state') {
        const statePayload = buildStateResponse();
        warmOpenPrCachesInBackground(statePayload.prs, cfg);
        return sendJson(res, 200, statePayload);
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, { config: cfg, version: getAppVersion() });
      }

      if (req.method === 'GET' && pathname === '/api/models') {
        const { exec } = require('child_process');
        const cli = urlObj.searchParams.get('cli') || 'agy';
        try {
          if (cli === 'agy') {
            exec('agy models', { encoding: 'utf8', env: process.env }, (err, stdout) => {
               const models = (stdout || '').split('\n').filter(Boolean).map(line => {
                 const [id, ...rest] = line.trim().split(/\s+/);
                 if (id && !id.includes('Fetching')) return { id, name: rest.join(' ') };
                 return null;
               }).filter(Boolean);
               return sendJson(res, 200, { models });
            });
            return;
          }
          
          const staticModels = {
             gemini: [
               { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
               { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
               { id: 'gemini-2.0-pro-exp-02-05', name: 'Gemini 2.0 Pro Experimental' }
             ],
             claude: [
               { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
               { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' }
             ]
          };
          return sendJson(res, 200, { models: staticModels[cli] || [] });
        } catch (err) {
          console.error("SERVER 500 ERROR:", err); return sendJson(res, 500, { error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readRequestBody(req);
        const updated = saveConfig(body);
        try {
          syncCombinedReferenceFiles(updated.teamProfile);
        } catch {
          // ignore
        }
        return sendJson(res, 200, { ok: true, config: updated });
      }

      if (req.method === 'GET' && pathname === '/api/doctor') {
        const report = await runDoctor(cfg);
        return sendJson(res, 200, { version: getAppVersion(), ...report });
      }

      if (req.method === 'GET' && pathname === '/api/rex') {
        const version = getAppVersion();
        const items = listRexFeedback(cfg);
        const markdown = formatRexMarkdownReport({ items, cfg, version });
        return sendJson(res, 200, { items, markdown, version });
      }

      if (req.method === 'POST' && pathname === '/api/rex') {
        const body = await readRequestBody(req);
        const version = getAppVersion();
        const item = addRexFeedback(cfg, body, version);
        const items = listRexFeedback(cfg);
        const markdown = formatRexMarkdownReport({ items, cfg, version });
        return sendJson(res, 200, { ok: true, item, items, markdown, version });
      }

      if (req.method === 'DELETE' && pathname === '/api/rex') {
        const body = await readRequestBody(req);
        const id = body.id || urlObj.searchParams.get('id') || '';
        if (!id) {
          return sendJson(res, 400, { error: 'Missing feedback item id' });
        }
        const version = getAppVersion();
        const resDel = deleteRexFeedback(cfg, id);
        const items = listRexFeedback(cfg);
        const markdown = formatRexMarkdownReport({ items, cfg, version });
        return sendJson(res, 200, { ok: true, ...resDel, items, markdown, version });
      }

      if (req.method === 'GET' && pathname === '/api/app-update') {
        const version = getAppVersion();
        let behindCount = 0;
        let latestCommitSubject = '';
        try {
          if (fs.existsSync(path.join(SKILL_ROOT_DIR, '.git'))) {
            await execFileAsync('git', ['-C', SKILL_ROOT_DIR, 'fetch', 'origin', 'main', '--quiet'], {
              timeout: 7000,
            });
            const { stdout: countOut } = await execFileAsync(
              'git',
              ['-C', SKILL_ROOT_DIR, 'rev-list', 'HEAD..origin/main', '--count'],
              { timeout: 4000 }
            );
            behindCount = parseInt(String(countOut || '0').trim(), 10) || 0;
            if (behindCount > 0) {
              const { stdout: subjOut } = await execFileAsync(
                'git',
                ['-C', SKILL_ROOT_DIR, 'log', '-1', '--format=%s', 'origin/main'],
                { timeout: 4000 }
              );
              latestCommitSubject = String(subjOut || '').trim();
            }
          }
        } catch {
          // ignore network / git errors
        }
        return sendJson(res, 200, {
          version,
          updateAvailable: behindCount > 0,
          behindCount,
          latestCommitSubject,
        });
      }

      if (req.method === 'POST' && pathname === '/api/app-update') {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', SKILL_ROOT_DIR, 'pull', '--rebase', '--autostash', 'origin', 'main'],
          { timeout: 25000 }
        );
        try {
          syncCombinedReferenceFiles(cfg.teamProfile);
        } catch {
          // ignore
        }
        return sendJson(res, 200, {
          ok: true,
          version: getAppVersion(),
          output: String(stdout || '').trim(),
        });
      }

      if (req.method === 'GET' && pathname === '/api/github/teams') {
        const orgParam = urlObj.searchParams.get('org') || cfg.githubOrg;
        const discovery = await discoverGithubIdentityAndTeams(orgParam);
        return sendJson(res, 200, discovery);
      }

      if (req.method === 'GET' && pathname === '/api/export-zip') {
        const pkgScript = path.resolve(__dirname, '../scripts/package-shareable-zip.sh');
        const zipOutPath = path.join(reviewsDir, 'pr-review-hub-shareable.zip');
        await execFileAsync(pkgScript, [zipOutPath], { timeout: 60000 });
        const zipBuffer = fs.readFileSync(zipOutPath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="pr-review-hub-shareable.zip"',
          'Content-Length': zipBuffer.length,
          'Cache-Control': 'no-store',
        });
        return res.end(zipBuffer);
      }

      if (req.method === 'GET' && pathname === '/api/review') {
        const file = urlObj.searchParams.get('file') || '';
        const prKey = urlObj.searchParams.get('key') || '';
        if (file && (file.includes('..') || file.includes('/'))) {
          return sendJson(res, 400, { error: 'Invalid review file name' });
        }

        const uiState = readJsonSafe(uiStateFile, { comments: {}, manualComments: {} });
        const manualRaw = Array.isArray(uiState.manualComments?.[prKey])
          ? uiState.manualComments[prKey]
          : [];
        const manualFindings = manualRaw.map((m) => {
          const saved = uiState.comments?.[m.cid] || {};
          return {
            ...m,
            isManual: true,
            posted: Boolean(saved.posted ?? m.posted),
            postedAt: saved.postedAt || m.postedAt || null,
            postedUrl: saved.postedUrl || m.postedUrl || null,
            dismissed: Boolean(saved.dismissed ?? m.dismissed),
            dismissReason: saved.dismissReason || m.dismissReason || null,
            customComment: saved.customComment ?? m.customComment ?? m.comment,
          };
        });

        let fullPath = file ? path.join(reviewsDir, file) : '';
        let archived = false;
        if (file && !fs.existsSync(fullPath)) {
          fullPath = path.join(archiveDir, file);
          archived = true;
        }
        if (!file || !fs.existsSync(fullPath)) {
          if (manualFindings.length > 0) {
            return sendJson(res, 200, {
              file: file || null,
              archived: false,
              markdown: '',
              findings: manualFindings,
            });
          }
          return sendJson(res, 404, { error: 'Review file not found' });
        }

        const markdown = fs.readFileSync(fullPath, 'utf8');
        const rawFindings = parseFindingsFromMarkdown(markdown);

        const aiFindings = rawFindings.map((f) => {
          const cid = `${prKey}::${f.id}`;
          const saved = uiState.comments?.[cid] || {};
          return {
            ...f,
            cid,
            posted: Boolean(saved.posted),
            postedAt: saved.postedAt || null,
            postedUrl: saved.postedUrl || null,
            dismissed: Boolean(saved.dismissed),
            dismissReason: saved.dismissReason || null,
            customComment: saved.customComment ?? f.comment,
          };
        });

        return sendJson(res, 200, {
          file,
          archived,
          markdown,
          findings: [...aiFindings, ...manualFindings],
        });
      }

      if (req.method === 'GET' && pathname === '/api/diff') {
        const repo = urlObj.searchParams.get('repo');
        const number = urlObj.searchParams.get('number');
        const sha = urlObj.searchParams.get('sha') || 'latest';
        const reviewFile = urlObj.searchParams.get('reviewFile') || '';
        const prKey = `${repo}#${number}`;

        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }

        const files = await fetchPrDiffFiles(repo, number, sha);
        const uiState = readJsonSafe(uiStateFile, { comments: {}, manualComments: {} });
        let resolvedFindings = [];

        if (reviewFile && !reviewFile.includes('..')) {
          let fullPath = path.join(reviewsDir, reviewFile);
          if (!fs.existsSync(fullPath)) fullPath = path.join(archiveDir, reviewFile);
          if (fs.existsSync(fullPath)) {
            const md = fs.readFileSync(fullPath, 'utf8');
            resolvedFindings = parseFindingsFromMarkdown(md).map((f) => {
              const cid = `${prKey}::${f.id}`;
              const saved = uiState.comments?.[cid] || {};
              const resolution = resolveFindingAgainstDiff(f, files);
              return {
                ...f,
                ...resolution,
                cid,
                posted: Boolean(saved.posted),
                dismissed: Boolean(saved.dismissed),
                customComment: saved.customComment ?? f.comment,
              };
            });
          }
        }

        const manualRaw = Array.isArray(uiState.manualComments?.[prKey])
          ? uiState.manualComments[prKey]
          : [];
        const resolvedManual = manualRaw.map((m) => {
          const saved = uiState.comments?.[m.cid] || {};
          const resolution = resolveFindingAgainstDiff(m, files);
          return {
            ...m,
            ...resolution,
            resolvedPath: resolution.resolvedPath || m.filePath,
            resolvedLine: resolution.resolvedLine || m.endLine || m.startLine || 1,
            isManual: true,
            posted: Boolean(saved.posted ?? m.posted),
            dismissed: Boolean(saved.dismissed ?? m.dismissed),
            customComment: saved.customComment ?? m.customComment ?? m.comment,
          };
        });

        return sendJson(res, 200, {
          files,
          resolvedFindings: [...resolvedFindings, ...resolvedManual],
        });
      }

      if (req.method === 'POST' && pathname === '/api/manual-comments') {
        const body = await readRequestBody(req);
        const {
          prKey = '',
          cid = '',
          filePath = '',
          line = 1,
          startLine = null,
          endLine = null,
          title = '',
          comment = '',
          severity = 'minor',
        } = body;
        if (!prKey || !comment.trim()) {
          return sendJson(res, 400, { error: 'Missing prKey or comment' });
        }

        const uiState = readJsonSafe(uiStateFile, { comments: {}, manualComments: {} });
        if (!uiState.comments) uiState.comments = {};
        if (!uiState.manualComments) uiState.manualComments = {};
        if (!Array.isArray(uiState.manualComments[prKey])) {
          uiState.manualComments[prKey] = [];
        }

        const list = uiState.manualComments[prKey];
        const rawStart = Number(startLine ?? line) || 1;
        const rawEnd = Number(endLine ?? line ?? rawStart) || rawStart;
        const startLineNum = Math.max(1, Math.min(rawStart, rawEnd));
        const endLineNum = Math.max(startLineNum, Math.max(rawStart, rawEnd));
        const rangeLabel =
          startLineNum !== endLineNum ? `${startLineNum}-${endLineNum}` : `${endLineNum}`;
        const shortBase = filePath ? filePath.split('/').pop() : 'PR';
        let savedItem = null;

        if (cid) {
          const existingIdx = list.findIndex((item) => item.cid === cid);
          if (existingIdx >= 0) {
            const hasLineOverride = startLine !== null || endLine !== null || body.line !== undefined;
            list[existingIdx] = {
              ...list[existingIdx],
              ...(hasLineOverride
                ? { startLine: startLineNum, endLine: endLineNum }
                : {}),
              title: title.trim() || list[existingIdx].title,
              comment: comment.trim(),
              customComment: comment.trim(),
              severity: severity || list[existingIdx].severity || 'minor',
              updatedAt: new Date().toISOString(),
            };
            savedItem = list[existingIdx];
          }
        }

        if (!savedItem) {
          const nextIndex = list.length + 1;
          const id = `#M${nextIndex}`;
          const newCid = `${prKey}::${id}-${Date.now()}`;
          savedItem = {
            id,
            cid: newCid,
            prKey,
            filePath,
            startLine: startLineNum,
            endLine: endLineNum,
            title: title.trim() || `Comment on ${shortBase}:${rangeLabel}`,
            severity: severity || 'minor',
            category: 'Manual Comment',
            comment: comment.trim(),
            customComment: comment.trim(),
            isManual: true,
            posted: false,
            dismissed: false,
            createdAt: new Date().toISOString(),
          };
          list.push(savedItem);
        }

        uiState.comments[savedItem.cid] = {
          ...(uiState.comments[savedItem.cid] || {}),
          customComment: savedItem.customComment,
        };

        writeJsonSafe(uiStateFile, uiState);
        return sendJson(res, 200, {
          ok: true,
          comment: savedItem,
          manualComments: list,
        });
      }

      if (req.method === 'DELETE' && pathname === '/api/manual-comments') {
        const body = await readRequestBody(req);
        const { prKey = '', cid = '' } = body;
        if (!prKey || !cid) {
          return sendJson(res, 400, { error: 'Missing prKey or cid' });
        }

        const uiState = readJsonSafe(uiStateFile, { comments: {}, manualComments: {} });
        if (Array.isArray(uiState.manualComments?.[prKey])) {
          uiState.manualComments[prKey] = uiState.manualComments[prKey].filter(
            (item) => item.cid !== cid
          );
        }
        if (uiState.comments?.[cid]) {
          delete uiState.comments[cid];
        }
        writeJsonSafe(uiStateFile, uiState);
        return sendJson(res, 200, {
          ok: true,
          manualComments: uiState.manualComments?.[prKey] || [],
        });
      }

      // =========================================================================
      // Working Tree & On-Demand Git Worktree Endpoints
      // =========================================================================
      if (req.method === 'GET' && pathname === '/api/tree') {
        const repo = urlObj.searchParams.get('repo');
        const number = urlObj.searchParams.get('number');
        const sha = urlObj.searchParams.get('sha') || '';
        const dirPath = urlObj.searchParams.get('path') || '';
        const recursive = urlObj.searchParams.get('recursive') === '1';

        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }

        const repoPath = getLocalRepoPath(projectsDir, repo);
        const commitRef = await ensurePrCommitFetched(repoPath, number, sha);
        const treeData = await listTreeAtCommit(repoPath, commitRef, dirPath, recursive);
        const wtStatus = await getWorktreeStatus(projectsDir, repo, number);

        return sendJson(res, 200, {
          ...treeData,
          commitRef,
          worktree: wtStatus,
        });
      }

      if (req.method === 'GET' && pathname === '/api/blob') {
        const repo = urlObj.searchParams.get('repo');
        const number = urlObj.searchParams.get('number');
        const sha = urlObj.searchParams.get('sha') || '';
        const filePath = urlObj.searchParams.get('path') || '';

        if (!repo || !number || !filePath) {
          return sendJson(res, 400, { error: 'Missing repo, number, or path' });
        }

        const cleanPath = String(filePath).replace(/^\/+/, '');
        if (cleanPath.includes('..')) {
          return sendJson(res, 400, { error: 'Invalid file path' });
        }

        const repoPath = getLocalRepoPath(projectsDir, repo);
        try {
          const commitRef = await ensurePrCommitFetched(repoPath, number, sha);
          const blob = await readBlobAtCommit(repoPath, commitRef, cleanPath);
          return sendJson(res, 200, { ...blob, commitRef });
        } catch (localErr) {
          // Fallback to GitHub REST API if local repository or commit is not available locally
          try {
            const refQuery = sha && sha !== 'latest' ? `?ref=${encodeURIComponent(sha)}` : '';
            const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
            const { stdout } = await execFileAsync(
              'gh',
              [
                'api',
                '-H',
                'Accept: application/vnd.github.raw+json',
                `repos/${cfg.githubOrg}/${repo}/contents/${encodedPath}${refQuery}`,
              ],
              { maxBuffer: 15 * 1024 * 1024 }
            );
            return sendJson(res, 200, {
              filePath: cleanPath,
              content: stdout,
              lineCount: stdout.split('\n').length,
              commitRef: sha || 'HEAD',
            });
          } catch {
            throw localErr;
          }
        }
      }

      if (req.method === 'GET' && pathname === '/api/grep') {
        const repo = urlObj.searchParams.get('repo');
        const number = urlObj.searchParams.get('number');
        const sha = urlObj.searchParams.get('sha') || '';
        const query = urlObj.searchParams.get('q') || '';
        const subPath = urlObj.searchParams.get('path') || '';

        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }

        const repoPath = getLocalRepoPath(projectsDir, repo);
        const commitRef = await ensurePrCommitFetched(repoPath, number, sha);
        const results = await grepAtCommit(repoPath, commitRef, query, subPath);
        return sendJson(res, 200, { ...results, commitRef });
      }

      if (req.method === 'GET' && pathname === '/api/worktree/status') {
        const repo = urlObj.searchParams.get('repo');
        const number = urlObj.searchParams.get('number');
        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }
        const status = await getWorktreeStatus(projectsDir, repo, number);
        return sendJson(res, 200, status);
      }

      if (req.method === 'POST' && pathname === '/api/worktree/mount') {
        const body = await readRequestBody(req);
        const { repo, number, headSha } = body;
        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }
        let changedFiles = [];
        try {
          changedFiles = await fetchPrDiffFiles(repo, number, headSha || 'latest');
        } catch {
          // ignore offline
        }
        const status = await mountWorktree({ projectsDir, repo, number, headSha, changedFiles });
        return sendJson(res, 200, status);
      }

      if (req.method === 'POST' && pathname === '/api/worktree/unmount') {
        const body = await readRequestBody(req);
        const { repo, number } = body;
        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }
        const status = await unmountWorktree({ projectsDir, repo, number });
        return sendJson(res, 200, status);
      }

      if (req.method === 'POST' && pathname === '/api/worktree/open-ide') {
        const body = await readRequestBody(req);
        const { repo, number, headSha, ide = 'phpstorm', filePath = '', line = null } = body;
        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }
        let changedFiles = [];
        try {
          changedFiles = await fetchPrDiffFiles(repo, number, headSha || 'latest');
        } catch {
          // ignore
        }
        const result = await openWorktreeInIde({
          projectsDir,
          repo,
          number,
          headSha,
          ide,
          filePath,
          line,
          changedFiles,
        });
        return sendJson(res, 200, result);
      }

      // =========================================================================
      // Agent Trigger, Q&A Chat & Mode 2 Debrief Endpoints
      // =========================================================================
      if (req.method === 'GET' && pathname === '/api/agent/jobs') {
        return sendJson(res, 200, { jobs: getAgentJobs() });
      }

      if (req.method === 'POST' && pathname === '/api/agent/review') {
        const body = await readRequestBody(req);
        const state = readJsonSafe(stateFile, { prs: {} });
        const key = body.key || (body.repo && body.number ? `${body.repo}#${body.number}` : '');
        const pr = state.prs?.[key] || (body.repo && body.number ? body : null);
        if (!pr || !pr.repo || !pr.number) {
          return sendJson(res, 400, { error: 'PR not found or missing repo/number' });
        }
        const job = triggerPrReview({ cfg, pr });
        return sendJson(res, 200, { ok: true, job });
      }

      if (req.method === 'POST' && pathname === '/api/agent/review-all-pending') {
        const state = buildStateResponse();
        const pending = state.prs.filter(
          (p) => !p.isArchived && (p.syncStatus === 'NEEDS_REVIEW' || p.syncStatus === 'NEEDS_UPDATE')
        );
        const startedJobs = pending.map((pr) => triggerPrReview({ cfg, pr }));
        return sendJson(res, 200, { ok: true, count: startedJobs.length, jobs: startedJobs });
      }

      if (req.method === 'GET' && pathname === '/api/agent/chat') {
        const repo = urlObj.searchParams.get('repo');
        const number = urlObj.searchParams.get('number');
        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }
        const messages = getPrChatHistory(reviewsDir, repo, number);
        const activeStream = getPrChatStatus(`${repo}#${number}`);
        return sendJson(res, 200, { messages, activeStream });
      }

      if (req.method === 'POST' && pathname === '/api/agent/chat') {
        const body = await readRequestBody(req);
        const {
          repo,
          number,
          message,
          findingContext = null,
          fileContext = null,
          action = 'ask',
        } = body;
        if (!repo || !number || !message) {
          return sendJson(res, 400, { error: 'Missing repo, number, or message' });
        }
        const state = readJsonSafe(stateFile, { prs: {} });
        const pr = state.prs?.[`${repo}#${number}`] || { repo, number };
        const result = await sendPrChatMessage({
          cfg,
          pr,
          message,
          findingContext,
          fileContext,
          action,
        });
        const messages = getPrChatHistory(reviewsDir, repo, number);
        return sendJson(res, 200, { ok: true, ...result, messages, activeStream: null });
      }

      if (req.method === 'POST' && pathname === '/api/agent/dismiss') {
        const body = await readRequestBody(req);
        const { repo, number, finding, reason = '' } = body;
        if (!repo || !number || !finding) {
          return sendJson(res, 400, { error: 'Missing repo, number, or finding' });
        }
        const state = readJsonSafe(stateFile, { prs: {} });
        const pr = state.prs?.[`${repo}#${number}`] || { repo, number };
        const result = dismissFindingAsFalsePositive({
          cfg,
          pr,
          finding,
          reason,
          uiStateFile,
        });
        return sendJson(res, 200, result);
      }

      // =========================================================================
      // Continuous Learning, Team Profiles & Rules Management Endpoints
      // =========================================================================
      if (req.method === 'GET' && pathname === '/api/teams/profiles') {
        const rulesState = listAllRules(cfg.teamProfile);
        return sendJson(res, 200, {
          profiles: rulesState.teamProfiles,
          activeTeamProfile: rulesState.activeTeamProfile,
        });
      }

      if (req.method === 'POST' && pathname === '/api/teams/profiles') {
        const reqBody = await readRequestBody(req);
        const profile = saveTeamProfile(reqBody);
        if (reqBody.activate !== false) {
          saveConfig({ teamProfile: profile.id });
        }
        const updatedCfg = loadConfig();
        const rulesState = listAllRules(updatedCfg.teamProfile);
        return sendJson(res, 200, { ok: true, profile, config: updatedCfg, ...rulesState });
      }

      if (req.method === 'GET' && pathname === '/api/rules') {
        const teamParam = urlObj.searchParams.get('teamProfile') || cfg.teamProfile || '';
        return sendJson(res, 200, listAllRules(teamParam));
      }

      if (req.method === 'POST' && pathname === '/api/rules') {
        const reqBody = await readRequestBody(req);
        const {
          target = 'dna',
          teamProfile = cfg.teamProfile || '',
          section = '',
          title = '',
          body: ruleBody = '',
          description = '',
          source = '',
          prKey = '',
        } = reqBody;
        const rulesState = addRule({
          target,
          teamProfile,
          section,
          title,
          body: ruleBody || description,
          source: source || prKey,
        });
        return sendJson(res, 200, { ok: true, ...rulesState });
      }

      if (req.method === 'PUT' && pathname === '/api/rules') {
        const body = await readRequestBody(req);
        const {
          id,
          target = 'dna',
          teamProfile = cfg.teamProfile || '',
          title = '',
          body: ruleBody = '',
        } = body;
        const rulesState = updateRule({ id, target, teamProfile, title, body: ruleBody });
        return sendJson(res, 200, { ok: true, ...rulesState });
      }

      if (req.method === 'DELETE' && pathname === '/api/rules') {
        const body = await readRequestBody(req);
        const { id, target = 'dna', teamProfile = cfg.teamProfile || '' } = body;
        const rulesState = deleteRule({ id, target, teamProfile });
        return sendJson(res, 200, { ok: true, ...rulesState });
      }

      if (req.method === 'POST' && pathname === '/api/rules/bootstrap') {
        const body = await readRequestBody(req);
        const days = Number(body.days || 365);
        const bootstrapResult = await bootstrapTeamCandidateRules({ cfg, days });
        const rulesState = listAllRules(cfg.teamProfile);
        return sendJson(res, 200, { ok: true, ...bootstrapResult, ...rulesState });
      }

      if (req.method === 'POST' && pathname === '/api/rules/candidates/decision') {
        const body = await readRequestBody(req);
        const {
          action = 'approve',
          id = '',
          target = 'dna',
          teamProfile = cfg.teamProfile || '',
          title = '',
          body: ruleBody = '',
          section = '',
        } = body;
        if (action === 'approve-all') {
          const rulesState = approveAllCandidateRules({ target, teamProfile });
          return sendJson(res, 200, { ok: true, ...rulesState });
        }
        const rulesState = decideCandidateRule({
          id,
          action,
          target,
          teamProfile,
          title,
          body: ruleBody,
          section,
        });
        return sendJson(res, 200, { ok: true, ...rulesState });
      }

      if (req.method === 'POST' && pathname === '/api/ui-state') {
        const body = await readRequestBody(req);
        const uiState = readJsonSafe(uiStateFile, { comments: {} });
        if (!uiState.comments) uiState.comments = {};

        const { cid, posted, dismissed, dismissReason, customComment, postedUrl } = body;
        if (!cid) return sendJson(res, 400, { error: 'Missing cid' });

        uiState.comments[cid] = {
          ...(uiState.comments[cid] || {}),
          ...(typeof posted === 'boolean' ? { posted, postedAt: posted ? new Date().toISOString() : null } : {}),
          ...(typeof dismissed === 'boolean' ? { dismissed } : {}),
          ...(typeof dismissReason === 'string' ? { dismissReason } : {}),
          ...(typeof customComment === 'string' ? { customComment } : {}),
          ...(postedUrl ? { postedUrl } : {}),
        };

        writeJsonSafe(uiStateFile, uiState);
        return sendJson(res, 200, { ok: true, entry: uiState.comments[cid] });
      }

      if (req.method === 'POST' && pathname === '/api/sync') {
        const defaultSyncScript = path.join(SKILL_ROOT_DIR, 'scripts', 'sync-queue.sh');
        let scanResult;
        if (
          cfg.syncScript &&
          path.resolve(cfg.syncScript) !== path.resolve(defaultSyncScript) &&
          fs.existsSync(cfg.syncScript)
        ) {
          const { stdout } = await execFileAsync(cfg.syncScript, ['scan'], {
            maxBuffer: 20 * 1024 * 1024,
            timeout: 120000,
          });
          scanResult = JSON.parse(stdout);
        } else {
          scanResult = await scanPrQueue(cfg);
        }
        return sendJson(res, 200, {
          ok: true,
          scanResult,
          state: buildStateResponse(),
        });
      }

      // Explicit User Action: Post a single comment (inline or general) to GitHub
      if (req.method === 'POST' && pathname === '/api/github/comment') {
        const body = await readRequestBody(req);
        const {
          repo,
          number,
          headSha,
          commentBody,
          filePath,
          line,
          startLine,
          endLine,
          mode,
          cid,
        } = body;

        if (!repo || !number || !commentBody) {
          return sendJson(res, 400, { error: 'Missing repo, number, or commentBody' });
        }

        let resultData = null;

        if (mode === 'inline' && filePath && headSha) {
          const files = await fetchPrDiffFiles(repo, number, headSha);
          const reqStart = Number(startLine ?? line) || null;
          const reqEnd = Number(endLine ?? line ?? reqStart) || 1;
          const resolved = resolveFindingAgainstDiff(
            { filePath, startLine: reqStart, endLine: reqEnd },
            files
          );

          if (resolved.inDiff && resolved.resolvedPath && resolved.resolvedLine) {
            const payloadObj = {
              body: commentBody,
              commit_id: headSha,
              path: resolved.resolvedPath,
              line: Number(resolved.resolvedLine),
              side: 'RIGHT',
              ...(resolved.resolvedStartLine && resolved.resolvedStartLine < resolved.resolvedLine
                ? {
                    start_line: Number(resolved.resolvedStartLine),
                    start_side: 'RIGHT',
                  }
                : {}),
            };
            const payload = JSON.stringify(payloadObj);

            const proc = execFile('gh', [
              'api',
              `repos/${cfg.githubOrg}/${repo}/pulls/${number}/comments`,
              '--method',
              'POST',
              '--input',
              '-',
            ]);
            proc.stdin.write(payload);
            proc.stdin.end();

            const stdout = await new Promise((resolve, reject) => {
              let out = '';
              let err = '';
              proc.stdout.on('data', (d) => (out += d));
              proc.stderr.on('data', (d) => (err += d));
              proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `gh exited ${code}`))));
            });
            resultData = JSON.parse(stdout);
          } else {
            return sendJson(res, 422, {
              error: `File "${filePath}" is not part of the PR diff hunks. Choose "General PR Comment" instead.`,
            });
          }
        } else {
          const payload = JSON.stringify({ body: commentBody });
          const proc = execFile('gh', [
            'api',
            `repos/${cfg.githubOrg}/${repo}/issues/${number}/comments`,
            '--method',
            'POST',
            '--input',
            '-',
          ]);
          proc.stdin.write(payload);
          proc.stdin.end();

          const stdout = await new Promise((resolve, reject) => {
            let out = '';
            let err = '';
            proc.stdout.on('data', (d) => (out += d));
            proc.stderr.on('data', (d) => (err += d));
            proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `gh exited ${code}`))));
          });
          resultData = JSON.parse(stdout);
        }

        if (cid) {
          const uiState = readJsonSafe(uiStateFile, { comments: {} });
          if (!uiState.comments) uiState.comments = {};
          uiState.comments[cid] = {
            ...(uiState.comments[cid] || {}),
            posted: true,
            postedAt: new Date().toISOString(),
            postedUrl: resultData?.html_url || null,
            customComment: commentBody,
          };
          writeJsonSafe(uiStateFile, uiState);
        }

        invalidatePrOverviewCache(repo, number);
        return sendJson(res, 200, { ok: true, githubResponse: resultData });
      }

      // Explicit User Action: Submit a GitHub Review (APPROVE, COMMENT, REQUEST_CHANGES, or PENDING draft)
      if (req.method === 'POST' && pathname === '/api/github/review') {
        const body = await readRequestBody(req);
        const { repo, number, headSha, event, summaryBody, inlineComments } = body;

        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }

        const reviewComments = [];
        const fallbackGeneralBodies = [];

        if (Array.isArray(inlineComments) && inlineComments.length > 0) {
          const files = await fetchPrDiffFiles(repo, number, headSha);
          for (const item of inlineComments) {
            const reqStart = Number(item.startLine ?? item.line) || null;
            const reqEnd = Number(item.endLine ?? item.line ?? reqStart) || 1;
            const resolved = resolveFindingAgainstDiff(
              { filePath: item.filePath, startLine: reqStart, endLine: reqEnd },
              files
            );
            if (resolved.inDiff && resolved.resolvedPath && resolved.resolvedLine) {
              reviewComments.push({
                path: resolved.resolvedPath,
                line: Number(resolved.resolvedLine),
                side: 'RIGHT',
                ...(resolved.resolvedStartLine && resolved.resolvedStartLine < resolved.resolvedLine
                  ? {
                      start_line: Number(resolved.resolvedStartLine),
                      start_side: 'RIGHT',
                    }
                  : {}),
                body: item.body,
              });
            } else {
              fallbackGeneralBodies.push(`**${item.filePath || 'Note'}**:\n${item.body}`);
            }
          }
        }

        const finalBody = [summaryBody || '', ...fallbackGeneralBodies].filter(Boolean).join('\n\n---\n\n');

        const reviewPayload = {
          ...(headSha ? { commit_id: headSha } : {}),
          ...(finalBody ? { body: finalBody } : {}),
          ...(event && event !== 'PENDING' ? { event } : {}),
          ...(reviewComments.length > 0 ? { comments: reviewComments } : {}),
        };

        const proc = execFile('gh', [
          'api',
          `repos/${cfg.githubOrg}/${repo}/pulls/${number}/reviews`,
          '--method',
          'POST',
          '--input',
          '-',
        ]);
        proc.stdin.write(JSON.stringify(reviewPayload));
        proc.stdin.end();

        const stdout = await new Promise((resolve, reject) => {
          let out = '';
          let err = '';
          proc.stdout.on('data', (d) => (out += d));
          proc.stderr.on('data', (d) => (err += d));
          proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `gh exited ${code}`))));
        });

        const resultData = JSON.parse(stdout);

        if (Array.isArray(inlineComments) && inlineComments.length > 0) {
          const uiState = readJsonSafe(uiStateFile, { comments: {} });
          if (!uiState.comments) uiState.comments = {};
          for (const item of inlineComments) {
            if (item.cid) {
              uiState.comments[item.cid] = {
                ...(uiState.comments[item.cid] || {}),
                posted: true,
                postedAt: new Date().toISOString(),
                postedUrl: resultData?.html_url || null,
                customComment: item.body,
              };
            }
          }
          writeJsonSafe(uiStateFile, uiState);
        }

        invalidatePrOverviewCache(repo, number);
        return sendJson(res, 200, { ok: true, githubResponse: resultData });
      }

      if (req.method === 'GET' && pathname === '/api/github/overview') {
        const repo = urlObj.searchParams.get('repo') || '';
        const number = urlObj.searchParams.get('number') || '';
        const forceRefresh = urlObj.searchParams.get('refresh') === '1';
        if (!repo || !number) {
          return sendJson(res, 400, { error: 'Missing repo or number' });
        }
        const overview = await fetchPrOverviewFromGitHub(cfg, repo, number, forceRefresh);
        return sendJson(res, 200, overview);
      }

      if (req.method === 'POST' && pathname === '/api/github/thread-reply') {
        const body = await readRequestBody(req);
        const { repo, number, threadId = '' } = body;
        const commentBody = String(body.commentBody ?? body.body ?? '').trim();
        if (!repo || !number || !threadId || !commentBody) {
          return sendJson(res, 400, { error: 'Missing repo, number, threadId, or commentBody' });
        }
        if (customOverviewHandlerForTests) {
          const mockRes = await customOverviewHandlerForTests({
            action: 'reply',
            cfg,
            repo,
            number,
            threadId,
            body: commentBody,
            commentBody,
          });
          invalidatePrOverviewCache(repo, number);
          return sendJson(res, 200, mockRes);
        }

        const mutation = `
          mutation($threadId: ID!, $body: String!) {
            addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
              comment {
                id
                databaseId
                body
                createdAt
                url
                author {
                  login
                  ... on User { name }
                }
              }
            }
          }
        `;
        const { stdout } = await execFileAsync('gh', [
          'api',
          'graphql',
          '-f',
          `query=${mutation}`,
          '-F',
          `threadId=${threadId}`,
          '-F',
          `body=${commentBody.trim()}`,
        ]);
        const parsed = JSON.parse(stdout);
        const rawComment = parsed?.data?.addPullRequestReviewThreadReply?.comment;
        invalidatePrOverviewCache(repo, number);
        return sendJson(res, 200, {
          ok: true,
          comment: rawComment
            ? {
                id: rawComment.id,
                databaseId: rawComment.databaseId,
                body: rawComment.body,
                createdAt: rawComment.createdAt,
                url: rawComment.url,
                authorLogin: rawComment.author?.login || '',
                authorName: formatPersonDisplayName({
                  login: rawComment.author?.login || '',
                  name: rawComment.author?.name || '',
                }),
              }
            : null,
        });
      }

      if (req.method === 'POST' && pathname === '/api/github/thread-resolve') {
        const body = await readRequestBody(req);
        const { repo, number, threadId = '', resolve = true } = body;
        if (!repo || !number || !threadId) {
          return sendJson(res, 400, { error: 'Missing repo, number, or threadId' });
        }
        if (customOverviewHandlerForTests) {
          const mockRes = await customOverviewHandlerForTests({
            action: 'resolve',
            cfg,
            repo,
            number,
            threadId,
            resolve: Boolean(resolve),
          });
          invalidatePrOverviewCache(repo, number);
          return sendJson(res, 200, mockRes);
        }

        const mutationField = resolve ? 'resolveReviewThread' : 'unresolveReviewThread';
        const mutation = `
          mutation($threadId: ID!) {
            ${mutationField}(input: { threadId: $threadId }) {
              thread {
                id
                isResolved
              }
            }
          }
        `;
        const { stdout } = await execFileAsync('gh', [
          'api',
          'graphql',
          '-f',
          `query=${mutation}`,
          '-F',
          `threadId=${threadId}`,
        ]);
        const parsed = JSON.parse(stdout);
        const updatedThread = parsed?.data?.[mutationField]?.thread;
        invalidatePrOverviewCache(repo, number);
        return sendJson(res, 200, {
          ok: true,
          threadId,
          isResolved: Boolean(updatedThread?.isResolved ?? resolve),
        });
      }

      // Static assets serving
      const staticFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (staticFile.includes('..')) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      const staticPath = path.join(__dirname, staticFile);
      if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        const ext = path.extname(staticPath);
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
        };
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(fs.readFileSync(staticPath));
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
  });
}

const isDirectEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
  } catch {
    return Boolean(process.argv[1] && path.resolve(process.argv[1]) === __filename);
  }
})();

if (isDirectEntry) {
  const bootCfg = ensureConfigBootstrapped();
  const PORT = Number(process.env.PORT || bootCfg.port || 4242);
  const server = createHubServer();
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('============================================================');
    console.log(`  PR Review Hub v${getAppVersion()} — Ready on ${url}`);
    console.log('============================================================');
    console.log(`  • GitHub User   : @${bootCfg.githubUser || 'auto'} (${bootCfg.githubOrg || 'ubitransports'})`);
    console.log(`  • Team Profile  : ${bootCfg.teamProfile || 'popcorn-back'}`);
    console.log(`  • AI Agent CLI  : ${bootCfg.agentCli || 'agy'}`);
    console.log(`  • Reviews Cache : ${bootCfg.reviewsDir}`);
    console.log('============================================================');
    console.log('');
    if (process.env.NO_OPEN !== '1' && process.env.NODE_ENV !== 'test') {
      const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFile(openCmd, [url], { timeout: 3000 }, () => {});
    }
  });
}
