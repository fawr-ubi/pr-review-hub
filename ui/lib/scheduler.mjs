import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, normalizeAutoReviewExcludeField } from './config.mjs';
import { scanPrQueue } from './sync.mjs';
import { createQueuedReviewJob, runPrReviewJob, isAgentAuthError } from './agent.mjs';
import {
  hasReviewArtifact,
  pullSharedStore,
  hydrateLocalStateFromSharedStore,
} from './store.mjs';
import { ensureWanreviewRepoSynced } from './wanreview.mjs';

const LOCKFILE_ONLY_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|uv\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock)$/i;

/**
 * Evaluates whether a PR should be skipped by automatic background reviews
 * (bots, release/version-bump/back-merge PRs, excluded labels, lockfile-only, oversized).
 * Manual triggers (`force: true`) bypass this check.
 */
export function shouldSkipAutoReview(pr, cfg = {}) {
  if (!pr || typeof pr !== 'object') {
    return { skip: true, reason: 'invalid_pr' };
  }
  if (pr.isDraft || pr.syncStatus === 'DRAFT') {
    return { skip: true, reason: 'draft' };
  }
  const rules = normalizeAutoReviewExcludeField(cfg.autoReviewExclude);
  if (!rules.enabled) {
    return { skip: false, reason: null };
  }

  const author = String(pr.author || '').trim().toLowerCase();
  if (
    author &&
    (author.endsWith('[bot]') ||
      rules.botAuthors.some((b) => b.toLowerCase() === author || author.startsWith(b.toLowerCase())))
  ) {
    return { skip: true, reason: `bot_author:${author}` };
  }

  const labels = Array.isArray(pr.labels)
    ? pr.labels.map((l) => String(typeof l === 'string' ? l : l?.name || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const excludedLabelSet = new Set(rules.excludeLabels.map((l) => l.toLowerCase()));
  const matchedLabel = labels.find((l) => excludedLabelSet.has(l));
  if (matchedLabel) {
    return { skip: true, reason: `label:${matchedLabel}` };
  }

  const headRef = String(pr.headRefName || '').trim().toLowerCase();
  const matchedPrefix = rules.excludeBranchPrefixes.find((p) =>
    headRef.startsWith(p.toLowerCase())
  );
  if (matchedPrefix) {
    return { skip: true, reason: `branch:${matchedPrefix}` };
  }

  const title = String(pr.title || '').trim();
  for (const rawPattern of rules.excludeTitlePatterns) {
    try {
      if (new RegExp(rawPattern, 'i').test(title)) {
        return { skip: true, reason: `title:${rawPattern}` };
      }
    } catch {
      // ignore invalid user regex
    }
  }

  const changedFilesCount = Number(pr.changedFiles || 0);
  if (rules.maxChangedFiles > 0 && changedFilesCount > rules.maxChangedFiles) {
    return { skip: true, reason: `oversized:${changedFilesCount}_files` };
  }

  const paths = Array.isArray(pr.changedFilePaths) ? pr.changedFilePaths.filter(Boolean) : [];
  if (
    rules.skipLockfilesOnly &&
    paths.length > 0 &&
    paths.length === (changedFilesCount || paths.length) &&
    paths.every((p) => LOCKFILE_ONLY_RE.test(String(p)))
  ) {
    return { skip: true, reason: 'lockfiles_only' };
  }

  return { skip: false, reason: null };
}

function readLocalOpenPrs(reviewsDir) {
  try {
    const stateFile = path.join(reviewsDir, '.state.json');
    if (!fs.existsSync(stateFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return Object.values(parsed?.prs || {}).filter((pr) => pr && pr.state === 'OPEN');
  } catch {
    return [];
  }
}

export class AutoReviewScheduler {
  constructor({
    loadConfigFn = loadConfig,
    scanPrQueueFn = scanPrQueue,
    runReviewFn = runPrReviewJob,
    pullStoreFn = pullSharedStore,
    hydrateFn = hydrateLocalStateFromSharedStore,
    bootDelayMs = 1500,
  } = {}) {
    this.loadConfigFn = loadConfigFn;
    this.scanPrQueueFn = scanPrQueueFn;
    this.runReviewFn = runReviewFn;
    this.pullStoreFn = pullStoreFn;
    this.hydrateFn = hydrateFn;
    this.bootDelayMs = bootDelayMs;

    this.queue = [];
    this.activeItem = null;
    this.authRequired = false;
    this.failedCooldowns = new Map();
    this.failureCooldownMs = 30 * 60 * 1000;
    this._draining = false;
    this._running = false;
    this._stopped = false;
    this._timer = null;
    this._bootTimer = null;
    this._idleResolvers = [];

    this.syncInFlight = false;
    this.lastSyncAt = null;
    this.nextSyncAt = null;
    this.lastSyncError = null;
    this.completedCount = 0;
    this.failedCount = 0;
  }

  start({ runImmediately = true } = {}) {
    if (this._running) return this;
    this._running = true;
    this._stopped = false;

    if (runImmediately) {
      this._bootTimer = setTimeout(() => {
        this._bootTimer = null;
        if (!this._running) return;
        this.runSyncCycle({ manual: false }).catch(() => {});
      }, this.bootDelayMs);
      this._bootTimer.unref?.();
    } else {
      this._scheduleNextTick();
    }
    return this;
  }

  stop() {
    this._running = false;
    this._stopped = true;
    if (this._bootTimer) {
      clearTimeout(this._bootTimer);
      this._bootTimer = null;
    }
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.nextSyncAt = null;
  }

  reconfigure() {
    if (!this._running) return this.getStatus();
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._scheduleNextTick();
    return this.getStatus();
  }

  _scheduleNextTick() {
    if (!this._running) return;
    if (this._timer) clearTimeout(this._timer);
    const cfg = this.loadConfigFn();
    const intervalMs = Math.max(30, Number(cfg.autoSyncIntervalSec) || 300) * 1000;
    this.nextSyncAt = new Date(Date.now() + intervalMs).toISOString();
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._running) return;
      this.runSyncCycle({ manual: false }).catch(() => {});
    }, intervalMs);
    this._timer.unref?.();
  }

  _refreshQueuePositionLabels() {
    this.queue.forEach((item, index) => {
      if (item.job && item.job.status === 'queued') {
        item.job.phase = `Queued (#${index + 1} in worker queue)…`;
      }
    });
  }

  enqueuePrReview(
    pr,
    { priority = false, scope = 'shared', force = false, domain = '' } = {}
  ) {
    if (!pr || !pr.repo || !pr.number) {
      throw new Error('Valid PR { repo, number } is required');
    }
    const cfg = this.loadConfigFn();
    const normalizedScope = scope === 'personal' ? 'personal' : 'shared';
    const targetDomain = String(domain || '').trim().toLowerCase();
    const prKey = `${pr.repo}#${Number(pr.number)}`;
    const headSha = pr.headRefOid || pr.headSha || '';
    const cooldownKey = `${prKey}:${headSha || 'HEAD'}:${normalizedScope}:${targetDomain || 'all'}`;

    if (!priority && !force && !targetDomain) {
      const skipEval = shouldSkipAutoReview(pr, cfg);
      if (skipEval.skip) {
        return { skipped: true, reason: skipEval.reason, job: null };
      }
      const lastFailedAt = this.failedCooldowns.get(cooldownKey);
      if (lastFailedAt && Date.now() - lastFailedAt < this.failureCooldownMs) {
        return { skipped: true, reason: 'failure_cooldown', job: null };
      }
    } else {
      this.failedCooldowns.delete(cooldownKey);
    }

    // Write-Once guarantee: skip if shared artifact already exists for (repo, number, headSha, teamProfile)
    if (
      normalizedScope === 'shared' &&
      !force &&
      !targetDomain &&
      headSha &&
      hasReviewArtifact({
        cfg,
        repo: pr.repo,
        number: pr.number,
        headSha,
        teamProfile: cfg.teamProfile,
      })
    ) {
      return { skipped: true, reason: 'already_reviewed', job: null };
    }

    if (
      this.activeItem &&
      this.activeItem.prKey === prKey &&
      this.activeItem.scope === normalizedScope &&
      (this.activeItem.domain || '') === targetDomain
    ) {
      return { skipped: false, deduplicated: true, job: this.activeItem.job };
    }

    const existingIdx = this.queue.findIndex(
      (q) =>
        q.prKey === prKey &&
        q.scope === normalizedScope &&
        (q.domain || '') === targetDomain
    );
    if (existingIdx !== -1) {
      const existingItem = this.queue[existingIdx];
      if (force) existingItem.force = true;
      if (priority && existingIdx > 0) {
        this.queue.splice(existingIdx, 1);
        this.queue.unshift(existingItem);
        this._refreshQueuePositionLabels();
      }
      return { skipped: false, deduplicated: true, job: existingItem.job };
    }

    const job = createQueuedReviewJob({ pr, scope: normalizedScope, domain: targetDomain });
    const queueItem = {
      prKey,
      pr,
      scope: normalizedScope,
      domain: targetDomain,
      force: Boolean(force || targetDomain),
      priority: Boolean(priority),
      job,
    };

    if (priority) {
      this.queue.unshift(queueItem);
    } else {
      this.queue.push(queueItem);
    }
    this._refreshQueuePositionLabels();

    // Ensure _stopped is false when an explicit enqueue occurs (e.g. manual click or test)
    this._stopped = false;
    this._drainQueue().catch(() => {});

    return { skipped: false, deduplicated: false, job };
  }

  enqueuePendingFromLocalState({ force = false } = {}) {
    if (this.authRequired && !force) {
      return { enqueuedJobs: [], skippedCount: 0, authRequired: true };
    }
    const cfg = this.loadConfigFn();
    const openPrs = readLocalOpenPrs(cfg.reviewsDir);
    // Exclude Draft PRs and auto-review skipped PRs (bots, release/version bumps, excluded labels, etc.)
    const actionable = openPrs
      .filter((pr) => {
        if (pr.isDraft || pr.syncStatus === 'DRAFT') return false;
        if (!force && shouldSkipAutoReview(pr, cfg).skip) return false;
        return (
          pr.syncStatus === 'NEEDS_REVIEW' ||
          pr.syncStatus === 'NEEDS_UPDATE' ||
          !pr.lastReviewedSha
        );
      })
      .sort((a, b) => {
        const aNeverReviewed = !a.lastReviewedSha || a.syncStatus === 'NEEDS_REVIEW' ? 1 : 0;
        const bNeverReviewed = !b.lastReviewedSha || b.syncStatus === 'NEEDS_REVIEW' ? 1 : 0;
        if (bNeverReviewed !== aNeverReviewed) {
          return bNeverReviewed - aNeverReviewed;
        }
        const aCreated = String(a.createdAt || a.updatedAt || '');
        const bCreated = String(b.createdAt || b.updatedAt || '');
        return bCreated.localeCompare(aCreated);
      });

    const enqueuedJobs = [];
    let skippedCount = 0;
    for (const pr of actionable) {
      const res = this.enqueuePrReview(pr, {
        priority: false,
        scope: 'shared',
        force,
      });
      if (res.skipped) {
        skippedCount++;
      } else if (res.job) {
        enqueuedJobs.push(res.job);
      }
    }
    return { enqueuedJobs, skippedCount };
  }

  resumeAfterAuth() {
    this.authRequired = false;
    this.failedCooldowns.clear();
    const cfg = this.loadConfigFn();
    if (cfg.hubRole === 'worker' && cfg.autoReviewEnabled) {
      return this.enqueuePendingFromLocalState({ force: false });
    }
    return { enqueuedJobs: [], skippedCount: 0 };
  }

  async _drainQueue() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.queue.length > 0 && !this._stopped) {
        const item = this.queue.shift();
        this._refreshQueuePositionLabels();
        const cfg = this.loadConfigFn();
        const headSha = item.pr.headRefOid || item.pr.headSha || '';
        const cooldownKey = `${item.prKey}:${headSha || 'HEAD'}:${item.scope}:${item.domain || 'all'}`;

        if (
          item.scope === 'shared' &&
          !item.force &&
          !item.domain &&
          headSha &&
          hasReviewArtifact({
            cfg,
            repo: item.pr.repo,
            number: item.pr.number,
            headSha,
            teamProfile: cfg.teamProfile,
          })
        ) {
          item.job.status = 'completed';
          item.job.phase = 'Skipped (shared review already exists)';
          item.job.finishedAt = new Date().toISOString();
          continue;
        }

        this.activeItem = item;
        try {
          await this.runReviewFn({
            cfg,
            pr: item.pr,
            scope: item.scope,
            targetDomain: item.domain || '',
            existingJob: item.job,
          });
          this.authRequired = false;
          this.failedCooldowns.delete(cooldownKey);
          this.completedCount++;
        } catch (err) {
          if (isAgentAuthError(err?.message)) {
            this.authRequired = true;
            while (this.queue.length > 0) {
              const pending = this.queue.shift();
              if (pending?.job) {
                pending.job.status = 'failed';
                pending.job.phase = 'Paused — CLI authentication required';
                pending.job.error = err.message;
                pending.job.finishedAt = new Date().toISOString();
              }
            }
            this.failedCount++;
            break;
          }
          this.failedCooldowns.set(cooldownKey, Date.now());
          this.failedCount++;
        } finally {
          this.activeItem = null;
        }
      }
    } finally {
      this._draining = false;
      if (this.queue.length === 0 && !this.activeItem) {
        const resolvers = this._idleResolvers.splice(0, this._idleResolvers.length);
        for (const r of resolvers) r();
      }
    }
  }

  waitForIdle() {
    if (!this._draining && !this.activeItem && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._idleResolvers.push(resolve);
    });
  }

  async runSyncCycle({ manual = false } = {}) {
    if (this.syncInFlight) {
      return { ok: true, alreadySyncing: true, status: this.getStatus() };
    }

    this.syncInFlight = true;
    const cfg = this.loadConfigFn();
    let syncReport = null;
    let enqueuedCount = 0;

    try {
      // 0. Fast-forward centralized ubitransports/wanreview rules when running real GitHub syncs
      if (this.scanPrQueueFn === scanPrQueue) {
        await ensureWanreviewRepoSynced(cfg, {
          pull: true,
          allowAutoClone:
            !process.env.REVIEW_HUB_CONFIG &&
            process.env.REVIEW_HUB_DISABLE_WANREVIEW_AUTOCLONE !== '1',
        }).catch(() => {});
      }

      // 1. Pull latest shared artifacts from GitSharedStore if configured
      await this.pullStoreFn(cfg).catch(() => {});

      // 2. Scan GitHub PR queue
      syncReport = await this.scanPrQueueFn(cfg);

      // 3. Hydrate local .state.json + review-<repo>-<number>.md from shared/<teamProfile>
      this.hydrateFn(cfg);

      // 4. If dedicated worker node with auto-review enabled, enqueue non-Draft pending PRs
      if (cfg.hubRole === 'worker' && cfg.autoReviewEnabled) {
        const { enqueuedJobs } = this.enqueuePendingFromLocalState({ force: false });
        enqueuedCount = enqueuedJobs.length;
      }

      this.lastSyncAt = new Date().toISOString();
      this.lastSyncError = null;
      return {
        ok: true,
        manual,
        enqueuedCount,
        syncReport,
        status: this.getStatus(),
      };
    } catch (err) {
      this.lastSyncError = err.message || String(err);
      if (manual) throw err;
      return {
        ok: false,
        manual,
        error: this.lastSyncError,
        status: this.getStatus(),
      };
    } finally {
      this.syncInFlight = false;
      if (this._running) {
        this._scheduleNextTick();
      }
    }
  }

  getStatus() {
    const cfg = this.loadConfigFn();
    return {
      running: this._running,
      hubRole: cfg.hubRole || 'worker',
      authRequired: this.authRequired,
      autoReviewEnabled: Boolean(cfg.autoReviewEnabled),
      autoSyncIntervalSec: Number(cfg.autoSyncIntervalSec) || 300,
      sharedStoreConfigured: Boolean(cfg.sharedStoreRepo),
      sharedStoreRepo: cfg.sharedStoreRepo || '',
      sharedStoreBranch: cfg.sharedStoreBranch || 'reviews-store',
      syncInFlight: this.syncInFlight,
      activeJob: this.activeItem
        ? {
            id: this.activeItem.job.id,
            prKey: this.activeItem.prKey,
            scope: this.activeItem.scope,
            phase: this.activeItem.job.phase,
            startedAt: this.activeItem.job.startedAt,
          }
        : null,
      queueLength: this.queue.length,
      queuedPrKeys: this.queue.map((q) => q.prKey),
      lastSyncAt: this.lastSyncAt,
      nextSyncAt: this.nextSyncAt,
      lastSyncError: this.lastSyncError,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
    };
  }
}
