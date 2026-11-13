import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';
import { sanitizeTeamProfileId } from './rules.mjs';
import { recordPrReview, generateIndexMarkdown } from './sync.mjs';

const execFileAsync = promisify(execFile);

let _gitSyncChain = Promise.resolve();

function withGitSyncLock(fn) {
  const next = _gitSyncChain.then(fn, fn);
  _gitSyncChain = next.catch(() => {});
  return next;
}

export function normalizeShortSha(headSha = '') {
  const cleaned = String(headSha || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '');
  return cleaned ? cleaned.slice(0, 12) : 'HEAD';
}

function safeRepoSegment(repo = '') {
  return path.basename(String(repo || '').trim()) || 'unknown-repo';
}

export function getSharedRootDir(cfg) {
  const dir = path.join(cfg.reviewsDir, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSharedPrDir({ cfg, repo, number, teamProfile = '' }) {
  const profileId = sanitizeTeamProfileId(teamProfile || cfg.teamProfile || 'popcorn-back') || 'popcorn-back';
  return path.join(
    getSharedRootDir(cfg),
    profileId,
    safeRepoSegment(repo),
    `pr-${Number(number)}`
  );
}

export function getSharedArtifactPaths({ cfg, repo, number, headSha, teamProfile = '' }) {
  const prDir = getSharedPrDir({ cfg, repo, number, teamProfile });
  const shortSha = normalizeShortSha(headSha);
  return {
    prDir,
    shortSha,
    mdPath: path.join(prDir, `${shortSha}.md`),
    metaPath: path.join(prDir, `${shortSha}.meta.json`),
    latestMetaPath: path.join(prDir, 'latest.json'),
  };
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // ignore malformed json
  }
  return fallback;
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Checks whether a shared review artifact already exists for `(repo, number, headSha, teamProfile)`.
 * Also recognizes pre-existing up-to-date reviews in `.state.json` to avoid duplicate runs on upgrade.
 */
export function hasReviewArtifact({ cfg, repo, number, headSha, teamProfile = '' }) {
  if (!headSha || headSha === 'HEAD') return false;
  const effectiveCfg = cfg || loadConfig();
  const profileId =
    sanitizeTeamProfileId(teamProfile || effectiveCfg.teamProfile || 'popcorn-back') ||
    'popcorn-back';
  const { mdPath } = getSharedArtifactPaths({
    cfg: effectiveCfg,
    repo,
    number,
    headSha,
    teamProfile: profileId,
  });

  if (fs.existsSync(mdPath)) {
    try {
      if (fs.statSync(mdPath).size > 20) return true;
    } catch {
      // ignore
    }
  }

  // Backwards-compatible check against .state.json + review-<repo>-<number>.md
  const stateFile = path.join(effectiveCfg.reviewsDir, '.state.json');
  const state = readJsonSafe(stateFile, { prs: {} });
  const key = `${repo}#${Number(number)}`;
  const entry = state?.prs?.[key];
  if (
    entry &&
    entry.lastReviewedSha === headSha &&
    (!entry.reviewedTeamProfile || entry.reviewedTeamProfile === profileId) &&
    entry.reviewScope !== 'personal'
  ) {
    const rFile = entry.reviewFile || `review-${repo}-${Number(number)}.md`;
    const candidatePath = path.join(effectiveCfg.reviewsDir, rFile);
    if (fs.existsSync(candidatePath)) return true;
  }

  return false;
}

/**
 * Saves a review report to the deterministic shared store (`scope === 'shared'`) or personal local store (`scope === 'personal'`),
 * while mirroring `review-<repo>-<number>.md` and `.state.json` so all existing UI views work seamlessly.
 */
export function saveReviewArtifact({
  cfg,
  repo,
  number,
  headSha,
  teamProfile = '',
  scope = 'shared',
  markdown,
  verdict,
  findingsSummary = '0 findings',
  jiraKey = '—',
  reviewedBy = '',
}) {
  const effectiveCfg = cfg || loadConfig();
  const prNum = Number(number);
  const profileId =
    sanitizeTeamProfileId(teamProfile || effectiveCfg.teamProfile || 'popcorn-back') ||
    'popcorn-back';
  const normalizedScope = scope === 'personal' ? 'personal' : 'shared';
  const cleanMd = `${String(markdown || '').trim()}\n`;
  const nowIso = new Date().toISOString();

  fs.mkdirSync(effectiveCfg.reviewsDir, { recursive: true });
  const reviewFileName = `review-${safeRepoSegment(repo)}-${prNum}.md`;
  const legacyReviewPath = path.join(effectiveCfg.reviewsDir, reviewFileName);
  fs.writeFileSync(legacyReviewPath, cleanMd, 'utf8');

  let artifactPath = legacyReviewPath;
  const metadata = {
    repo,
    number: prNum,
    headSha,
    shortSha: normalizeShortSha(headSha),
    teamProfile: profileId,
    scope: normalizedScope,
    verdict,
    findingsSummary,
    jiraKey: jiraKey || '—',
    reviewedBy: reviewedBy || effectiveCfg.githubUser || 'worker',
    reviewedAt: nowIso,
  };

  if (normalizedScope === 'shared') {
    const { prDir, mdPath, metaPath, latestMetaPath } = getSharedArtifactPaths({
      cfg: effectiveCfg,
      repo,
      number: prNum,
      headSha,
      teamProfile: profileId,
    });
    fs.mkdirSync(prDir, { recursive: true });
    fs.writeFileSync(mdPath, cleanMd, 'utf8');
    writeJsonAtomic(metaPath, metadata);
    writeJsonAtomic(latestMetaPath, metadata);
    artifactPath = mdPath;
  } else {
    const personalDir = path.join(
      effectiveCfg.reviewsDir,
      'personal',
      safeRepoSegment(repo),
      `pr-${prNum}`
    );
    fs.mkdirSync(personalDir, { recursive: true });
    const personalMdPath = path.join(personalDir, `${normalizeShortSha(headSha)}.md`);
    fs.writeFileSync(personalMdPath, cleanMd, 'utf8');
    writeJsonAtomic(path.join(personalDir, `${normalizeShortSha(headSha)}.meta.json`), metadata);
    artifactPath = personalMdPath;
  }

  const rec = recordPrReview({
    cfg: effectiveCfg,
    repo,
    number: prNum,
    headSha,
    reviewStatus: verdict,
    findingsSummary,
    jiraKey,
    reviewFile: reviewFileName,
  });

  // Enrich .state.json with reviewedTeamProfile & reviewScope
  const stateFile = path.join(effectiveCfg.reviewsDir, '.state.json');
  const state = readJsonSafe(stateFile, { prs: {} });
  if (state.prs && state.prs[rec.key]) {
    state.prs[rec.key] = {
      ...state.prs[rec.key],
      syncStatus: 'UP_TO_DATE',
      reviewedTeamProfile: profileId,
      reviewScope: normalizedScope,
      reviewedBy: metadata.reviewedBy,
    };
    writeJsonAtomic(stateFile, state);
  }

  return {
    key: rec.key,
    reviewFileName,
    legacyReviewPath,
    artifactPath,
    metadata,
  };
}

export function getReviewArtifact({
  cfg,
  repo,
  number,
  headSha = '',
  teamProfile = '',
  fallbackFile = '',
}) {
  const effectiveCfg = cfg || loadConfig();
  const prNum = Number(number);
  const profileId =
    sanitizeTeamProfileId(teamProfile || effectiveCfg.teamProfile || 'popcorn-back') ||
    'popcorn-back';

  if (repo && prNum) {
    if (headSha) {
      const { mdPath, metaPath } = getSharedArtifactPaths({
        cfg: effectiveCfg,
        repo,
        number: prNum,
        headSha,
        teamProfile: profileId,
      });
      if (fs.existsSync(mdPath)) {
        return {
          markdown: fs.readFileSync(mdPath, 'utf8'),
          metadata: readJsonSafe(metaPath, null),
          source: 'shared',
          filePath: mdPath,
        };
      }
    }

    const prDir = getSharedPrDir({
      cfg: effectiveCfg,
      repo,
      number: prNum,
      teamProfile: profileId,
    });
    const latestMeta = readJsonSafe(path.join(prDir, 'latest.json'), null);
    if (latestMeta?.shortSha) {
      const latestMdPath = path.join(prDir, `${latestMeta.shortSha}.md`);
      if (fs.existsSync(latestMdPath)) {
        return {
          markdown: fs.readFileSync(latestMdPath, 'utf8'),
          metadata: latestMeta,
          source: 'shared-latest',
          filePath: latestMdPath,
        };
      }
    }
  }

  const candidateName = path.basename(
    fallbackFile || (repo && prNum ? `review-${safeRepoSegment(repo)}-${prNum}.md` : '')
  );
  if (candidateName) {
    const directPath = path.join(effectiveCfg.reviewsDir, candidateName);
    const archivePath = path.join(effectiveCfg.reviewsDir, 'archive', candidateName);
    const resolved = fs.existsSync(directPath)
      ? directPath
      : fs.existsSync(archivePath)
      ? archivePath
      : null;
    if (resolved) {
      return {
        markdown: fs.readFileSync(resolved, 'utf8'),
        metadata: null,
        source: 'local',
        filePath: resolved,
      };
    }
  }

  return null;
}

/**
 * Hydrates `.state.json` and `review-<repo>-<number>.md` from `<reviewsDir>/shared/<activeTeamProfile>/...`
 * so `reader` nodes immediately see reviews produced by the dedicated `worker` node.
 */
export function hydrateLocalStateFromSharedStore(customCfg = null) {
  const cfg = customCfg || loadConfig();
  const profileId = sanitizeTeamProfileId(cfg.teamProfile || 'popcorn-back') || 'popcorn-back';
  const profileSharedDir = path.join(getSharedRootDir(cfg), profileId);
  if (!fs.existsSync(profileSharedDir)) {
    return { hydratedCount: 0 };
  }

  const stateFile = path.join(cfg.reviewsDir, '.state.json');
  const state = readJsonSafe(stateFile, { prs: {} });
  if (!state.prs || typeof state.prs !== 'object') state.prs = {};

  let hydratedCount = 0;
  const repoEntries = fs.readdirSync(profileSharedDir, { withFileTypes: true });
  for (const repoEntry of repoEntries) {
    if (!repoEntry.isDirectory()) continue;
    const repoName = repoEntry.name;
    const repoDir = path.join(profileSharedDir, repoName);
    const prEntries = fs.readdirSync(repoDir, { withFileTypes: true });

    for (const prEntry of prEntries) {
      if (!prEntry.isDirectory() || !prEntry.name.startsWith('pr-')) continue;
      const prNum = Number(prEntry.name.slice(3));
      if (!prNum) continue;

      const key = `${repoName}#${prNum}`;
      const existing = state.prs[key] || null;
      const prDir = path.join(repoDir, prEntry.name);

      // Prefer exact headRefOid match if known in local state, else latest.json
      let chosenMeta = null;
      let chosenMdPath = null;
      if (existing?.headRefOid) {
        const shortHead = normalizeShortSha(existing.headRefOid);
        const exactMd = path.join(prDir, `${shortHead}.md`);
        const exactMeta = path.join(prDir, `${shortHead}.meta.json`);
        if (fs.existsSync(exactMd)) {
          chosenMdPath = exactMd;
          chosenMeta = readJsonSafe(exactMeta, {
            repo: repoName,
            number: prNum,
            headSha: existing.headRefOid,
            shortSha: shortHead,
            teamProfile: profileId,
          });
        }
      }

      if (!chosenMdPath) {
        const latestMeta = readJsonSafe(path.join(prDir, 'latest.json'), null);
        if (latestMeta?.shortSha) {
          const candidateMd = path.join(prDir, `${latestMeta.shortSha}.md`);
          if (fs.existsSync(candidateMd)) {
            chosenMdPath = candidateMd;
            chosenMeta = latestMeta;
          }
        }
      }

      if (!chosenMdPath || !chosenMeta) continue;

      const reviewFileName = existing?.reviewFile || `review-${repoName}-${prNum}.md`;
      const legacyReviewPath = path.join(cfg.reviewsDir, reviewFileName);
      const sharedMdContent = fs.readFileSync(chosenMdPath, 'utf8');

      const needsCopy =
        !fs.existsSync(legacyReviewPath) ||
        existing?.lastReviewedSha !== chosenMeta.headSha ||
        existing?.reviewedTeamProfile !== profileId;

      if (needsCopy) {
        fs.mkdirSync(cfg.reviewsDir, { recursive: true });
        fs.writeFileSync(legacyReviewPath, sharedMdContent, 'utf8');
        const currentHead = existing?.headRefOid || chosenMeta.headSha;
        const isUpToDate = currentHead === chosenMeta.headSha;
        state.prs[key] = {
          ...(existing || {}),
          key,
          repo: repoName,
          number: prNum,
          state: existing?.state || 'OPEN',
          headRefOid: currentHead,
          lastReviewedSha: chosenMeta.headSha,
          syncStatus: isUpToDate ? 'UP_TO_DATE' : existing?.syncStatus || 'NEEDS_UPDATE',
          reviewStatus: isUpToDate
            ? chosenMeta.verdict || '✅ Reviewed'
            : '🔄 Update Needed (new commits)',
          findingsSummary: chosenMeta.findingsSummary || existing?.findingsSummary || '0 findings',
          jiraKey:
            chosenMeta.jiraKey && chosenMeta.jiraKey !== '—'
              ? chosenMeta.jiraKey
              : existing?.jiraKey || '—',
          reviewFile: reviewFileName,
          lastReviewedAt: chosenMeta.reviewedAt || existing?.lastReviewedAt || new Date().toISOString(),
          reviewedTeamProfile: profileId,
          reviewScope: 'shared',
          reviewedBy: chosenMeta.reviewedBy || 'worker',
        };
        hydratedCount++;
      }
    }
  }

  if (hydratedCount > 0) {
    writeJsonAtomic(stateFile, state);
    try {
      generateIndexMarkdown(cfg);
    } catch {
      // ignore index generation error
    }
  }

  return { hydratedCount };
}

// =============================================================================
// Collaborative Finding State (`posted` / `dismissed` shared; `customComment` local)
// =============================================================================

export function getSharedFindingsStatePath(cfg) {
  return path.join(getSharedRootDir(cfg || loadConfig()), 'findings-state.json');
}

export function readSharedFindingsState(customCfg = null) {
  const filePath = getSharedFindingsStatePath(customCfg || loadConfig());
  const parsed = readJsonSafe(filePath, { updatedAt: null, findings: {} });
  if (!parsed.findings || typeof parsed.findings !== 'object') {
    parsed.findings = {};
  }
  return parsed;
}

export function recordSharedFindingAction({
  cfg: customCfg = null,
  cid,
  action,
  actor = '',
  url = '',
  reason = '',
}) {
  if (!cid || !action) return null;
  const cfg = customCfg || loadConfig();
  const filePath = getSharedFindingsStatePath(cfg);
  const state = readSharedFindingsState(cfg);
  const prev = state.findings[cid] || {};
  const nowIso = new Date().toISOString();
  const cleanActor = String(actor || cfg.githubUser || 'reviewer').trim();

  let updatedEntry = { ...prev, updatedAt: nowIso };
  if (action === 'posted') {
    updatedEntry = {
      ...updatedEntry,
      posted: true,
      postedBy: cleanActor,
      postedAt: nowIso,
      postedUrl: url || prev.postedUrl || null,
    };
  } else if (action === 'unposted') {
    updatedEntry = {
      ...updatedEntry,
      posted: false,
    };
  } else if (action === 'dismissed') {
    updatedEntry = {
      ...updatedEntry,
      dismissed: true,
      dismissedBy: cleanActor,
      dismissedAt: nowIso,
      dismissReason: reason || prev.dismissReason || null,
    };
  } else if (action === 'undismissed') {
    updatedEntry = {
      ...updatedEntry,
      dismissed: false,
    };
  }

  state.updatedAt = nowIso;
  state.findings[cid] = updatedEntry;
  writeJsonAtomic(filePath, state);
  return updatedEntry;
}

export function mergeFindingsStateObjects(baseState = {}, incomingState = {}) {
  const baseFindings = baseState?.findings || {};
  const incFindings = incomingState?.findings || {};
  const allCids = new Set([...Object.keys(baseFindings), ...Object.keys(incFindings)]);
  const merged = {};

  for (const cid of allCids) {
    const a = baseFindings[cid];
    const b = incFindings[cid];
    if (a && !b) {
      merged[cid] = a;
    } else if (!a && b) {
      merged[cid] = b;
    } else {
      const aTime = String(a.updatedAt || a.postedAt || a.dismissedAt || '');
      const bTime = String(b.updatedAt || b.postedAt || b.dismissedAt || '');
      merged[cid] = bTime >= aTime ? { ...a, ...b } : { ...b, ...a };
    }
  }

  return {
    updatedAt: new Date().toISOString(),
    findings: merged,
  };
}

/**
 * Combines shared collaborative flags (`posted`, `dismissed`, `postedBy`, `dismissedBy`)
 * with strictly local draft edits (`customComment`).
 */
export function mergeCollaborativeAndLocalFindingState({
  sharedEntry = null,
  localEntry = null,
  defaultComment = '',
}) {
  const s = sharedEntry || {};
  const l = localEntry || {};

  const posted = s.posted !== undefined ? Boolean(s.posted) : Boolean(l.posted);
  const dismissed = s.dismissed !== undefined ? Boolean(s.dismissed) : Boolean(l.dismissed);

  return {
    posted,
    postedBy: s.postedBy || l.postedBy || null,
    postedAt: s.postedAt || l.postedAt || null,
    postedUrl: s.postedUrl || l.postedUrl || null,
    dismissed,
    dismissedBy: s.dismissedBy || l.dismissedBy || null,
    dismissedAt: s.dismissedAt || l.dismissedAt || null,
    dismissReason: s.dismissReason || l.dismissReason || null,
    customComment: l.customComment ?? defaultComment,
  };
}

// =============================================================================
// GitHub Caller Identity Isolation (Step 2 Multi-User OAuth Readiness)
// =============================================================================

export function resolveGithubActor(req, cfg) {
  const effectiveCfg = cfg || loadConfig();
  const authHeader = String(req?.headers?.authorization || '').trim();
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const headerToken = String(req?.headers?.['x-github-token'] || bearerToken || '').trim();
  const headerUser = String(req?.headers?.['x-github-user'] || '').trim();

  return {
    login: headerUser || effectiveCfg.githubUser || 'reviewer',
    token: headerToken,
  };
}

export function buildGithubExecEnv(actor) {
  if (actor?.token) {
    return {
      ...process.env,
      GH_TOKEN: actor.token,
      GITHUB_TOKEN: actor.token,
    };
  }
  return process.env;
}

// =============================================================================
// Optional GitSharedStore Sync Bridge (`sharedStoreRepo` / `sharedStoreBranch`)
// =============================================================================

export function resolveSharedStoreRemoteUrl(repoSpec = '') {
  const trimmed = String(repoSpec || '').trim();
  if (!trimmed) return '';
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('file://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('git@') ||
    trimmed.startsWith('ssh://')
  ) {
    return trimmed;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed.replace(/\.git$/, '')}.git`;
  }
  return trimmed;
}

function copyDirRecursiveMerge(srcDir, destDir, { mergeFindingsState = true } = {}) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveMerge(srcPath, destPath, { mergeFindingsState });
    } else if (
      mergeFindingsState &&
      entry.name === 'findings-state.json' &&
      fs.existsSync(destPath)
    ) {
      const destData = readJsonSafe(destPath, { findings: {} });
      const srcData = readJsonSafe(srcPath, { findings: {} });
      writeJsonAtomic(destPath, mergeFindingsStateObjects(destData, srcData));
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function ensureGitSyncWorkdir(cfg) {
  const remoteUrl = resolveSharedStoreRemoteUrl(cfg.sharedStoreRepo);
  if (!remoteUrl) return null;

  const branch = String(cfg.sharedStoreBranch || 'reviews-store').trim() || 'reviews-store';
  const syncDir = path.join(cfg.reviewsDir, '.shared-git-sync');
  fs.mkdirSync(syncDir, { recursive: true });

  if (!fs.existsSync(path.join(syncDir, '.git'))) {
    await execFileAsync('git', ['init'], { cwd: syncDir, timeout: 10000 });
    await execFileAsync('git', ['config', 'user.name', cfg.githubUser || 'PR Review Hub'], {
      cwd: syncDir,
      timeout: 5000,
    });
    await execFileAsync(
      'git',
      ['config', 'user.email', `${cfg.githubUser || 'review-hub'}@users.noreply.github.com`],
      { cwd: syncDir, timeout: 5000 }
    );
  }

  const remotesRes = await execFileAsync('git', ['remote'], {
    cwd: syncDir,
    timeout: 5000,
  }).catch(() => ({ stdout: '' }));
  const hasOrigin = String(remotesRes.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .includes('origin');

  if (hasOrigin) {
    await execFileAsync('git', ['remote', 'set-url', 'origin', remoteUrl], {
      cwd: syncDir,
      timeout: 5000,
    });
  } else {
    await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], {
      cwd: syncDir,
      timeout: 5000,
    });
  }

  return { syncDir, remoteUrl, branch };
}

export function pullSharedStore(customCfg = null) {
  const cfg = customCfg || loadConfig();
  if (!cfg.sharedStoreRepo) {
    return Promise.resolve({ skipped: true, synced: false, hydratedCount: 0 });
  }

  return withGitSyncLock(async () => {
    try {
      const ctx = await ensureGitSyncWorkdir(cfg);
      if (!ctx) return { skipped: true, synced: false, hydratedCount: 0 };
      const { syncDir, branch } = ctx;

      const lsRemote = await execFileAsync(
        'git',
        ['ls-remote', '--heads', 'origin', branch],
        { cwd: syncDir, timeout: 20000 }
      ).catch(() => ({ stdout: '' }));

      if (String(lsRemote.stdout || '').trim()) {
        await execFileAsync('git', ['fetch', 'origin', branch, '--depth', '1'], {
          cwd: syncDir,
          timeout: 25000,
        });
        await execFileAsync('git', ['checkout', '-B', branch, 'FETCH_HEAD'], {
          cwd: syncDir,
          timeout: 10000,
        });

        const incomingSharedDir = path.join(syncDir, 'shared');
        if (fs.existsSync(incomingSharedDir)) {
          copyDirRecursiveMerge(incomingSharedDir, getSharedRootDir(cfg), {
            mergeFindingsState: true,
          });
        }
      }

      const { hydratedCount } = hydrateLocalStateFromSharedStore(cfg);
      return { skipped: false, synced: true, hydratedCount };
    } catch (err) {
      return {
        skipped: false,
        synced: false,
        hydratedCount: 0,
        error: err.message || String(err),
      };
    }
  });
}

export function pushSharedStore(customCfg = null, commitMessage = 'chore(ReviewHub): N/A - Sync shared review artifacts') {
  const cfg = customCfg || loadConfig();
  if (!cfg.sharedStoreRepo) {
    return Promise.resolve({ skipped: true, pushed: false });
  }

  return withGitSyncLock(async () => {
    try {
      const ctx = await ensureGitSyncWorkdir(cfg);
      if (!ctx) return { skipped: true, pushed: false };
      const { syncDir, branch } = ctx;

      const lsRemote = await execFileAsync(
        'git',
        ['ls-remote', '--heads', 'origin', branch],
        { cwd: syncDir, timeout: 20000 }
      ).catch(() => ({ stdout: '' }));

      if (String(lsRemote.stdout || '').trim()) {
        await execFileAsync('git', ['fetch', 'origin', branch, '--depth', '1'], {
          cwd: syncDir,
          timeout: 25000,
        });
        await execFileAsync('git', ['checkout', '-B', branch, 'FETCH_HEAD'], {
          cwd: syncDir,
          timeout: 10000,
        });
      } else {
        await execFileAsync('git', ['checkout', '-B', branch], {
          cwd: syncDir,
          timeout: 10000,
        });
      }

      const localSharedDir = getSharedRootDir(cfg);
      const repoSharedDir = path.join(syncDir, 'shared');
      copyDirRecursiveMerge(localSharedDir, repoSharedDir, { mergeFindingsState: true });
      // Also mirror merged findings-state back into local shared dir
      if (fs.existsSync(path.join(repoSharedDir, 'findings-state.json'))) {
        copyDirRecursiveMerge(repoSharedDir, localSharedDir, { mergeFindingsState: true });
      }

      await execFileAsync('git', ['add', 'shared'], { cwd: syncDir, timeout: 10000 });
      const statusRes = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: syncDir,
        timeout: 5000,
      });

      if (!String(statusRes.stdout || '').trim()) {
        return { skipped: false, pushed: false, upToDate: true };
      }

      const singleLineMsg = String(commitMessage || 'chore(ReviewHub): N/A - Sync shared review artifacts')
        .split(/\r?\n/)[0]
        .trim();
      await execFileAsync('git', ['commit', '-m', singleLineMsg], {
        cwd: syncDir,
        timeout: 10000,
      });
      await execFileAsync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {
        cwd: syncDir,
        timeout: 30000,
      });

      return { skipped: false, pushed: true };
    } catch (err) {
      return {
        skipped: false,
        pushed: false,
        error: err.message || String(err),
      };
    }
  });
}
