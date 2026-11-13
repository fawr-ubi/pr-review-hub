import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { scanPrQueue } from './sync.mjs';
import { createQueuedReviewJob, runPrReviewJob } from './agent.mjs';
import {
  hasReviewArtifact,
  pullSharedStore,
  hydrateLocalStateFromSharedStore,
} from './store.mjs';

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

  enqueuePrReview(pr, { priority = false, scope = 'shared', force = false } = {}) {
    if (!pr || !pr.repo || !pr.number) {
      throw new Error('Valid PR { repo, number } is required');
    }
    const cfg = this.loadConfigFn();
    const normalizedScope = scope === 'personal' ? 'personal' : 'shared';
    const prKey = `${pr.repo}#${Number(pr.number)}`;
    const headSha = pr.headRefOid || pr.headSha || '';
    const cooldownKey = `${prKey}:${headSha || 'HEAD'}:${normalizedScope}`;

    if (!priority && !force) {
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
      this.activeItem.scope === normalizedScope
    ) {
      return { skipped: false, deduplicated: true, job: this.activeItem.job };
    }

    const existingIdx = this.queue.findIndex(
      (q) => q.prKey === prKey && q.scope === normalizedScope
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

    const job = createQueuedReviewJob({ pr, scope: normalizedScope });
    const queueItem = {
      prKey,
      pr,
      scope: normalizedScope,
      force: Boolean(force),
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
    const cfg = this.loadConfigFn();
    const openPrs = readLocalOpenPrs(cfg.reviewsDir);
    // Exclude Draft PRs (isDraft or syncStatus === 'DRAFT') and prioritize unreviewed recent PRs first
    const actionable = openPrs
      .filter(
        (pr) =>
          !pr.isDraft &&
          pr.syncStatus !== 'DRAFT' &&
          (pr.syncStatus === 'NEEDS_REVIEW' ||
            pr.syncStatus === 'NEEDS_UPDATE' ||
            !pr.lastReviewedSha)
      )
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

  async _drainQueue() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.queue.length > 0 && !this._stopped) {
        const item = this.queue.shift();
        this._refreshQueuePositionLabels();
        const cfg = this.loadConfigFn();
        const headSha = item.pr.headRefOid || item.pr.headSha || '';
        const cooldownKey = `${item.prKey}:${headSha || 'HEAD'}:${item.scope}`;

        if (
          item.scope === 'shared' &&
          !item.force &&
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
            existingJob: item.job,
          });
          this.failedCooldowns.delete(cooldownKey);
          this.completedCount++;
        } catch {
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
