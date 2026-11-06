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
} from './lib/config.mjs';
import {
  computeAuthorInitials,
  resolveAuthorDisplayName,
  formatPersonDisplayName,
  extractJiraKey,
  detectStackedPr,
  normalizeCiState,
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
  addRule,
  updateRule,
  deleteRule,
  decideCandidateRule,
  approveAllCandidateRules,
} from './lib/rules.mjs';
import { bootstrapTeamCandidateRules } from './lib/onboarding.mjs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export function buildStateResponse() {
  const { cfg, reviewsDir, archiveDir, stateFile, uiStateFile } = getPaths();
  const projectsDir = getProjectsDir(cfg);
  const state = readJsonSafe(stateFile, { prs: {} });
  const uiState = readJsonSafe(uiStateFile, { comments: {} });
  const prsMap = state.prs || {};
  const jobs = getAgentJobs();

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

    const authorInitials = computeAuthorInitials({ login: pr.author, name: pr.authorName });
    const authorDisplayName = resolveAuthorDisplayName({ login: pr.author, name: pr.authorName });
    const resolvedJira = extractJiraKey(pr, cfg.jiraPrefixes);
    const stackInfo = detectStackedPr(pr);
    const ciStatus = normalizeCiState(pr.ciState);
    const wtPath = getWorktreePath(projectsDir, pr.repo, pr.number);
    const worktreeMounted = fs.existsSync(wtPath);
    const runningJob = jobs.find((j) => j.prKey === key && j.status === 'running') || null;

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

    return {
      ...pr,
      key,
      jiraKey: resolvedJira || pr.jiraKey || '—',
      authorInitials,
      authorDisplayName,
      approvedBy,
      changesRequestedBy,
      commentedBy,
      pendingReviewers,
      isStacked: stackInfo.isStacked,
      ciStatus,
      worktreeMounted,
      worktreePath: worktreeMounted ? wtPath : null,
      runningJob,
      isArchived: Boolean(pr.state !== 'OPEN' || isArchivedFile),
      hasReviewFile: Boolean(hasActiveFile || isArchivedFile),
      findingsCount,
      postedCount,
      dismissedCount,
    };
  });

  prs.sort((a, b) => {
    if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  return { prs, uiState, config: cfg, jobs };
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
  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const pathname = urlObj.pathname;
      const { cfg, reviewsDir, archiveDir, stateFile, uiStateFile } = getPaths();
      const projectsDir = getProjectsDir(cfg);

      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, buildStateResponse());
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, { config: cfg });
      }

      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readRequestBody(req);
        const updated = saveConfig(body);
        return sendJson(res, 200, { ok: true, config: updated });
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
        const file = urlObj.searchParams.get('file');
        const prKey = urlObj.searchParams.get('key') || '';
        if (!file || file.includes('..') || file.includes('/')) {
          return sendJson(res, 400, { error: 'Invalid review file name' });
        }
        let fullPath = path.join(reviewsDir, file);
        let archived = false;
        if (!fs.existsSync(fullPath)) {
          fullPath = path.join(archiveDir, file);
          archived = true;
        }
        if (!fs.existsSync(fullPath)) {
          return sendJson(res, 404, { error: 'Review file not found' });
        }

        const markdown = fs.readFileSync(fullPath, 'utf8');
        const uiState = readJsonSafe(uiStateFile, { comments: {} });
        const rawFindings = parseFindingsFromMarkdown(markdown);

        const findings = rawFindings.map((f) => {
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
          findings,
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
        let resolvedFindings = [];

        if (reviewFile && !reviewFile.includes('..')) {
          let fullPath = path.join(reviewsDir, reviewFile);
          if (!fs.existsSync(fullPath)) fullPath = path.join(archiveDir, reviewFile);
          if (fs.existsSync(fullPath)) {
            const md = fs.readFileSync(fullPath, 'utf8');
            const uiState = readJsonSafe(uiStateFile, { comments: {} });
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

        return sendJson(res, 200, { files, resolvedFindings });
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
      // Continuous Learning & Rules Management Endpoints (DNA & False Positives)
      // =========================================================================
      if (req.method === 'GET' && pathname === '/api/rules') {
        return sendJson(res, 200, listAllRules());
      }

      if (req.method === 'POST' && pathname === '/api/rules') {
        const reqBody = await readRequestBody(req);
        const {
          target = 'dna',
          section = '',
          title = '',
          body: ruleBody = '',
          description = '',
          source = '',
          prKey = '',
        } = reqBody;
        const rulesState = addRule({
          target,
          section,
          title,
          body: ruleBody || description,
          source: source || prKey,
        });
        return sendJson(res, 200, { ok: true, ...rulesState });
      }

      if (req.method === 'PUT' && pathname === '/api/rules') {
        const body = await readRequestBody(req);
        const { id, target = 'dna', title = '', body: ruleBody = '' } = body;
        const rulesState = updateRule({ id, target, title, body: ruleBody });
        return sendJson(res, 200, { ok: true, ...rulesState });
      }

      if (req.method === 'DELETE' && pathname === '/api/rules') {
        const body = await readRequestBody(req);
        const { id, target = 'dna' } = body;
        const rulesState = deleteRule({ id, target });
        return sendJson(res, 200, { ok: true, ...rulesState });
      }

      if (req.method === 'POST' && pathname === '/api/rules/bootstrap') {
        const body = await readRequestBody(req);
        const days = Number(body.days || 365);
        const bootstrapResult = await bootstrapTeamCandidateRules({ cfg, days });
        const rulesState = listAllRules();
        return sendJson(res, 200, { ok: true, ...bootstrapResult, ...rulesState });
      }

      if (req.method === 'POST' && pathname === '/api/rules/candidates/decision') {
        const body = await readRequestBody(req);
        const { action = 'approve', id = '', target = 'dna', title = '', body: ruleBody = '', section = '' } = body;
        if (action === 'approve-all') {
          const rulesState = approveAllCandidateRules({ target });
          return sendJson(res, 200, { ok: true, ...rulesState });
        }
        const rulesState = decideCandidateRule({ id, action, target, title, body: ruleBody, section });
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
        const { stdout } = await execFileAsync(cfg.syncScript, ['scan'], {
          maxBuffer: 20 * 1024 * 1024,
          timeout: 120000,
        });
        const scanResult = JSON.parse(stdout);
        return sendJson(res, 200, {
          ok: true,
          scanResult,
          state: buildStateResponse(),
        });
      }

      // Explicit User Action: Post a single comment (inline or general) to GitHub
      if (req.method === 'POST' && pathname === '/api/github/comment') {
        const body = await readRequestBody(req);
        const { repo, number, headSha, commentBody, filePath, line, mode, cid } = body;

        if (!repo || !number || !commentBody) {
          return sendJson(res, 400, { error: 'Missing repo, number, or commentBody' });
        }

        let resultData = null;

        if (mode === 'inline' && filePath && headSha) {
          const files = await fetchPrDiffFiles(repo, number, headSha);
          const resolved = resolveFindingAgainstDiff({ filePath, endLine: Number(line) || 1 }, files);

          if (resolved.inDiff && resolved.resolvedPath && resolved.resolvedLine) {
            const payload = JSON.stringify({
              body: commentBody,
              commit_id: headSha,
              path: resolved.resolvedPath,
              line: Number(resolved.resolvedLine),
              side: 'RIGHT',
            });

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
            const resolved = resolveFindingAgainstDiff(
              { filePath: item.filePath, endLine: Number(item.line) || 1 },
              files
            );
            if (resolved.inDiff && resolved.resolvedPath && resolved.resolvedLine) {
              reviewComments.push({
                path: resolved.resolvedPath,
                line: Number(resolved.resolvedLine),
                side: 'RIGHT',
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

        return sendJson(res, 200, { ok: true, githubResponse: resultData });
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

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const PORT = Number(process.env.PORT || 4242);
  const server = createHubServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`PR Review Hub listening on http://localhost:${PORT}`);
  });
}
