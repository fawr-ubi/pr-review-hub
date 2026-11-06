/* global marked, hljs, mermaid */

const urlParams = new URLSearchParams(window.location.search);
const isPopoutWindow = urlParams.get('popout') === '1';
const initialUrlPrKey = urlParams.get('pr') || null;
const initialUrlTab = urlParams.get('tab') || (isPopoutWindow ? 'diff' : 'report');

const syncChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pr-review-hub-sync') : null;

const state = {
  prs: [],
  uiState: {},
  jobs: [],
  activeFilter: 'open',
  activeRepo: 'all',
  activeAuthor: null,
  searchQuery: '',
  selectedPrKey: initialUrlPrKey,
  activeTab: initialUrlTab,
  splitMode: false,
  chatOpen: false,
  chatFindingContext: null,
  chatMessages: [],
  currentReview: null, // { file, archived, markdown, findings }
  currentDiff: null, // { files, resolvedFindings }
  selectedDiffFile: null,
  highlightedLine: null,
  selectedCommentCids: new Set(),
  // Working tree explorer state
  treeDir: '',
  treeEntries: [],
  allRepoFiles: null, // cached recursive list for current PR
  selectedTreeFile: null,
  selectedTreeLine: null,
  worktreeStatus: { mounted: false, worktreePath: null },
  // Agent rules state (Tab 5)
  rules: [],
  candidateRules: [],
  commonSections: [],
  dnaSections: [],
  fpSections: [],
  rulesFilter: 'all',
  rulesSearch: '',
  // Collapsible panels state (PR sidebar, Diff/Tree file list, and Full-Screen Focus Diff)
  prSidebarCollapsed: false,
  fileTreeCollapsed: false,
  focusDiffMode: false,
  _prevPrSidebar: false,
  _prevFileTree: false,
  activeHunkIndex: -1,
  activeFindingIndex: -1,
  diffZoom: Number(localStorage.getItem('prReviewHub.diffZoom')) || 100,
};

function applyDiffZoomVariables(zoomPct = state.diffZoom) {
  const clamped = Math.max(60, Math.min(180, Number(zoomPct) || 100));
  state.diffZoom = clamped;
  try {
    localStorage.setItem('prReviewHub.diffZoom', String(clamped));
  } catch {
    // Ignore storage quota errors
  }
  const baseFontPx = (12 * clamped) / 100;
  const linePyPx = clamped <= 75 ? 0.5 : clamped <= 90 ? 1 : clamped <= 115 ? 2 : 3;
  const lineHeight = clamped <= 80 ? 1.25 : clamped <= 110 ? 1.4 : 1.5;
  document.documentElement.style.setProperty('--diff-font-size', `${baseFontPx.toFixed(2)}px`);
  document.documentElement.style.setProperty('--diff-line-py', `${linePyPx}px`);
  document.documentElement.style.setProperty('--diff-line-height', String(lineHeight));
  document.querySelectorAll('.diff-zoom-label').forEach((el) => {
    el.textContent = `${clamped}%`;
  });
}

function adjustDiffZoom(stepDelta) {
  applyDiffZoomVariables(state.diffZoom + stepDelta * 10);
}

applyDiffZoomVariables(state.diffZoom);

if (isPopoutWindow) {
  document.getElementById('appShell')?.classList.add('popout-mode');
}

if (window.mermaid) {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
  });
}

function showToast(message, duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = stripEmojis(message);
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, duration);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Remove decorative emojis and normalize whitespace for a clean backend developer UI.
 */
function stripEmojis(str) {
  return String(str ?? '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatCleanSummary(raw) {
  if (!raw || raw === '—') return '';
  const replaced = String(raw)
    .replace(/(\d+)\s*🔴/g, '$1 blk')
    .replace(/(\d+)\s*🟠/g, '$1 maj')
    .replace(/(\d+)\s*🟡/g, '$1 min')
    .replace(/(\d+)\s*🟢/g, '$1 nit')
    .replace(/(\d+)\s*🔵/g, '$1 qst');
  return stripEmojis(replaced);
}

function formatCleanStatus(raw) {
  if (!raw) return '—';
  return stripEmojis(raw) || '—';
}

function getCardStatusClass(pr) {
  const s = `${pr.reviewStatus || ''} ${pr.findingsSummary || ''}`;
  if (s.includes('🔴') || /blocker/i.test(s)) return 'status-blocker';
  if (s.includes('🟠') || /request changes/i.test(s)) return 'status-changes';
  if (s.includes('🟢') || /approve/i.test(s)) return 'status-approved';
  return '';
}

function getSeverityMeta(rawSeverity) {
  const s = String(rawSeverity || '').toLowerCase();
  if (s.includes('🔴') || s.includes('blocker') || s.includes('blocking')) {
    return { label: 'BLOCKER', badgeClass: 'badge-severity-blocker', cardClass: 'sev-blocker' };
  }
  if (s.includes('🟠') || s.includes('major') || s.includes('important')) {
    return { label: 'MAJOR', badgeClass: 'badge-severity-major', cardClass: 'sev-major' };
  }
  if (s.includes('🟡') || s.includes('minor') || s.includes('suggestion')) {
    return { label: 'MINOR', badgeClass: 'badge-severity-minor', cardClass: 'sev-minor' };
  }
  if (s.includes('❓') || s.includes('question')) {
    return { label: 'QUESTION', badgeClass: 'badge-severity-question', cardClass: 'sev-question' };
  }
  if (s.includes('🟢') || s.includes('🔵') || s.includes('nit')) {
    return { label: 'NIT', badgeClass: 'badge-severity-nit', cardClass: 'sev-nit' };
  }
  return { label: stripEmojis(rawSeverity).toUpperCase() || 'NOTE', badgeClass: '', cardClass: '' };
}

/**
 * Safely renders inline `code` backticks as <code class="inline-code"> elements while HTML-escaping all text.
 */
function formatInlineCodeHtml(raw) {
  const cleaned = stripEmojis(raw || '');
  return cleaned
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        return `<code class="inline-code">${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part);
    })
    .join('');
}

/**
 * Formats a repository file path concisely for UI pills while keeping the full path in tooltip.
 */
function formatShortFilePath(filePath, startLine = null) {
  if (!filePath) return '';
  const short = String(filePath)
    .replace(/^projects\/services\//, '')
    .replace(/^projects\/common\//, 'common/');
  return `${short}${startLine ? `:${startLine}` : ''}`;
}

function isActionablePr(pr) {
  if (pr.isArchived) return false;
  const status = String(pr.reviewStatus || '');
  const sync = String(pr.syncStatus || '');
  const summary = String(pr.findingsSummary || '');
  return (
    sync === 'NEEDS_REVIEW' ||
    sync === 'NEEDS_UPDATE' ||
    status.includes('🔴') ||
    status.includes('🟠') ||
    /request changes|blocker/i.test(status) ||
    summary.includes('🔴') ||
    summary.includes('🟠')
  );
}

let jobPollTimer = null;

function scheduleJobPollingIfNeeded() {
  const hasRunning = (state.jobs || []).some((j) => j.status === 'running');
  if (hasRunning && !jobPollTimer) {
    jobPollTimer = setInterval(async () => {
      await loadState(true);
      const stillRunning = (state.jobs || []).some((j) => j.status === 'running');
      if (!stillRunning) {
        clearInterval(jobPollTimer);
        jobPollTimer = null;
        if (state.selectedPrKey) {
          selectPr(state.selectedPrKey, false);
        }
        showToast('Audit IA terminé.');
      }
    }, 3000);
  }
}

async function loadState(preserveSelection = true) {
  const res = await fetch('/api/state');
  const data = await res.json();
  state.prs = data.prs || [];
  state.uiState = data.uiState || {};
  state.config = data.config || {};
  state.jobs = data.jobs || [];

  const subtitleEl = document.getElementById('brandSubtitle');
  if (subtitleEl && state.config.githubUser) {
    const orgPrefix = state.config.githubOrg ? `${state.config.githubOrg}/` : '';
    const teamsLabel = (state.config.githubTeams || [])
      .map((t) => (orgPrefix && t.startsWith(orgPrefix) ? t.slice(orgPrefix.length) : t))
      .join(', ');
    subtitleEl.textContent = `@${state.config.githubUser}${teamsLabel ? ` · ${teamsLabel}` : ''}`;
  }

  updateFilterCounts();
  renderRepoPills();
  renderAuthorFilterBar();
  renderPrList();
  scheduleJobPollingIfNeeded();

  if (!preserveSelection || !state.selectedPrKey) {
    const targetPr =
      (initialUrlPrKey && state.prs.find((p) => p.key === initialUrlPrKey)) ||
      state.prs.find((p) => !p.isArchived && p.hasReviewFile) ||
      state.prs[0];
    if (targetPr) {
      await selectPr(targetPr.key, false);
      if (initialUrlTab && initialUrlTab !== 'report') {
        switchTab(initialUrlTab);
      }
    }
  } else {
    const stillExists = state.prs.find((p) => p.key === state.selectedPrKey);
    if (stillExists) {
      renderTopbar(stillExists);
    }
  }
}

function updateFilterCounts() {
  const openPrs = state.prs.filter((p) => !p.isArchived);
  document.getElementById('count-open').textContent = openPrs.length;
  document.getElementById('count-actionable').textContent = openPrs.filter(isActionablePr).length;
  document.getElementById('count-peer').textContent = openPrs.filter((p) => p.reviewMode === 'Peer-Review').length;
  document.getElementById('count-self').textContent = openPrs.filter((p) => p.reviewMode === 'Self-Review').length;
  document.getElementById('count-archived').textContent = state.prs.filter((p) => p.isArchived).length;
}

function renderRepoPills() {
  const container = document.getElementById('repoFilterPills');
  const repos = [...new Set(state.prs.map((p) => p.repo).filter(Boolean))];
  const pillsHtml = [
    `<button class="repo-pill ${state.activeRepo === 'all' ? 'active' : ''}" data-repo="all">all</button>`,
    ...repos.map(
      (r) =>
        `<button class="repo-pill ${state.activeRepo === r ? 'active' : ''}" data-repo="${escapeHtml(r)}">${escapeHtml(r)}</button>`
    ),
  ].join('');
  container.innerHTML = pillsHtml;

  container.querySelectorAll('.repo-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeRepo = btn.dataset.repo;
      renderRepoPills();
      renderPrList();
    });
  });
}

function renderAuthorFilterBar() {
  const bar = document.getElementById('activeAuthorFilterBar');
  const label = document.getElementById('activeAuthorFilterLabel');
  if (!bar || !label) return;
  if (!state.activeAuthor) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  label.textContent = `Filtre auteur : @${state.activeAuthor}`;
}

function getFilteredPrs() {
  return state.prs.filter((pr) => {
    if (state.activeFilter === 'open' && pr.isArchived) return false;
    if (state.activeFilter === 'actionable' && !isActionablePr(pr)) return false;
    if (state.activeFilter === 'peer' && (pr.isArchived || pr.reviewMode !== 'Peer-Review')) return false;
    if (state.activeFilter === 'self' && (pr.isArchived || pr.reviewMode !== 'Self-Review')) return false;
    if (state.activeFilter === 'archived' && !pr.isArchived) return false;

    if (state.activeRepo !== 'all' && pr.repo !== state.activeRepo) return false;
    if (state.activeAuthor && pr.author !== state.activeAuthor) return false;

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const hay = `${pr.key} ${pr.title} ${pr.author} ${pr.authorDisplayName || ''} ${pr.authorInitials || ''} ${pr.jiraKey || ''} ${pr.headRefName || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderPrList() {
  const listEl = document.getElementById('prList');
  const filtered = getFilteredPrs();

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state meta-text" style="padding:20px;text-align:center;">Aucune PR pour ce filtre.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((pr) => {
      const isSelected = pr.key === state.selectedPrKey;
      const statusClass = getCardStatusClass(pr);
      const initials = pr.authorInitials || (pr.author || 'PR').slice(0, 2).toUpperCase();
      const authorTooltip = `${pr.authorDisplayName || pr.author} (@${pr.author})`;
      const isAuthorActive = state.activeAuthor === pr.author;

      const jiraBadge =
        pr.jiraKey && pr.jiraKey !== '—'
          ? `<span class="badge">${escapeHtml(pr.jiraKey)}</span>`
          : '';
      const stackBadge = pr.isStacked
        ? `<span class="badge badge-severity-major" title="Target: ${escapeHtml(pr.baseRefName)}">STACK</span>`
        : '';
      const ciBadge =
        pr.ciStatus === 'PASS'
          ? `<span class="badge badge-severity-ok">CI:PASS</span>`
          : pr.ciStatus === 'FAIL'
          ? `<span class="badge badge-severity-blocker">CI:FAIL</span>`
          : pr.ciStatus === 'PENDING'
          ? `<span class="badge">CI:WAIT</span>`
          : '';
      const wtBadge = pr.worktreeMounted ? `<span class="badge" title="Worktree monté">WT</span>` : '';

      const postedInfo =
        pr.findingsCount > 0
          ? `<span class="badge" title="Commentaires postés">${pr.postedCount}/${pr.findingsCount}</span>`
          : '';

      const needsRun = pr.syncStatus === 'NEEDS_REVIEW' || pr.syncStatus === 'NEEDS_UPDATE';
      const quickRunBtn = pr.runningJob
        ? `<span class="badge"><span class="spinner"></span> Run</span>`
        : needsRun
        ? `<button class="btn btn-secondary btn-xs card-run-review-btn" data-key="${escapeHtml(pr.key)}" title="Lancer la review maintenant">Run</button>`
        : '';

      const cleanStatus = formatCleanStatus(pr.reviewStatus);
      const cleanSummary = formatCleanSummary(pr.findingsSummary);

      return `
        <div class="pr-card ${statusClass} ${isSelected ? 'active' : ''}" data-key="${escapeHtml(pr.key)}">
          <div class="pr-card-top">
            <div style="display:flex;gap:6px;align-items:center;">
              <span class="author-badge ${isAuthorActive ? 'active' : ''}" data-author="${escapeHtml(pr.author)}" title="${escapeHtml(authorTooltip)} (Cliquer pour filtrer)">${escapeHtml(initials)}</span>
              <span class="pr-card-key">${escapeHtml(pr.repo)}#${pr.number}</span>
            </div>
            <div style="display:flex;gap:4px;align-items:center;">
              ${wtBadge}
              ${stackBadge}
              ${ciBadge}
              ${jiraBadge}
            </div>
          </div>
          <div class="pr-card-title">${escapeHtml(pr.title || pr.key)}</div>
          <div class="pr-card-bottom">
            <span>${escapeHtml(cleanStatus)}</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <span>${escapeHtml(cleanSummary)}</span>
              ${postedInfo}
              ${quickRunBtn}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.pr-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.author-badge') || e.target.closest('.card-run-review-btn')) {
        return;
      }
      selectPr(card.dataset.key, true);
    });
  });

  listEl.querySelectorAll('.author-badge').forEach((badge) => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const author = badge.dataset.author;
      state.activeAuthor = state.activeAuthor === author ? null : author;
      renderAuthorFilterBar();
      renderPrList();
    });
  });

  listEl.querySelectorAll('.card-run-review-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await triggerManualReviewForKey(btn.dataset.key);
    });
  });
}

function renderTopbar(pr) {
  document.getElementById('emptyMainState').classList.add('hidden');
  document.getElementById('prContentArea').classList.remove('hidden');

  const initialsEl = document.getElementById('prAuthorInitialsBadge');
  if (initialsEl) {
    initialsEl.textContent = pr.authorInitials || (pr.author || 'PR').slice(0, 2).toUpperCase();
    initialsEl.title = `${pr.authorDisplayName || pr.author} (@${pr.author})`;
  }

  document.getElementById('prRepoBadge').textContent = `${pr.repo}#${pr.number}`;
  const modeBadge = document.getElementById('prModeBadge');
  modeBadge.textContent = pr.reviewMode === 'Self-Review' ? 'self-review' : 'peer-review';
  modeBadge.className = 'badge';

  const verdictEl = document.getElementById('prVerdictBadge');
  const cleanVerdict = formatCleanStatus(pr.reviewStatus || pr.state || 'OPEN');
  verdictEl.textContent = cleanVerdict;
  const sClass = getCardStatusClass(pr);
  verdictEl.className =
    sClass === 'status-blocker'
      ? 'badge badge-severity-blocker'
      : sClass === 'status-changes'
      ? 'badge badge-severity-major'
      : sClass === 'status-approved'
      ? 'badge badge-severity-ok'
      : 'badge';

  const ciEl = document.getElementById('prCiBadge');
  if (ciEl) {
    if (pr.ciStatus && pr.ciStatus !== 'NONE') {
      ciEl.textContent = `CI:${pr.ciStatus}`;
      ciEl.className = `badge badge-mono ${
        pr.ciStatus === 'PASS'
          ? 'badge-severity-ok'
          : pr.ciStatus === 'FAIL'
          ? 'badge-severity-blocker'
          : ''
      }`;
      ciEl.classList.remove('hidden');
    } else {
      ciEl.classList.add('hidden');
    }
  }

  const stackEl = document.getElementById('prStackBadge');
  if (stackEl) {
    if (pr.isStacked) {
      stackEl.textContent = `STACK -> ${pr.baseRefName}`;
      stackEl.classList.remove('hidden');
    } else {
      stackEl.classList.add('hidden');
    }
  }

  const jiraEl = document.getElementById('prJiraLink');
  if (pr.jiraKey && pr.jiraKey !== '—') {
    jiraEl.textContent = `${pr.jiraKey} ↗`;
    jiraEl.href = `https://ubitransport.atlassian.net/browse/${pr.jiraKey}`;
    jiraEl.classList.remove('hidden');
  } else {
    jiraEl.classList.add('hidden');
  }

  const sha = (pr.headRefOid || pr.lastReviewedSha || '').slice(0, 7);
  document.getElementById('prShaBadge').textContent = sha ? sha : '';
  document.getElementById('prAuthorBadge').textContent = pr.author
    ? `${pr.authorDisplayName || pr.author} (@${pr.author})`
    : '';
  document.getElementById('prTitleHeader').textContent = pr.title || pr.key;
  document.getElementById('prBranchRow').textContent = pr.headRefName
    ? `${pr.headRefName} -> ${pr.baseRefName || 'develop'}`
    : '';
  document.getElementById('openGithubPrBtn').href =
    pr.url || `https://github.com/ubitransports/${pr.repo}/pull/${pr.number}`;

  // Review trigger button state
  const reviewSpinner = document.getElementById('reviewJobSpinner');
  const reviewLabel = document.getElementById('triggerReviewLabel');
  if (pr.runningJob) {
    reviewSpinner?.classList.remove('hidden');
    if (reviewLabel) reviewLabel.textContent = 'Running...';
  } else {
    reviewSpinner?.classList.add('hidden');
    if (reviewLabel) reviewLabel.textContent = pr.hasReviewFile ? 'Re-run Review' : 'Run Review';
  }

  renderWorktreeStatusBar(pr);
}

function renderWorktreeStatusBar(pr) {
  const badge = document.getElementById('worktreeStatusBadge');
  const mountBtn = document.getElementById('mountWorktreeBtn');
  const unmountBtn = document.getElementById('unmountWorktreeBtn');
  if (!badge || !mountBtn || !unmountBtn) return;

  const isMounted = Boolean(state.worktreeStatus?.mounted || pr?.worktreeMounted);
  if (isMounted) {
    badge.textContent = 'WT: mounted';
    badge.className = 'badge badge-mono badge-severity-ok';
    badge.title = state.worktreeStatus?.worktreePath || pr?.worktreePath || '';
    mountBtn.textContent = 'Sync WT';
    unmountBtn.classList.remove('hidden');
  } else {
    badge.textContent = 'WT: zero-disk';
    badge.className = 'badge badge-mono';
    badge.title = 'Exploration directe via Git (cliquer sur Mount WT pour créer un dossier worktree isolé)';
    mountBtn.textContent = 'Mount WT';
    unmountBtn.classList.add('hidden');
  }
}

async function selectPr(prKey, broadcast = true) {
  state.selectedPrKey = prKey;
  state.currentReview = null;
  state.currentDiff = null;
  state.selectedDiffFile = null;
  state.highlightedLine = null;
  state.treeDir = '';
  state.treeEntries = [];
  state.allRepoFiles = null;
  state.selectedTreeFile = null;
  state.chatFindingContext = null;
  renderPrList();

  const pr = state.prs.find((p) => p.key === prKey);
  if (!pr) return;

  state.worktreeStatus = {
    mounted: Boolean(pr.worktreeMounted),
    worktreePath: pr.worktreePath || null,
  };

  renderTopbar(pr);
  document.getElementById('tabFilesCount').textContent = '…';

  if (broadcast && syncChannel) {
    syncChannel.postMessage({ type: 'SELECT_PR', prKey });
  }

  if (pr.reviewFile) {
    const res = await fetch(
      `/api/review?file=${encodeURIComponent(pr.reviewFile)}&key=${encodeURIComponent(pr.key)}`
    );
    if (res.ok) {
      state.currentReview = await res.json();
      state.selectedCommentCids = new Set(
        state.currentReview.findings.filter((f) => !f.posted && !f.dismissed).map((f) => f.cid)
      );
      renderReportFindingsQuickBar();
      renderMarkdownReport(state.currentReview.markdown);
      renderFindingsTab();
    } else {
      document.getElementById('reportExecutiveHeader')?.classList.add('hidden');
      document.getElementById('reportFindingsQuickBar')?.classList.add('hidden');
      document.getElementById('markdownContainer').innerHTML = `<div class="empty-state meta-text">Fichier de review introuvable (${escapeHtml(pr.reviewFile)}).</div>`;
      document.getElementById('findingsList').innerHTML = '';
      document.getElementById('tabFindingsCount').textContent = '0';
    }
  } else {
    document.getElementById('reportExecutiveHeader')?.classList.add('hidden');
    document.getElementById('reportFindingsQuickBar')?.classList.add('hidden');
    document.getElementById('markdownContainer').innerHTML = `
      <div class="empty-card" style="margin:40px auto;">
        <h3>Aucun fichier de review local</h3>
        <p class="meta-text" style="margin-bottom:14px;">Statut : ${escapeHtml(formatCleanStatus(pr.reviewStatus || pr.syncStatus || 'En attente'))}</p>
        <div style="display:flex;gap:8px;justify-content:center;">
          <button id="emptyCardRunReviewBtn" class="btn btn-primary btn-sm">Lancer l'audit IA maintenant</button>
          <a href="${escapeHtml(pr.url)}" target="_blank" class="btn btn-secondary btn-sm">Ouvrir sur GitHub ↗</a>
        </div>
      </div>
    `;
    document.getElementById('emptyCardRunReviewBtn')?.addEventListener('click', () => {
      triggerManualReviewForKey(pr.key);
    });
    document.getElementById('findingsList').innerHTML = '';
    document.getElementById('tabFindingsCount').textContent = '0';
  }

  loadDiffForCurrentPr(pr);
  loadTreeDirectory(pr, '');
  if (state.chatOpen) {
    loadChatForCurrentPr(pr);
  }
}

function renderReportFindingsQuickBar() {
  const barEl = document.getElementById('reportFindingsQuickBar');
  if (!barEl) return;
  const findings = state.currentReview?.findings || [];
  if (findings.length === 0) {
    barEl.classList.add('hidden');
    return;
  }

  const counts = { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0, QUESTION: 0 };
  for (const f of findings) {
    if (f.dismissed) continue;
    const lbl = getSeverityMeta(f.severity).label;
    if (counts[lbl] !== undefined) counts[lbl]++;
  }
  const summaryPills = [
    counts.BLOCKER ? `<span class="badge badge-severity-blocker">${counts.BLOCKER} BLOCKER</span>` : '',
    counts.MAJOR ? `<span class="badge badge-severity-major">${counts.MAJOR} MAJOR</span>` : '',
    counts.MINOR ? `<span class="badge badge-severity-minor">${counts.MINOR} MINOR</span>` : '',
    counts.NIT ? `<span class="badge badge-severity-nit">${counts.NIT} NIT</span>` : '',
    counts.QUESTION ? `<span class="badge badge-severity-question">${counts.QUESTION} QUESTION</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  barEl.classList.remove('hidden');
  barEl.innerHTML = `
    <div class="report-qbar-header">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong style="font-size:12.5px;color:var(--text-primary);">Synthèse des Findings (${findings.length})</strong>
        ${summaryPills}
      </div>
      <span class="meta-text">Cliquer sur #ID pour aller au détail &middot; Cliquer sur un fichier l'ouvre dans le Diff</span>
    </div>
    <div class="report-qbar-list">
      ${findings
        .map((f, idx) => {
          const sev = getSeverityMeta(f.severity);
          const fullLoc = f.filePath ? `${f.filePath}${f.startLine ? `:${f.startLine}` : ''}` : '';
          const shortLoc = formatShortFilePath(f.filePath, f.startLine);
          return `
            <div class="report-finding-row ${sev.cardClass} ${f.dismissed ? 'dismissed' : ''}">
              <div class="report-finding-main">
                <span class="badge ${sev.badgeClass}">${escapeHtml(sev.label)}</span>
                <a href="#report-finding-${idx}" class="finding-id-link qbar-jump-btn" data-idx="${idx}" title="Aller à la section détaillée ${escapeHtml(f.id)}">${escapeHtml(f.id)}</a>
                ${f.category ? `<span class="finding-cat-pill">${formatInlineCodeHtml(f.category)}</span>` : ''}
                <span class="report-finding-title">${formatInlineCodeHtml(f.title)}</span>
              </div>
              <div class="report-finding-meta">
                <div class="report-finding-loc">
                  ${
                    fullLoc
                      ? `<button class="finding-file-btn qbar-file-btn" data-path="${escapeHtml(f.filePath)}" data-line="${f.startLine || ''}" title="Ouvrir dans le Diff Git : ${escapeHtml(fullLoc)}">${escapeHtml(shortLoc)}</button>`
                      : `<span class="meta-text">Portée générale PR</span>`
                  }
                </div>
                <div class="report-finding-actions">
                  ${
                    f.filePath
                      ? `<button class="btn btn-ghost btn-xs qbar-tree-btn" data-path="${escapeHtml(f.filePath)}" data-line="${f.startLine || ''}" title="Voir le fichier entier dans l'arbre de travail">Tree</button>`
                      : ''
                  }
                  <button class="btn btn-ghost btn-xs qbar-ask-btn" data-idx="${idx}" title="Poser une question à l'agent sur ce finding">Ask Agent</button>
                  <button class="btn btn-ghost btn-xs qbar-add-rule-btn" data-idx="${idx}" title="Extraire une règle permanente dans reviewer-dna.md">+ Rule</button>
                  <button class="btn btn-ghost btn-xs qbar-dismiss-btn" data-idx="${idx}" title="Marquer comme faux positif (met à jour false-positives.md)">${f.dismissed ? 'Dismissed' : 'False Positive'}</button>
                  <button class="btn btn-secondary btn-xs qbar-copy-btn" data-idx="${idx}">Copy MD</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;

  barEl.querySelectorAll('.qbar-jump-btn').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(`report-finding-${link.dataset.idx}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  barEl.querySelectorAll('.qbar-file-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateToCodeLocation(btn.dataset.path, Number(btn.dataset.line) || null, 'diff');
    });
  });

  barEl.querySelectorAll('.qbar-tree-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateToCodeLocation(btn.dataset.path, Number(btn.dataset.line) || null, 'tree');
    });
  });

  barEl.querySelectorAll('.qbar-ask-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      if (f) openChatWithFindingContext(f);
    });
  });

  barEl.querySelectorAll('.qbar-add-rule-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      if (f) promptAddRuleFromFinding(f);
    });
  });

  barEl.querySelectorAll('.qbar-dismiss-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      if (f) promptDismissFinding(f);
    });
  });

  barEl.querySelectorAll('.qbar-copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const f = findings[Number(btn.dataset.idx)];
      if (f) {
        await navigator.clipboard.writeText(f.customComment);
        showToast(`Commentaire ${f.id} copié.`);
      }
    });
  });
}

function cleanMarkdownTextForReport(md) {
  return String(md || '')
    .replace(
      /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/gim,
      (_, type, rest) => `> **${type}:** ${rest}`
    )
    .replace(/\$\\rightarrow\$|\\rightarrow/g, '→')
    .replace(/🔴\s*Blocker/gi, 'BLOCKER')
    .replace(/🟠\s*Major/gi, 'MAJOR')
    .replace(/🟡\s*Minor/gi, 'MINOR')
    .replace(/🟢\s*Nit/gi, 'NIT')
    .replace(/🔵\s*Question/gi, 'QUESTION')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
}

/**
 * Splits a review markdown document into:
 * - executiveSections: "0. Incremental Update" and "1. Task Summary & Functional Problem Solved"
 * - bodyMarkdown: the remaining sections (without the redundant top H1 metadata preamble or duplicate summary tables)
 */
function splitReviewMarkdownSections(rawMarkdown, hasParsedFindings) {
  const lines = String(rawMarkdown || '').split(/\r?\n/);
  const h2Blocks = [];
  let currentBlock = { heading: null, lines: [] };

  let inFence = false;
  let fenceTicks = '';

  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,4})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceTicks = fenceMatch[1];
      } else if (line.trim() === fenceTicks) {
        inFence = false;
        fenceTicks = '';
      }
    }

    if (!inFence && /^##\s+/.test(line)) {
      h2Blocks.push(currentBlock);
      currentBlock = { heading: line.replace(/^##\s+/, '').trim(), lines: [line] };
    } else {
      currentBlock.lines.push(line);
    }
  }
  h2Blocks.push(currentBlock);

  const executiveBlocks = [];
  const bodyBlocks = [];

  for (const block of h2Blocks) {
    if (!block.heading) {
      // Preamble before first ## heading: contains redundant # Code Review H1 and Author/Branch/Commit bullets
      continue;
    }

    const h = stripEmojis(block.heading).toLowerCase();
    const isIncremental = /^0\b|incremental update/i.test(h);
    const isTaskSummary = /^1\b|task summary|functional problem/i.test(h);
    const isDuplicateSummaryTable =
      hasParsedFindings &&
      (/prioritized findings summary|résumé des points/i.test(h) &&
        !block.lines.some((l) => /^#{3,4}\s+/.test(l)));

    if (isIncremental || isTaskSummary) {
      executiveBlocks.push({
        type: isIncremental ? 'incremental' : 'summary',
        title: stripEmojis(block.heading),
        markdown: block.lines
          .slice(1)
          .filter((l) => !/^---\s*$/.test(l))
          .join('\n')
          .trim(),
      });
    } else if (isDuplicateSummaryTable) {
      continue;
    } else {
      // If a section starts with a markdown summary table right before ### subsections, strip that duplicate table
      const filteredLines = [];
      let inSubHeader = false;
      for (let i = 0; i < block.lines.length; i++) {
        const l = block.lines[i];
        if (/^#{3,4}\s+/.test(l)) inSubHeader = true;
        if (!inSubHeader && hasParsedFindings && /^\|\s*(?:#|\*\*#\d+)/i.test(l)) {
          continue;
        }
        if (!inSubHeader && hasParsedFindings && /^\|\s*:-/.test(l)) {
          continue;
        }
        if (!inSubHeader && /^###\s+(?:📊\s*)?Findings (?:Summary|Breakdown)/i.test(l)) {
          continue;
        }
        filteredLines.push(l);
      }
      bodyBlocks.push(filteredLines.join('\n'));
    }
  }

  return {
    executiveBlocks,
    bodyMarkdown: bodyBlocks.length > 0 ? bodyBlocks.join('\n\n') : rawMarkdown,
  };
}

async function renderMarkdownReport(markdown) {
  const execEl = document.getElementById('reportExecutiveHeader');
  const container = document.getElementById('markdownContainer');
  const findings = state.currentReview?.findings || [];

  const { executiveBlocks, bodyMarkdown } = splitReviewMarkdownSections(
    markdown,
    findings.length > 0
  );

  if (execEl) {
    if (executiveBlocks.length > 0) {
      execEl.classList.remove('hidden');
      execEl.innerHTML = executiveBlocks
        .map((b) => {
          const cardClass = b.type === 'incremental' ? 'report-exec-incremental' : 'report-exec-summary';
          const html = marked.parse(cleanMarkdownTextForReport(b.markdown));
          return `
            <div class="report-exec-card ${cardClass}">
              <div class="report-exec-card-header">
                <span class="report-exec-title">${escapeHtml(b.title)}</span>
              </div>
              <div class="report-exec-card-body markdown-body">${html}</div>
            </div>
          `;
        })
        .join('');
    } else {
      execEl.classList.add('hidden');
      execEl.innerHTML = '';
    }
  }

  const processedMd = cleanMarkdownTextForReport(bodyMarkdown);
  container.innerHTML = marked.parse(processedMd);

  // Upgrade Detailed Findings inside #markdownContainer into structured cards
  upgradeReportFindingsInDom(container, findings);

  const allRoots = [execEl, container].filter(Boolean);
  const mermaidBlocks = [];

  for (const root of allRoots) {
    root.querySelectorAll('pre code').forEach((block, idx) => {
      if (block.classList.contains('language-mermaid')) {
        const pre = block.parentElement;
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-wrapper';
        const id = `mermaid-svg-${Date.now()}-${idx}`;
        mermaidBlocks.push({ id, code: block.textContent, wrapper });
        pre.replaceWith(wrapper);
      } else if (window.hljs) {
        hljs.highlightElement(block);
      }
    });

    root.querySelectorAll('a[href^="file://"]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const rawHref = link.getAttribute('href');
        const withoutScheme = rawHref.replace(/^file:\/\//, '');
        const projectsDir = String(state.config?.projectsDir || '').replace(/\/+$/, '');
        let cleaned = withoutScheme;
        if (projectsDir && cleaned.startsWith(projectsDir + '/')) {
          cleaned = cleaned.slice(projectsDir.length + 1).replace(/^[^/]+\//, '');
        } else {
          cleaned = cleaned.replace(/^\/(?:Users|home)\/[^/]+\/(?:[^/]+\/)*projects\/[^/]+\//, '');
        }
        const [filePath, hash] = cleaned.split('#');
        const lineMatch = (hash || '').match(/L(\d+)/i);
        const line = lineMatch ? Number(lineMatch[1]) : null;
        navigateToCodeLocation(filePath, line, 'diff');
      });
    });
  }

  for (const item of mermaidBlocks) {
    try {
      const { svg } = await mermaid.render(item.id, item.code);
      item.wrapper.innerHTML = svg;
    } catch {
      item.wrapper.innerHTML = `<pre>${escapeHtml(item.code)}</pre>`;
    }
  }
}

function upgradeReportFindingsInDom(container, findings) {
  if (!container) return;

  // Remove noisy horizontal rules inside the report body
  container.querySelectorAll('hr').forEach((hr) => hr.remove());

  // Hide empty severity subsections that only say "None."
  container.querySelectorAll('h3').forEach((h3) => {
    const next = h3.nextElementSibling;
    if (next && next.tagName === 'P' && /^none\.?$/i.test(next.textContent.trim())) {
      next.remove();
      h3.remove();
    }
  });

  if (!findings || findings.length === 0) return;

  // Find headings corresponding to findings (#1, 1., etc.)
  const candidateHeadings = Array.from(container.querySelectorAll('h3, h4')).filter((el) => {
    const txt = el.textContent.trim();
    return /^(?:comment\s+)?#?\d+\s*(?:—|-|\.|:)/i.test(txt);
  });

  candidateHeadings.forEach((headingEl) => {
    const txt = headingEl.textContent.trim();
    const idMatch = txt.match(/^(?:comment\s+)?#?(\d+)/i);
    if (!idMatch) return;
    const numStr = `#${idMatch[1]}`;
    const fIdx = findings.findIndex((f) => f.id === numStr);
    const finding = fIdx >= 0 ? findings[fIdx] : null;
    if (!finding) return;

    const sev = getSeverityMeta(finding.severity);
    const fullLoc = finding.filePath
      ? `${finding.filePath}${finding.startLine ? `:${finding.startLine}` : ''}`
      : '';
    const shortLoc = formatShortFilePath(finding.filePath, finding.startLine);

    // Collect sibling nodes belonging to this finding until the next heading (H1..H4)
    const bodyNodes = [];
    let cursor = headingEl.nextElementSibling;
    while (cursor && !/^H[1-4]$/.test(cursor.tagName)) {
      const next = cursor.nextElementSibling;
      // Stop if it's a standalone H4 for Ready-to-paste comment — actually include it inside the card!
      bodyNodes.push(cursor);
      cursor = next;
    }
    // Also include any following H4 "Ready-to-paste GitHub Comment" and its code block
    while (
      cursor &&
      cursor.tagName === 'H4' &&
      /ready-to-paste|commentaire prêt|suggestion prête/i.test(cursor.textContent)
    ) {
      const nextAfterH4 = cursor.nextElementSibling;
      bodyNodes.push(cursor);
      cursor = nextAfterH4;
      while (cursor && !/^H[1-4]$/.test(cursor.tagName)) {
        const n = cursor.nextElementSibling;
        bodyNodes.push(cursor);
        cursor = n;
      }
    }

    const card = document.createElement('div');
    card.id = `report-finding-${fIdx}`;
    card.className = `report-detail-card ${sev.cardClass} ${finding.dismissed ? 'dismissed' : ''}`;

    const header = document.createElement('div');
    header.className = 'report-detail-card-header';
    header.innerHTML = `
      <div class="report-detail-header-left">
        <span class="badge ${sev.badgeClass}">${escapeHtml(sev.label)}</span>
        <span class="finding-id">${escapeHtml(finding.id)}</span>
        ${finding.category ? `<span class="finding-cat-pill">${formatInlineCodeHtml(finding.category)}</span>` : ''}
        <span class="report-detail-title">${formatInlineCodeHtml(finding.title)}</span>
      </div>
      <div class="report-detail-header-right">
        ${
          fullLoc
            ? `<button class="finding-file-btn rcard-file-btn" data-path="${escapeHtml(finding.filePath)}" data-line="${finding.startLine || ''}" title="Voir dans le Diff Git : ${escapeHtml(fullLoc)}">${escapeHtml(shortLoc)}</button>
               <button class="btn btn-ghost btn-xs rcard-tree-btn" data-path="${escapeHtml(finding.filePath)}" data-line="${finding.startLine || ''}" title="Voir dans l'Arbre de Travail">Tree</button>`
            : ''
        }
        <button class="btn btn-ghost btn-xs rcard-ask-btn" data-idx="${fIdx}">Ask Agent</button>
        <button class="btn btn-ghost btn-xs rcard-rule-btn" data-idx="${fIdx}">+ Rule</button>
        <button class="btn btn-ghost btn-xs rcard-fp-btn" data-idx="${fIdx}">${finding.dismissed ? 'Dismissed' : 'False Positive'}</button>
        <button class="btn btn-secondary btn-xs rcard-copy-btn" data-idx="${fIdx}">Copy MD</button>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'report-detail-card-body';

    headingEl.replaceWith(card);
    card.appendChild(header);
    card.appendChild(body);

    for (const node of bodyNodes) {
      body.appendChild(node);
    }

    // Clean up redundant "File:" / "Category:" / "Ready-to-paste GitHub comment:" bullets inside the card body
    body.querySelectorAll('li').forEach((li) => {
      const strong = li.querySelector(':scope > strong');
      if (!strong) return;
      const label = strong.textContent.trim().replace(/:$/, '').toLowerCase();
      if (
        (label === 'file' || label === 'fichier' || label === 'target' || label === 'cible') &&
        finding.filePath
      ) {
        li.remove();
      } else if (label === 'category' || label === 'catégorie') {
        li.remove();
      } else if (/ready-to-paste|commentaire prêt|suggestion prête/i.test(label)) {
        li.remove();
      }
    });

    // Remove standalone paragraphs/headings that only say "Ready-to-paste GitHub comment:"
    body.querySelectorAll('p, h4').forEach((el) => {
      const t = el.textContent.trim();
      if (/^(?:ready-to-paste|commentaire prêt|suggestion prête).*?:?$/i.test(t) && el.children.length <= 1) {
        el.remove();
      }
    });

    // Wrap the trailing ready-to-paste <pre> block into a clean collapsible <details> element
    const preBlocks = Array.from(body.querySelectorAll(':scope > pre'));
    if (preBlocks.length > 0) {
      const lastPre = preBlocks[preBlocks.length - 1];
      const details = document.createElement('details');
      details.className = 'report-comment-details';
      const summary = document.createElement('summary');
      summary.innerHTML = `<span>Aperçu du commentaire GitHub prêt à poster</span><span class="meta-text">Cliquer pour déplier / masquer</span>`;
      details.appendChild(summary);
      lastPre.replaceWith(details);
      details.appendChild(lastPre);
    }

    header.querySelector('.rcard-file-btn')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      navigateToCodeLocation(btn.dataset.path, Number(btn.dataset.line) || null, 'diff');
    });
    header.querySelector('.rcard-tree-btn')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      navigateToCodeLocation(btn.dataset.path, Number(btn.dataset.line) || null, 'tree');
    });
    header.querySelector('.rcard-ask-btn')?.addEventListener('click', () => {
      openChatWithFindingContext(finding);
    });
    header.querySelector('.rcard-rule-btn')?.addEventListener('click', () => {
      promptAddRuleFromFinding(finding);
    });
    header.querySelector('.rcard-fp-btn')?.addEventListener('click', () => {
      promptDismissFinding(finding);
    });
    header.querySelector('.rcard-copy-btn')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(finding.customComment);
      showToast(`Commentaire ${finding.id} copié.`);
    });
  });
}

function navigateToCodeLocation(filePath, line = null, preferredView = 'diff') {
  if (syncChannel && !isPopoutWindow) {
    syncChannel.postMessage({
      type: 'OPEN_FILE',
      prKey: state.selectedPrKey,
      filePath,
      line,
      view: preferredView,
    });
  }

  if (preferredView === 'tree') {
    if (state.splitMode) {
      setSplitRightPanel('tree');
    } else {
      switchTab('tree');
    }
    openFileInWorkingTree(filePath, line);
  } else {
    if (state.splitMode) {
      setSplitRightPanel('diff');
    } else {
      switchTab('diff');
    }
    openFileInDiffViewer(filePath, line);
  }
}

function renderFindingsTab() {
  const findings = state.currentReview?.findings || [];
  document.getElementById('tabFindingsCount').textContent = findings.length;
  const listEl = document.getElementById('findingsList');

  const postedCount = findings.filter((f) => f.posted).length;
  const dismissedCount = findings.filter((f) => f.dismissed).length;
  document.getElementById('commentsSummaryStats').textContent =
    `${postedCount}/${findings.length} posté(s)` +
    (dismissedCount > 0 ? ` · ${dismissedCount} faux positif(s)` : '');

  if (findings.length === 0) {
    listEl.innerHTML = `<div class="empty-card" style="margin:32px auto;"><p>Aucun commentaire à afficher pour cette PR.</p></div>`;
    return;
  }

  listEl.innerHTML = findings
    .map((f, idx) => {
      const isSelected = state.selectedCommentCids.has(f.cid);
      const sev = getSeverityMeta(f.severity);
      const fullLocation = f.filePath
        ? `${f.filePath}${f.startLine ? `:${f.startLine}` : ''}`
        : 'Commentaire général PR';
      const shortLocation = f.filePath ? formatShortFilePath(f.filePath, f.startLine) : fullLocation;

      return `
        <div class="finding-card ${sev.cardClass} ${f.posted ? 'posted' : ''}" data-cid="${escapeHtml(f.cid)}" data-idx="${idx}" style="${f.dismissed ? 'opacity:0.5;' : ''}">
          <div class="finding-card-header">
            <div class="finding-header-left">
              <input
                type="checkbox"
                class="finding-select-cb"
                data-cid="${escapeHtml(f.cid)}"
                ${isSelected ? 'checked' : ''}
                title="Inclure dans l'envoi groupé"
              />
              <span class="badge ${sev.badgeClass}">${escapeHtml(sev.label)}</span>
              <span class="finding-id">${escapeHtml(f.id)}</span>
              ${f.category ? `<span class="finding-cat-pill">${formatInlineCodeHtml(f.category)}</span>` : ''}
              <span class="finding-title">${formatInlineCodeHtml(f.title)}</span>
              ${f.dismissed ? `<span class="badge">FALSE POSITIVE</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${
                f.filePath
                  ? `<button class="finding-file-btn" data-path="${escapeHtml(f.filePath)}" data-line="${f.startLine || ''}" title="Voir dans le diff : ${escapeHtml(fullLocation)}">
                      ${escapeHtml(shortLocation)}
                    </button>
                    <button class="btn btn-ghost btn-xs finding-tree-btn" data-path="${escapeHtml(f.filePath)}" data-line="${f.startLine || ''}" title="Voir dans l'arbre de travail">
                      Tree
                    </button>`
                  : `<span class="meta-text">${escapeHtml(fullLocation)}</span>`
              }
              <label class="checkbox-label">
                <input type="checkbox" class="finding-posted-cb" data-cid="${escapeHtml(f.cid)}" ${f.posted ? 'checked' : ''} />
                <span>Posté</span>
              </label>
            </div>
          </div>

          <div class="finding-body">
            <textarea class="finding-textarea" data-cid="${escapeHtml(f.cid)}">${escapeHtml(f.customComment)}</textarea>

            <div class="finding-actions">
              <div class="finding-actions-left">
                <button class="btn btn-secondary btn-sm copy-comment-btn" data-idx="${idx}">
                  Copier Markdown
                </button>
                <button class="btn btn-ghost btn-sm ask-agent-finding-btn" data-idx="${idx}">
                  Ask Agent
                </button>
                <button class="btn btn-ghost btn-sm add-rule-finding-btn" data-idx="${idx}" title="Ajouter ce pattern comme règle permanente de l'agent">
                  + Rule
                </button>
                <button class="btn btn-ghost btn-sm dismiss-finding-btn" data-idx="${idx}">
                  False Positive
                </button>
                <button class="btn btn-ghost btn-sm reset-comment-btn" data-idx="${idx}">
                  Réinitialiser
                </button>
              </div>
              <div class="finding-actions-right">
                ${
                  f.filePath
                    ? `<button class="btn btn-primary btn-sm post-inline-btn" data-idx="${idx}">
                        Poster en inline
                      </button>`
                    : ''
                }
                <button class="btn btn-secondary btn-sm post-general-btn" data-idx="${idx}">
                  Poster en général
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.finding-select-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedCommentCids.add(cb.dataset.cid);
      else state.selectedCommentCids.delete(cb.dataset.cid);
    });
  });

  listEl.querySelectorAll('.finding-posted-cb').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const cid = cb.dataset.cid;
      const finding = findings.find((x) => x.cid === cid);
      if (finding) finding.posted = cb.checked;
      await fetch('/api/ui-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid, posted: cb.checked }),
      });
      renderFindingsTab();
      loadState(true);
    });
  });

  listEl.querySelectorAll('.finding-textarea').forEach((ta) => {
    let saveTimer = null;
    ta.addEventListener('input', () => {
      const cid = ta.dataset.cid;
      const finding = findings.find((x) => x.cid === cid);
      if (finding) finding.customComment = ta.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        fetch('/api/ui-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cid, customComment: ta.value }),
        });
      }, 450);
    });
  });

  listEl.querySelectorAll('.finding-file-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateToCodeLocation(btn.dataset.path, Number(btn.dataset.line) || null, 'diff');
    });
  });

  listEl.querySelectorAll('.finding-tree-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateToCodeLocation(btn.dataset.path, Number(btn.dataset.line) || null, 'tree');
    });
  });

  listEl.querySelectorAll('.copy-comment-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const f = findings[Number(btn.dataset.idx)];
      await navigator.clipboard.writeText(f.customComment);
      showToast(`Commentaire ${f.id} copié.`);
    });
  });

  listEl.querySelectorAll('.ask-agent-finding-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      if (f) openChatWithFindingContext(f);
    });
  });

  listEl.querySelectorAll('.add-rule-finding-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      if (f) promptAddRuleFromFinding(f);
    });
  });

  listEl.querySelectorAll('.dismiss-finding-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      if (f) promptDismissFinding(f);
    });
  });

  listEl.querySelectorAll('.reset-comment-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const f = findings[Number(btn.dataset.idx)];
      f.customComment = f.comment;
      await fetch('/api/ui-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: f.cid, customComment: f.comment }),
      });
      renderFindingsTab();
      showToast(`Texte de ${f.id} réinitialisé.`);
    });
  });

  listEl.querySelectorAll('.post-inline-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      openSingleCommentModal(f, 'inline');
    });
  });

  listEl.querySelectorAll('.post-general-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = findings[Number(btn.dataset.idx)];
      openSingleCommentModal(f, 'general');
    });
  });
}

async function loadDiffForCurrentPr(pr) {
  const treeEl = document.getElementById('diffFileTree');
  const viewerEl = document.getElementById('diffViewerContainer');
  treeEl.innerHTML = `<div class="empty-state meta-text" style="padding:16px;">Chargement des fichiers...</div>`;

  try {
    const res = await fetch(
      `/api/diff?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&reviewFile=${encodeURIComponent(pr.reviewFile || '')}`
    );
    if (!res.ok) throw new Error('Erreur lors de la récupération du diff GitHub');
    const data = await res.json();
    if (state.selectedPrKey !== pr.key) return;

    state.currentDiff = data;
    document.getElementById('tabFilesCount').textContent = (data.files || []).length;
    renderDiffTree();

    if (data.files && data.files.length > 0 && !state.selectedDiffFile) {
      const fileWithFinding = data.resolvedFindings?.find((f) => f.inDiff && f.resolvedPath)?.resolvedPath;
      selectDiffFile(fileWithFinding || data.files[0].filename);
    } else if (state.selectedDiffFile) {
      selectDiffFile(state.selectedDiffFile, state.highlightedLine);
    } else {
      viewerEl.innerHTML = `<div class="empty-state meta-text">Aucun fichier dans le diff.</div>`;
    }
  } catch (err) {
    treeEl.innerHTML = `<div class="empty-state meta-text" style="padding:16px;">${escapeHtml(err.message)}</div>`;
  }
}

function renderDiffTree() {
  const treeEl = document.getElementById('diffFileTree');
  const files = state.currentDiff?.files || [];
  const resolvedFindings = state.currentDiff?.resolvedFindings || [];

  treeEl.innerHTML = files
    .map((file) => {
      const isSelected = file.filename === state.selectedDiffFile;
      const fileFindings = resolvedFindings.filter((f) => f.resolvedPath === file.filename && !f.dismissed);
      const findingBadge =
        fileFindings.length > 0
          ? `<span class="badge badge-severity-major">${fileFindings.length}</span>`
          : '';
      const shortName = file.filename.replace(/^projects\/services\//, '');

      return `
        <div class="diff-file-item ${isSelected ? 'active' : ''}" data-filename="${escapeHtml(file.filename)}" title="${escapeHtml(file.filename)}">
          <span class="diff-file-name">${escapeHtml(shortName)}</span>
          <div class="diff-stats">
            ${findingBadge}
            <span class="stat-add">+${file.additions}</span>
            <span class="stat-del">-${file.deletions}</span>
          </div>
        </div>
      `;
    })
    .join('');

  treeEl.querySelectorAll('.diff-file-item').forEach((item) => {
    item.addEventListener('click', () => {
      selectDiffFile(item.dataset.filename, null);
    });
  });
}

function selectDiffFile(filename, highlightLine = null) {
  state.selectedDiffFile = filename;
  state.highlightedLine = highlightLine;
  state.activeHunkIndex = -1;
  renderDiffTree();

  // Keep active file item visible in the file tree sidebar
  const activeTreeItem = document.querySelector('#diffFileTree .diff-file-item.active');
  activeTreeItem?.scrollIntoView({ block: 'nearest' });

  const viewerEl = document.getElementById('diffViewerContainer');
  const files = state.currentDiff?.files || [];
  const fileObj = files.find((f) => f.filename === filename);

  if (!fileObj) {
    viewerEl.innerHTML = `<div class="empty-state meta-text">Fichier "${escapeHtml(filename)}" non trouvé dans le diff.</div>`;
    return;
  }

  const fileFindings = (state.currentDiff?.resolvedFindings || []).filter(
    (f) => f.resolvedPath === filename && !f.dismissed
  );

  const rowsHtml = renderPatchTableRows(fileObj.patch || '', fileFindings, highlightLine);
  const fileIdx = files.findIndex((f) => f.filename === filename);
  const prevFile = fileIdx > 0 ? files[fileIdx - 1] : null;
  const nextFile = fileIdx >= 0 && fileIdx < files.length - 1 ? files[fileIdx + 1] : null;

  const fileOptionsHtml = files
    .map((f, idx) => {
      const fFindingsCount = (state.currentDiff?.resolvedFindings || []).filter(
        (rf) => rf.resolvedPath === f.filename && !rf.dismissed
      ).length;
      const shortPath = f.filename.replace(/^projects\/services\//, '');
      const fTag = fFindingsCount > 0 ? ` [${fFindingsCount} finding${fFindingsCount > 1 ? 's' : ''}]` : '';
      return `<option value="${escapeHtml(f.filename)}" ${f.filename === filename ? 'selected' : ''}>${idx + 1}/${files.length} · ${escapeHtml(shortPath)} (+${f.additions} -${f.deletions})${escapeHtml(fTag)}</option>`;
    })
    .join('');

  viewerEl.innerHTML = `
    <div class="diff-file-header">
      <div style="display:flex;gap:6px;align-items:center;min-width:0;flex:1;">
        <button id="diffPrevFileBtn" class="btn btn-secondary btn-xs" ${prevFile ? '' : 'disabled'} title="Fichier précédent (Flèche Gauche ←)">&larr;</button>
        <span class="meta-text" style="white-space:nowrap;font-weight:600;">${fileIdx + 1}/${files.length}</span>
        <button id="diffNextFileBtn" class="btn btn-secondary btn-xs" ${nextFile ? '' : 'disabled'} title="Fichier suivant (Flèche Droite →)">&rarr;</button>
        <select id="diffFileJumpSelect" class="diff-file-jump-select" title="Changer rapidement de fichier (raccourci : g)">
          ${fileOptionsHtml}
        </select>
        <button id="diffCopyPathBtn" class="btn btn-ghost btn-xs" title="Copier le chemin complet : ${escapeHtml(fileObj.filename)}">Copier chemin</button>
        <div class="diff-stats" style="margin-left:2px;">
          <span class="stat-add">+${fileObj.additions}</span>
          <span class="stat-del">-${fileObj.deletions}</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
        <div class="diff-zoom-group" title="Zoomer / Dézoomer dans le diff (raccourcis : - / + / 0)">
          <button id="diffZoomOutBtn" class="btn btn-xs" title="Dézoomer (-)">&minus;</button>
          <button id="diffZoomResetBtn" class="btn btn-xs diff-zoom-label" title="Réinitialiser le zoom à 100% (0)">${state.diffZoom}%</button>
          <button id="diffZoomInBtn" class="btn btn-xs" title="Zoomer (+)">+</button>
        </div>
        <button id="diffPrevHunkBtn" class="btn btn-ghost btn-xs" title="Hunk / Finding précédent dans ce fichier (raccourci : p)">&uarr; Hunk</button>
        <button id="diffNextHunkBtn" class="btn btn-ghost btn-xs" title="Hunk / Finding suivant dans ce fichier (raccourci : n)">&darr; Hunk</button>
        <button id="diffToggleFilesInlineBtn" class="btn btn-ghost btn-xs" title="Masquer / Afficher la liste des fichiers modifiés (raccourci : ])">
          ${state.fileTreeCollapsed ? `Fichiers (${files.length})` : 'Masquer Fichiers'}
        </button>
        <button id="diffOpenFullFileBtn" class="btn btn-ghost btn-xs" title="Ouvrir le fichier complet dans l'arbre de travail (raccourci : t)">Tree</button>
        <button id="diffOpenIdeBtn" class="btn btn-ghost btn-xs" title="Ouvrir ce fichier dans PhpStorm (raccourci : i)">PhpStorm</button>
        <button id="diffToggleFocusInlineBtn" class="btn ${state.focusDiffMode ? 'btn-primary' : 'btn-secondary'} btn-xs" title="Mode Focus Diff plein écran (raccourci : z, f ou Esc)">
          ${state.focusDiffMode ? 'Quitter Focus (Esc)' : 'Focus Diff (z)'}
        </button>
      </div>
    </div>
    <div id="diffScrollArea" class="diff-scroll-area" tabindex="0">
      <div class="diff-table-wrapper">
        <table class="diff-table">
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('diffZoomOutBtn')?.addEventListener('click', () => {
    adjustDiffZoom(-1);
  });
  document.getElementById('diffZoomResetBtn')?.addEventListener('click', () => {
    applyDiffZoomVariables(100);
  });
  document.getElementById('diffZoomInBtn')?.addEventListener('click', () => {
    adjustDiffZoom(1);
  });

  document.getElementById('diffFileJumpSelect')?.addEventListener('change', (e) => {
    selectDiffFile(e.target.value, null);
  });

  document.getElementById('diffCopyPathBtn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(fileObj.filename);
    showToast(`Chemin copié : ${fileObj.filename}`);
  });

  document.getElementById('diffPrevHunkBtn')?.addEventListener('click', () => {
    jumpToRelativeHunk(-1);
  });

  document.getElementById('diffNextHunkBtn')?.addEventListener('click', () => {
    jumpToRelativeHunk(1);
  });

  document.getElementById('diffToggleFilesInlineBtn')?.addEventListener('click', () => {
    toggleFileTree();
  });

  document.getElementById('diffToggleFocusInlineBtn')?.addEventListener('click', () => {
    toggleZenMode();
  });

  document.getElementById('diffPrevFileBtn')?.addEventListener('click', () => {
    if (prevFile) selectDiffFile(prevFile.filename, null);
  });

  document.getElementById('diffNextFileBtn')?.addEventListener('click', () => {
    if (nextFile) selectDiffFile(nextFile.filename, null);
  });

  document.getElementById('diffOpenFullFileBtn')?.addEventListener('click', () => {
    if (state.focusDiffMode) setFocusDiffMode(false);
    navigateToCodeLocation(fileObj.filename, highlightLine, 'tree');
  });

  document.getElementById('diffOpenIdeBtn')?.addEventListener('click', () => {
    openCurrentPrInIde('phpstorm', fileObj.filename, highlightLine || 1);
  });

  viewerEl.querySelectorAll('.diff-copy-finding-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cid = btn.dataset.cid;
      const f = fileFindings.find((x) => x.cid === cid);
      if (f) {
        await navigator.clipboard.writeText(f.customComment);
        showToast(`Commentaire ${f.id} copié.`);
      }
    });
  });

  viewerEl.querySelectorAll('.diff-post-finding-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = btn.dataset.cid;
      const f = (state.currentReview?.findings || []).find((x) => x.cid === cid);
      if (f) openSingleCommentModal(f, 'inline');
    });
  });

  const scrollArea = document.getElementById('diffScrollArea');
  if (highlightLine) {
    const targetRow = viewerEl.querySelector(`[data-right-line="${highlightLine}"]`);
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else if (scrollArea) {
    scrollArea.scrollTop = 0;
  }

  // Automatically focus scroll area when in diff view so keyboard arrows/PageDown work immediately
  const activeTag = (document.activeElement?.tagName || '').toLowerCase();
  if (
    scrollArea &&
    (state.activeTab === 'diff' || state.focusDiffMode) &&
    activeTag !== 'input' &&
    activeTag !== 'textarea' &&
    activeTag !== 'select'
  ) {
    scrollArea.focus({ preventScroll: true });
  }
}

function selectRelativeDiffFile(delta) {
  const files = state.currentDiff?.files || [];
  if (files.length === 0) return false;
  const idx = files.findIndex((f) => f.filename === state.selectedDiffFile);
  const currentIdx = idx >= 0 ? idx : 0;
  const targetIdx = currentIdx + delta;
  if (targetIdx < 0 || targetIdx >= files.length) {
    showToast(delta < 0 ? 'Premier fichier du diff.' : 'Dernier fichier du diff.', 1400);
    return false;
  }
  const targetFile = files[targetIdx];
  selectDiffFile(targetFile.filename, null);
  if (state.activeTab === 'tree') {
    openFileInWorkingTree(targetFile.filename, null);
  }
  return true;
}

function jumpToRelativeHunk(delta) {
  const viewerEl = document.getElementById('diffViewerContainer');
  if (!viewerEl) return;
  const targets = Array.from(
    viewerEl.querySelectorAll('tr.diff-row-hunk, td.diff-inline-finding')
  );
  if (targets.length === 0) return;

  if (state.activeHunkIndex < 0) {
    state.activeHunkIndex = delta > 0 ? 0 : targets.length - 1;
  } else {
    state.activeHunkIndex = Math.max(
      0,
      Math.min(targets.length - 1, state.activeHunkIndex + delta)
    );
  }
  const target = targets[state.activeHunkIndex];
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderPatchTableRows(patch, fileFindings, highlightLine) {
  if (!patch) {
    return `<tr><td colspan="3" class="diff-line-code meta-text">Aucun diff textuel disponible pour ce fichier.</td></tr>`;
  }

  const lines = patch.split('\n');
  let leftLine = 0;
  let rightLine = 0;
  const rows = [];

  for (const rawLine of lines) {
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      leftLine = Number(hunkMatch[1]);
      rightLine = Number(hunkMatch[2]);
      rows.push(`
        <tr class="diff-row-hunk">
          <td class="diff-line-num">…</td>
          <td class="diff-line-num">…</td>
          <td class="diff-line-code">${escapeHtml(rawLine)}</td>
        </tr>
      `);
      continue;
    }

    let rowClass = '';
    let lNum = '';
    let rNum = '';

    if (rawLine.startsWith('+')) {
      rowClass = 'diff-row-add';
      rNum = rightLine++;
    } else if (rawLine.startsWith('-')) {
      rowClass = 'diff-row-del';
      lNum = leftLine++;
    } else {
      lNum = leftLine++;
      rNum = rightLine++;
    }

    const isHighlighted = highlightLine && rNum === highlightLine;
    if (isHighlighted) rowClass += ' diff-row-highlight';

    rows.push(`
      <tr class="${rowClass}" ${rNum ? `data-right-line="${rNum}"` : ''}>
        <td class="diff-line-num">${lNum}</td>
        <td class="diff-line-num">${rNum}</td>
        <td class="diff-line-code">${escapeHtml(rawLine)}</td>
      </tr>
    `);

    if (rNum) {
      const matchingFindings = fileFindings.filter((f) => Number(f.resolvedLine) === Number(rNum));
      for (const mf of matchingFindings) {
        const sev = getSeverityMeta(mf.severity);
        rows.push(`
          <tr>
            <td colspan="3" class="diff-inline-finding">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <span class="badge ${sev.badgeClass}">${escapeHtml(sev.label)}</span>
                  <strong style="font-size:12.5px;">${escapeHtml(mf.id)} — ${formatInlineCodeHtml(mf.title)}</strong>
                </div>
                <div style="display:flex;gap:6px;">
                  <button class="btn btn-secondary btn-sm diff-copy-finding-btn" data-cid="${escapeHtml(mf.cid)}">Copier</button>
                  <button class="btn btn-primary btn-sm diff-post-finding-btn" data-cid="${escapeHtml(mf.cid)}">Poster ici</button>
                </div>
              </div>
              <pre style="margin:0;white-space:pre-wrap;background:var(--bg-app);padding:10px;border-radius:4px;border:1px solid var(--border-color);font-size:11.5px;">${escapeHtml(mf.customComment)}</pre>
            </td>
          </tr>
        `);
      }
    }
  }

  return rows.join('');
}

function openFileInDiffViewer(rawFilePath, line = null) {
  const files = state.currentDiff?.files || [];
  if (files.length === 0) return;

  const cleanTarget = (rawFilePath || '').replace(/^\/+/, '');
  let match = files.find(
    (f) =>
      f.filename === cleanTarget ||
      f.filename.endsWith(cleanTarget) ||
      cleanTarget.endsWith(f.filename)
  );
  if (!match) {
    const base = cleanTarget.split('/').pop();
    match = files.find((f) => f.filename.endsWith('/' + base));
  }
  if (match) {
    selectDiffFile(match.filename, line);
  } else {
    // Automatically fallback to opening the file in the Working Tree explorer!
    showToast(`Fichier hors diff : ouverture dans l'Arbre de Travail.`);
    if (state.splitMode) setSplitRightPanel('tree');
    else switchTab('tree');
    openFileInWorkingTree(cleanTarget, line);
  }
}

// =============================================================================
// Working Tree Explorer (Zero-Disk Git Tree + Grep + Physical Worktree)
// =============================================================================
async function loadTreeDirectory(pr, dirPath = '') {
  const listEl = document.getElementById('treeEntriesList');
  if (!listEl || !pr) return;

  try {
    const res = await fetch(
      `/api/tree?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&path=${encodeURIComponent(dirPath)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Impossible de lire git ls-tree');
    if (state.selectedPrKey !== pr.key) return;

    state.treeDir = data.dirPath || '';
    state.treeEntries = data.entries || [];
    if (data.worktree) {
      state.worktreeStatus = data.worktree;
      renderWorktreeStatusBar(pr);
    }

    renderTreeBreadcrumbs(pr);
    renderTreeEntries(pr);
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state meta-text" style="padding:12px;">${escapeHtml(err.message)}</div>`;
  }
}

function renderTreeBreadcrumbs(pr) {
  const bcEl = document.getElementById('treeBreadcrumbs');
  if (!bcEl) return;
  const parts = state.treeDir ? state.treeDir.split('/').filter(Boolean) : [];
  const crumbs = [`<span class="tree-crumb" data-path="">${escapeHtml(pr.repo)}</span>`];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push(`<span>/</span><span class="tree-crumb" data-path="${escapeHtml(acc)}">${escapeHtml(part)}</span>`);
  }
  bcEl.innerHTML = crumbs.join(' ');
  bcEl.querySelectorAll('.tree-crumb').forEach((el) => {
    el.addEventListener('click', () => {
      loadTreeDirectory(pr, el.dataset.path);
    });
  });
}

function renderTreeEntries(pr) {
  const listEl = document.getElementById('treeEntriesList');
  if (!listEl) return;

  const items = [];
  if (state.treeDir) {
    const parentDir = state.treeDir.includes('/')
      ? state.treeDir.slice(0, state.treeDir.lastIndexOf('/'))
      : '';
    items.push(`
      <div class="tree-entry-item" data-type="tree" data-path="${escapeHtml(parentDir)}">
        <span>..</span>
        <span class="tree-entry-type">dir</span>
      </div>
    `);
  }

  for (const entry of state.treeEntries) {
    const isSelected = entry.path === state.selectedTreeFile;
    const label = entry.type === 'tree' ? `${entry.name}/` : entry.name;
    items.push(`
      <div class="tree-entry-item ${isSelected ? 'active' : ''}" data-type="${escapeHtml(entry.type)}" data-path="${escapeHtml(entry.path)}" title="${escapeHtml(entry.path)}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(label)}</span>
        <span class="tree-entry-type">${entry.type === 'tree' ? 'dir' : 'file'}</span>
      </div>
    `);
  }

  listEl.innerHTML = items.join('') || `<div class="empty-state meta-text">Dossier vide.</div>`;

  listEl.querySelectorAll('.tree-entry-item').forEach((el) => {
    el.addEventListener('click', () => {
      const t = el.dataset.type;
      const p = el.dataset.path;
      if (t === 'tree') {
        loadTreeDirectory(pr, p);
      } else {
        openFileInWorkingTree(p, null);
      }
    });
  });
}

async function openFileInWorkingTree(filePath, highlightLine = null) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr || !filePath) return;

  let cleanPath = String(filePath).replace(/^\/+/, '');
  const viewerEl = document.getElementById('treeViewerContainer');
  if (viewerEl) {
    viewerEl.innerHTML = `<div class="empty-state meta-text">Chargement de ${escapeHtml(cleanPath)}...</div>`;
  }

  try {
    let res = await fetch(
      `/api/blob?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&path=${encodeURIComponent(cleanPath)}`
    );

    if (!res.ok) {
      // Try resolving suffix via recursive file list
      if (!state.allRepoFiles) {
        const treeRes = await fetch(
          `/api/tree?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&recursive=1`
        );
        if (treeRes.ok) {
          const treeData = await treeRes.json();
          state.allRepoFiles = treeData.files || [];
        }
      }
      const match = (state.allRepoFiles || []).find(
        (f) => f === cleanPath || f.endsWith('/' + cleanPath) || f.endsWith(cleanPath)
      );
      if (match) {
        cleanPath = match;
        res = await fetch(
          `/api/blob?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&path=${encodeURIComponent(cleanPath)}`
        );
      }
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fichier introuvable dans cet arbre');

    state.selectedTreeFile = cleanPath;
    state.selectedTreeLine = highlightLine;

    // Sync directory sidebar to the file's parent folder
    const parentDir = cleanPath.includes('/') ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) : '';
    if (parentDir !== state.treeDir) {
      loadTreeDirectory(pr, parentDir);
    } else {
      renderTreeEntries(pr);
    }

    const lines = String(data.content || '').split('\n');
    const rowsHtml = lines
      .map((lineText, idx) => {
        const lineNum = idx + 1;
        const isHl = highlightLine && Number(highlightLine) === lineNum;
        return `
          <tr class="${isHl ? 'diff-row-highlight' : ''}" data-blob-line="${lineNum}">
            <td class="blob-line-num">${lineNum}</td>
            <td class="blob-line-code">${escapeHtml(lineText)}</td>
          </tr>
        `;
      })
      .join('');

    viewerEl.innerHTML = `
      <div class="diff-file-header">
        <div style="display:flex;gap:8px;align-items:center;min-width:0;">
          <button id="blobBackToDiffBtn" class="btn btn-secondary btn-xs" title="Retourner au Diff Git (raccourci : t)">&larr; Diff</button>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(cleanPath)} <span class="meta-text">(${lines.length} lignes)</span></span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <div class="diff-zoom-group" title="Zoomer / Dézoomer dans le code (raccourcis : - / + / 0)">
            <button id="blobZoomOutBtn" class="btn btn-xs" title="Dézoomer (-)">&minus;</button>
            <button id="blobZoomResetBtn" class="btn btn-xs diff-zoom-label" title="Réinitialiser le zoom à 100% (0)">${state.diffZoom}%</button>
            <button id="blobZoomInBtn" class="btn btn-xs" title="Zoomer (+)">+</button>
          </div>
          <button id="blobOpenPhpstormBtn" class="btn btn-ghost btn-xs" title="Ouvrir dans PhpStorm (raccourci : i)">PhpStorm</button>
          <button id="blobOpenVscodeBtn" class="btn btn-ghost btn-xs">VS Code</button>
        </div>
      </div>
      <div id="treeScrollArea" class="diff-scroll-area" tabindex="0">
        <div class="diff-table-wrapper">
          <table class="blob-table">
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('blobZoomOutBtn')?.addEventListener('click', () => {
      adjustDiffZoom(-1);
    });
    document.getElementById('blobZoomResetBtn')?.addEventListener('click', () => {
      applyDiffZoomVariables(100);
    });
    document.getElementById('blobZoomInBtn')?.addEventListener('click', () => {
      adjustDiffZoom(1);
    });

    document.getElementById('blobBackToDiffBtn')?.addEventListener('click', () => {
      navigateToCodeLocation(cleanPath, highlightLine, 'diff');
    });
    document.getElementById('blobOpenPhpstormBtn')?.addEventListener('click', () => {
      openCurrentPrInIde('phpstorm', cleanPath, highlightLine || 1);
    });
    document.getElementById('blobOpenVscodeBtn')?.addEventListener('click', () => {
      openCurrentPrInIde('code', cleanPath, highlightLine || 1);
    });

    const treeScroll = document.getElementById('treeScrollArea');
    if (highlightLine) {
      const targetRow = viewerEl.querySelector(`[data-blob-line="${highlightLine}"]`);
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (treeScroll) {
      treeScroll.scrollTop = 0;
    }
    if (treeScroll && state.activeTab === 'tree') {
      treeScroll.focus({ preventScroll: true });
    }
  } catch (err) {
    if (viewerEl) {
      viewerEl.innerHTML = `<div class="empty-state meta-text">${escapeHtml(err.message)}</div>`;
    }
  }
}

// Fuzzy file search in Working Tree
document.getElementById('treeFileFilterInput')?.addEventListener('input', async (e) => {
  const q = e.target.value.trim().toLowerCase();
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;

  if (!q) {
    renderTreeEntries(pr);
    return;
  }

  if (!state.allRepoFiles) {
    const res = await fetch(
      `/api/tree?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&recursive=1`
    );
    if (res.ok) {
      const data = await res.json();
      state.allRepoFiles = data.files || [];
    }
  }

  const matches = (state.allRepoFiles || []).filter((f) => f.toLowerCase().includes(q)).slice(0, 80);
  const listEl = document.getElementById('treeEntriesList');
  listEl.innerHTML =
    matches
      .map(
        (m) => `
      <div class="tree-entry-item" data-path="${escapeHtml(m)}" title="${escapeHtml(m)}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.replace(/^projects\/services\//, ''))}</span>
        <span class="tree-entry-type">match</span>
      </div>
    `
      )
      .join('') || `<div class="empty-state meta-text">Aucun fichier correspondant.</div>`;

  listEl.querySelectorAll('.tree-entry-item').forEach((el) => {
    el.addEventListener('click', () => {
      openFileInWorkingTree(el.dataset.path, null);
    });
  });
});

// Git Grep in Working Tree
document.getElementById('treeGrepForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('treeGrepInput')?.value.trim();
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr || !q) return;

  const viewerEl = document.getElementById('treeViewerContainer');
  viewerEl.innerHTML = `<div class="empty-state meta-text">Recherche git grep "${escapeHtml(q)}"...</div>`;

  try {
    const res = await fetch(
      `/api/grep?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&q=${encodeURIComponent(q)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur git grep');

    const matches = data.matches || [];
    if (matches.length === 0) {
      viewerEl.innerHTML = `<div class="empty-state meta-text">Aucun résultat pour "${escapeHtml(q)}".</div>`;
      return;
    }

    viewerEl.innerHTML = `
      <div class="diff-file-header">
        <span>Résultats git grep pour "${escapeHtml(q)}" (${matches.length})</span>
      </div>
      <div class="diff-scroll-area" tabindex="0">
        <div class="diff-table-wrapper">
          <table class="blob-table">
            <tbody>
              ${matches
                .map(
                  (m) => `
                <tr class="grep-result-row" data-path="${escapeHtml(m.filePath)}" data-line="${m.line}" style="cursor:pointer;">
                  <td class="blob-line-num" style="width:auto;text-align:left;color:var(--accent);">${escapeHtml(m.filePath.replace(/^projects\/services\//, ''))}:${m.line}</td>
                  <td class="blob-line-code">${escapeHtml(m.text)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    viewerEl.querySelectorAll('.grep-result-row').forEach((row) => {
      row.addEventListener('click', () => {
        openFileInWorkingTree(row.dataset.path, Number(row.dataset.line) || 1);
      });
    });
  } catch (err) {
    viewerEl.innerHTML = `<div class="empty-state meta-text">${escapeHtml(err.message)}</div>`;
  }
});

// Mount / Unmount Worktree & Open IDE
document.getElementById('mountWorktreeBtn')?.addEventListener('click', async () => {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;
  showToast(`Montage du worktree pour ${pr.key}...`);
  try {
    const res = await fetch('/api/worktree/mount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: pr.repo, number: pr.number, headSha: pr.headRefOid }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur montage worktree');
    state.worktreeStatus = data;
    pr.worktreeMounted = true;
    pr.worktreePath = data.worktreePath;
    renderWorktreeStatusBar(pr);
    renderPrList();
    showToast(`Worktree prêt : ${data.worktreePath}`);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 5000);
  }
});

document.getElementById('unmountWorktreeBtn')?.addEventListener('click', async () => {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;
  try {
    const res = await fetch('/api/worktree/unmount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: pr.repo, number: pr.number }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur suppression worktree');
    state.worktreeStatus = data;
    pr.worktreeMounted = false;
    pr.worktreePath = null;
    renderWorktreeStatusBar(pr);
    renderPrList();
    showToast(`Worktree démonté.`);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 5000);
  }
});

async function openCurrentPrInIde(ide, filePath = '', line = null) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;
  showToast(`Ouverture dans ${ide === 'code' ? 'VS Code' : 'PhpStorm'} (montage worktree)...`);
  try {
    const res = await fetch('/api/worktree/open-ide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headRefOid,
        ide,
        filePath: filePath || state.selectedTreeFile || state.selectedDiffFile || '',
        line: line || state.selectedTreeLine || state.highlightedLine || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur ouverture IDE');
    state.worktreeStatus = { mounted: true, worktreePath: data.worktreePath };
    pr.worktreeMounted = true;
    renderWorktreeStatusBar(pr);
    renderPrList();
    showToast(`Ouvert dans ${ide} : ${data.worktreePath}`);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 5000);
  }
}

document.getElementById('openPhpstormBtn')?.addEventListener('click', () => {
  openCurrentPrInIde('phpstorm');
});

document.getElementById('openVscodeBtn')?.addEventListener('click', () => {
  openCurrentPrInIde('code');
});

// =============================================================================
// Split-Screen, Pop-out Window & BroadcastChannel Sync
// =============================================================================
function switchTab(tabName, options = {}) {
  if (!options.keepFocusDiff && state.focusDiffMode && tabName !== 'diff') {
    setFocusDiffMode(false);
  }
  state.activeTab = tabName;
  state.activeFindingIndex = -1;
  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  if (state.splitMode && (tabName === 'diff' || tabName === 'tree')) {
    setSplitRightPanel(tabName);
  }
  if (tabName === 'rules') {
    loadRules();
  }
  if (tabName === 'diff') {
    setTimeout(() => {
      document.getElementById('diffScrollArea')?.focus({ preventScroll: true });
    }, 0);
  } else if (tabName === 'tree') {
    setTimeout(() => {
      document.getElementById('treeScrollArea')?.focus({ preventScroll: true });
    }, 0);
  }
}

function setSplitRightPanel(rightTab = 'diff') {
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('split-right-active', panel.id === `tab-${rightTab}`);
  });
}

function toggleSplitMode() {
  state.splitMode = !state.splitMode;
  const container = document.getElementById('panelsContainer');
  const btn = document.getElementById('toggleSplitViewBtn');
  if (state.splitMode) {
    container?.classList.add('split-mode');
    btn?.classList.add('btn-primary');
    setSplitRightPanel(state.activeTab === 'tree' ? 'tree' : 'diff');
  } else {
    container?.classList.remove('split-mode');
    btn?.classList.remove('btn-primary');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('split-right-active'));
  }
}

document.getElementById('toggleSplitViewBtn')?.addEventListener('click', toggleSplitMode);

function openPopoutWorkspace() {
  if (!state.selectedPrKey) return;
  const targetTab = state.activeTab === 'tree' ? 'tree' : 'diff';
  const url = `/?pr=${encodeURIComponent(state.selectedPrKey)}&tab=${targetTab}&popout=1`;
  window.open(url, 'pr-review-hub-popout', 'width=1440,height=920,resizable=yes,scrollbars=yes');
}

document.getElementById('popoutWorkspaceBtn')?.addEventListener('click', openPopoutWorkspace);

if (syncChannel) {
  syncChannel.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'SELECT_PR' && msg.prKey && msg.prKey !== state.selectedPrKey) {
      await selectPr(msg.prKey, false);
    }
    if (msg.type === 'OPEN_FILE' && isPopoutWindow) {
      if (msg.prKey && msg.prKey !== state.selectedPrKey) {
        await selectPr(msg.prKey, false);
      }
      if (msg.view === 'tree') {
        switchTab('tree');
        openFileInWorkingTree(msg.filePath, msg.line);
      } else {
        switchTab('diff');
        openFileInDiffViewer(msg.filePath, msg.line);
      }
    }
  });
}

// =============================================================================
// Manual Review Trigger, Agent Q&A & Mode 2 Debrief
// =============================================================================
async function triggerManualReviewForKey(prKey) {
  if (!prKey) return;
  try {
    const res = await fetch('/api/agent/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: prKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Impossible de lancer la review');
    showToast(`Audit IA lancé pour ${prKey}...`);
    await loadState(true);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 4500);
  }
}

document.getElementById('triggerReviewBtn')?.addEventListener('click', () => {
  if (state.selectedPrKey) triggerManualReviewForKey(state.selectedPrKey);
});

document.getElementById('reviewAllPendingBtn')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/agent/review-all-pending', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lancement groupé');
    showToast(`${data.count || 0} audit(s) IA lancé(s) en arrière-plan.`);
    await loadState(true);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 4500);
  }
});

function toggleChatDrawer(forceState = null) {
  state.chatOpen = typeof forceState === 'boolean' ? forceState : !state.chatOpen;
  const drawer = document.getElementById('agentChatDrawer');
  const btn = document.getElementById('toggleChatDrawerBtn');
  if (state.chatOpen) {
    drawer?.classList.remove('hidden');
    btn?.classList.add('btn-primary');
    const pr = state.prs.find((p) => p.key === state.selectedPrKey);
    if (pr) loadChatForCurrentPr(pr);
    document.getElementById('agentChatInput')?.focus();
  } else {
    drawer?.classList.add('hidden');
    btn?.classList.remove('btn-primary');
  }
}

document.getElementById('toggleChatDrawerBtn')?.addEventListener('click', () => toggleChatDrawer());
document.getElementById('closeChatDrawerBtn')?.addEventListener('click', () => toggleChatDrawer(false));

function openChatWithFindingContext(finding) {
  state.chatFindingContext = finding;
  const banner = document.getElementById('agentFindingContextBanner');
  const textEl = document.getElementById('agentFindingContextText');
  if (banner && textEl) {
    textEl.textContent = `Cible : ${finding.id} — ${stripEmojis(finding.title)}`;
    banner.classList.remove('hidden');
  }
  toggleChatDrawer(true);
}

document.getElementById('clearFindingContextBtn')?.addEventListener('click', () => {
  state.chatFindingContext = null;
  document.getElementById('agentFindingContextBanner')?.classList.add('hidden');
});

async function loadChatForCurrentPr(pr) {
  const res = await fetch(
    `/api/agent/chat?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}`
  );
  if (!res.ok) return;
  const data = await res.json();
  state.chatMessages = data.messages || [];
  renderChatMessages();
}

function renderChatMessages() {
  const container = document.getElementById('agentChatMessages');
  if (!container) return;
  if (!state.chatMessages || state.chatMessages.length === 0) {
    container.innerHTML = `<div class="empty-state meta-text">Pose une question technique sur la PR ou débrieffe un finding avec l'agent.</div>`;
    return;
  }

  container.innerHTML = state.chatMessages
    .map((m) => {
      const reviewerLabel = state.config?.githubUser || 'Reviewer';
      const roleLabel = m.role === 'user' ? reviewerLabel : 'Agent my-review';
      const findingTag = m.findingId ? ` · ${m.findingId}` : '';
      return `
        <div class="chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}">
          <div class="chat-bubble-meta">${escapeHtml(roleLabel + findingTag)}</div>
          <div>${escapeHtml(stripEmojis(m.text))}</div>
        </div>
      `;
    })
    .join('');

  container.scrollTop = container.scrollHeight;
}

document.getElementById('agentChatForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  const input = document.getElementById('agentChatInput');
  const sendBtn = document.getElementById('agentSendBtn');
  const debriefChecked = document.getElementById('agentDebriefModeCheckbox')?.checked;
  if (!pr || !input) return;

  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  sendBtn.disabled = true;
  sendBtn.textContent = '...';

  state.chatMessages.push({
    role: 'user',
    text: message,
    findingId: state.chatFindingContext?.id || null,
  });
  renderChatMessages();

  try {
    const res = await fetch('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: pr.repo,
        number: pr.number,
        message,
        findingContext: state.chatFindingContext,
        action: debriefChecked ? 'debrief' : 'ask',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur communication agent');
    state.chatMessages = data.messages || [];
    renderChatMessages();
  } catch (err) {
    showToast(`Erreur Agent: ${err.message}`, 5000);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Envoyer';
  }
});

async function promptDismissFinding(finding) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = `Marquer ${finding.id} comme Faux Positif (Mode 2 Debrief)`;
  confirmBtn.textContent = 'Enregistrer dans false-positives.md';

  bodyEl.innerHTML = `
    <div>
      <p style="margin:0 0 8px;">
        Ce finding sera barré dans l'interface et la règle sera ajoutée à <code>references/false-positives.md</code> pour que l'agent ne le signale plus à l'avenir.
      </p>
      <label style="display:block;font-weight:500;margin-bottom:6px;">Raison / Règle métier (optionnel) :</label>
      <textarea id="modalDismissReasonInput" class="finding-textarea" style="min-height:90px;" placeholder="Ex: Géré en amont par le voter / Convention habituelle sur ce micro-service..."></textarea>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const reason = document.getElementById('modalDismissReasonInput').value.trim();
    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/agent/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: pr.repo,
          number: pr.number,
          finding,
          reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur enregistrement faux positif');
      finding.dismissed = true;
      state.selectedCommentCids.delete(finding.cid);
      modal.classList.add('hidden');
      renderReportFindingsQuickBar();
      renderFindingsTab();
      renderDiffTree();
      loadRules();
      showToast(`${finding.id} ajouté aux faux positifs.`);
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmer';
    }
  };
}

async function promptAddRuleFromFinding(finding) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (state.dnaSections.length === 0) {
    await loadRules();
  }

  const defaultSections =
    state.dnaSections.length > 0
      ? state.dnaSections
      : [
          '1. Architecture, Serialization & Clean Code',
          '2. Multi-Tenant, Security & Voter Isolation (Critical)',
          '3. Database, Migrations & Performance',
          '4. PHP 8.2+ & Symfony Idioms',
          '5. Testing Standards (PHPUnit & Behat)',
          '6. Naming, Typos & Boy Scout Hygiene',
        ];

  const cleanTitle = stripEmojis(finding.title || 'New Engineering Rule');
  const suggestedBody = (finding.customComment || finding.comment || '').trim();

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = `Ajouter une Règle Agent depuis ${finding.id}`;
  confirmBtn.textContent = 'Ajouter à reviewer-dna.md';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <p class="meta-text" style="margin:0;">
        Extrait ce finding en règle permanente (en anglais) dans <code>references/reviewer-dna.md</code> pour les prochains audits.
      </p>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Section DNA :</label>
        <select id="modalRuleSectionSelect" class="search-input">
          ${defaultSections.map((sec) => `<option value="${escapeHtml(sec)}">${escapeHtml(sec)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Titre de la règle (Anglais) :</label>
        <input type="text" id="modalRuleTitleInput" class="search-input" value="${escapeHtml(cleanTitle)}" />
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Description / Consigne pour l'agent (Anglais) :</label>
        <textarea id="modalRuleBodyInput" class="finding-textarea" style="min-height:110px;">${escapeHtml(suggestedBody)}</textarea>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const section = document.getElementById('modalRuleSectionSelect').value.trim();
    const title = document.getElementById('modalRuleTitleInput').value.trim();
    const body = document.getElementById('modalRuleBodyInput').value.trim();
    if (!title || !body) {
      showToast('Titre et description requis.');
      return;
    }

    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'dna',
          section,
          title,
          body,
          source: pr ? `${pr.repo}#${pr.number} (${finding.id})` : finding.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur ajout de règle');
      modal.classList.add('hidden');
      await loadRules();
      showToast(`Règle "${title}" ajoutée à reviewer-dna.md.`);
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmer';
    }
  };
}

// =============================================================================
// Modals for explicit GitHub publishing
// =============================================================================
function openSingleCommentModal(finding, mode) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent =
    mode === 'inline'
      ? `Publier le commentaire inline ${finding.id} (${pr.repo}#${pr.number})`
      : `Publier un commentaire général (${pr.repo}#${pr.number})`;
  confirmBtn.textContent = 'Confirmer';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <p style="margin:0;">
        <strong>Cible :</strong>
        <code>${escapeHtml(mode === 'inline' ? `${finding.filePath}:${finding.endLine || finding.startLine || 1}` : 'Conversation générale de la PR')}</code>
      </p>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:6px;">Contenu Markdown :</label>
        <textarea id="modalCommentTextarea" class="finding-textarea" style="min-height:150px;">${escapeHtml(finding.customComment)}</textarea>
      </div>
      <label class="checkbox-label" style="margin-top:4px;">
        <input type="checkbox" id="modalSaveAsAgentRuleCb" />
        <span>Enregistrer également ce point comme règle permanente dans <code>reviewer-dna.md</code></span>
      </label>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const editedBody = document.getElementById('modalCommentTextarea').value.trim();
    const saveAsRule = document.getElementById('modalSaveAsAgentRuleCb')?.checked;
    if (!editedBody) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Envoi...';

    try {
      const res = await fetch('/api/github/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headRefOid || pr.lastReviewedSha,
          commentBody: editedBody,
          filePath: finding.filePath,
          line: finding.endLine || finding.startLine || 1,
          mode,
          cid: finding.cid,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec de publication GitHub');

      if (saveAsRule) {
        await fetch('/api/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: 'dna',
            section: '1. Architecture, Serialization & Clean Code',
            title: stripEmojis(finding.title || 'Review Rule'),
            body: editedBody,
            source: `${pr.repo}#${pr.number} (${finding.id})`,
          }),
        });
        await loadRules();
      }

      finding.posted = true;
      finding.customComment = editedBody;
      modal.classList.add('hidden');
      renderFindingsTab();
      loadState(true);
      showToast(
        saveAsRule
          ? `Commentaire ${finding.id} publié et règle ajoutée à reviewer-dna.md.`
          : `Commentaire ${finding.id} publié sur GitHub.`
      );
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 5000);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmer';
    }
  };
}

function openBatchReviewModal(defaultEvent = 'PENDING') {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;

  const findings = state.currentReview?.findings || [];
  const selectedFindings = findings.filter((f) => state.selectedCommentCids.has(f.cid) && !f.dismissed);

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = `Publier Review — ${pr.repo}#${pr.number}`;
  confirmBtn.textContent = 'Confirmer';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div>
        <label style="display:block;font-weight:500;margin-bottom:6px;">Type d'action GitHub :</label>
        <select id="modalReviewEventSelect" class="search-input">
          <option value="PENDING" ${defaultEvent === 'PENDING' ? 'selected' : ''}>PENDING — Créer un brouillon de review sur GitHub (non soumis)</option>
          <option value="APPROVE" ${defaultEvent === 'APPROVE' ? 'selected' : ''}>APPROVE — Approuver la PR</option>
          <option value="COMMENT" ${defaultEvent === 'COMMENT' ? 'selected' : ''}>COMMENT — Publier les commentaires sans bloquer</option>
          <option value="REQUEST_CHANGES" ${defaultEvent === 'REQUEST_CHANGES' ? 'selected' : ''}>REQUEST_CHANGES — Demander des modifications</option>
        </select>
      </div>

      <div>
        <label style="display:block;font-weight:500;margin-bottom:6px;">Message général (optionnel) :</label>
        <textarea id="modalReviewSummaryInput" class="finding-textarea" style="min-height:80px;" placeholder="LGTM / Quelques remarques ci-dessous..."></textarea>
      </div>

      <div>
        <label class="checkbox-label">
          <input type="checkbox" id="modalIncludeSelectedComments" ${selectedFindings.length > 0 ? 'checked' : ''} />
          <span>Inclure les <strong>${selectedFindings.length} commentaire(s) sélectionné(s)</strong></span>
        </label>
        ${
          selectedFindings.length > 0
            ? `<ul style="margin:6px 0 0;padding-left:20px;color:var(--text-secondary);font-size:11.5px;">
                ${selectedFindings.map((f) => `<li><strong>${escapeHtml(f.id)}</strong> — ${escapeHtml(stripEmojis(f.title))} (${escapeHtml(f.filePath || 'Général')})</li>`).join('')}
              </ul>`
            : `<p class="meta-text" style="margin:4px 0 0;">Aucun commentaire coché (seul le verdict/message général sera envoyé).</p>`
        }
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const event = document.getElementById('modalReviewEventSelect').value;
    const summaryBody = document.getElementById('modalReviewSummaryInput').value.trim();
    const includeComments = document.getElementById('modalIncludeSelectedComments').checked;

    const inlineComments = includeComments
      ? selectedFindings.map((f) => ({
          cid: f.cid,
          filePath: f.filePath,
          line: f.endLine || f.startLine || 1,
          body: f.customComment,
        }))
      : [];

    if (event === 'PENDING' && inlineComments.length === 0 && !summaryBody) {
      showToast('Sélectionne au moins un commentaire ou saisis un message.');
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Envoi...';

    try {
      const res = await fetch('/api/github/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headRefOid || pr.lastReviewedSha,
          event,
          summaryBody,
          inlineComments,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec lors de la création de la review GitHub');

      for (const f of selectedFindings) {
        if (includeComments) f.posted = true;
      }
      modal.classList.add('hidden');
      renderFindingsTab();
      loadState(true);
      showToast(
        event === 'PENDING'
          ? 'Pending Review (brouillon) créée sur GitHub.'
          : `Review (${event}) publiée sur GitHub.`
      );
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 5000);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmer';
    }
  };
}

// Event Listeners Setup
document.getElementById('modeFilterTabs')?.querySelectorAll('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.activeFilter = tab.dataset.filter;
    renderPrList();
  });
});

document.getElementById('clearAuthorFilterBtn')?.addEventListener('click', () => {
  state.activeAuthor = null;
  renderAuthorFilterBar();
  renderPrList();
});

document.getElementById('searchInput')?.addEventListener('input', (e) => {
  state.searchQuery = e.target.value.trim();
  renderPrList();
});

document.querySelectorAll('.view-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.tab);
  });
});

document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
});

document.getElementById('syncQueueBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('syncQueueBtn');
  const spinner = document.getElementById('syncSpinner');
  btn.disabled = true;
  spinner.classList.remove('hidden');
  showToast('Synchronisation GitHub en cours...');

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur sync-queue.sh');
    await loadState(true);
    const actionableCount = data.scanResult?.actionable?.length || 0;
    showToast(`Queue synchronisée (${actionableCount} PR à traiter).`);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 4500);
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
});

document.getElementById('selectAllCommentsCheckbox')?.addEventListener('change', (e) => {
  const findings = state.currentReview?.findings || [];
  if (e.target.checked) {
    findings.filter((f) => !f.dismissed).forEach((f) => state.selectedCommentCids.add(f.cid));
  } else {
    state.selectedCommentCids.clear();
  }
  renderFindingsTab();
});

document.getElementById('copyAllSelectedBtn')?.addEventListener('click', async () => {
  const findings = (state.currentReview?.findings || []).filter(
    (f) => state.selectedCommentCids.has(f.cid) && !f.dismissed
  );
  if (findings.length === 0) {
    showToast('Aucun commentaire sélectionné.');
    return;
  }
  const combined = findings
    .map((f) => `### ${f.id} — ${stripEmojis(f.title)}${f.filePath ? ` (\`${f.filePath}\`)` : ''}\n\n${f.customComment}`)
    .join('\n\n---\n\n');
  await navigator.clipboard.writeText(combined);
  showToast(`${findings.length} commentaire(s) copié(s).`);
});

document.getElementById('createPendingReviewBtn')?.addEventListener('click', () => {
  openBatchReviewModal('PENDING');
});

document.getElementById('openBatchReviewModalBtn')?.addEventListener('click', () => {
  openBatchReviewModal('APPROVE');
});

async function openSettingsModal() {
  const cfg = state.config || {};
  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = 'Configuration PR Review Hub (Multi-Team & Multi-Account)';
  confirmBtn.textContent = 'Enregistrer';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Utilisateur GitHub :</label>
          <input type="text" id="cfgGithubUser" class="search-input" value="${escapeHtml(cfg.githubUser || '')}" placeholder="Auto-détecté via gh auth" />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Organisation GitHub :</label>
          <input type="text" id="cfgGithubOrg" class="search-input" value="${escapeHtml(cfg.githubOrg || 'ubitransports')}" />
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <label style="font-weight:500;">Équipes GitHub suivies :</label>
          <button type="button" id="cfgDiscoverTeamsBtn" class="btn btn-ghost btn-xs">Détecter mes équipes GitHub</button>
        </div>
        <div id="cfgDiscoveredTeamsBox" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;"></div>
        <input type="text" id="cfgGithubTeams" class="search-input" value="${escapeHtml((cfg.githubTeams || []).join(', '))}" placeholder="Ex: ubi-eng-team-popcorn, popcorn-back" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Workspace local des dépôts (projectsDir) :</label>
          <input type="text" id="cfgProjectsDir" class="search-input" value="${escapeHtml(cfg.projectsDir || '')}" />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Dossier local des reviews (reviewsDir) :</label>
          <input type="text" id="cfgReviewsDir" class="search-input" value="${escapeHtml(cfg.reviewsDir || '')}" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">URL de base Jira :</label>
          <input type="text" id="cfgJiraBaseUrl" class="search-input" value="${escapeHtml(cfg.jiraBaseUrl || 'https://ubitransport.atlassian.net/browse')}" />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Préfixes Jira :</label>
          <input type="text" id="cfgJiraPrefixes" class="search-input" value="${escapeHtml((cfg.jiraPrefixes || ['PRD', 'HYB', 'WAN', 'POP', 'OPS', 'SEC']).join(', '))}" />
        </div>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  const renderDiscoveredTeamPills = async () => {
    const box = document.getElementById('cfgDiscoveredTeamsBox');
    const orgVal = document.getElementById('cfgGithubOrg')?.value.trim() || cfg.githubOrg || '';
    const teamsInput = document.getElementById('cfgGithubTeams');
    if (!box || !teamsInput) return;
    box.innerHTML = `<span class="meta-text">Recherche des équipes GitHub...</span>`;
    try {
      const res = await fetch(`/api/github/teams?org=${encodeURIComponent(orgVal)}`);
      if (!res.ok) throw new Error('Indisponible');
      const data = await res.json();
      if (data.githubUser && !document.getElementById('cfgGithubUser').value.trim()) {
        document.getElementById('cfgGithubUser').value = data.githubUser;
      }
      const teams = data.teams || [];
      if (teams.length === 0) {
        box.innerHTML = `<span class="meta-text">Aucune équipe détectée automatiquement pour cette organisation.</span>`;
        return;
      }
      const currentSet = new Set(
        teamsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      box.innerHTML = teams
        .map((t) => {
          const checked = currentSet.has(t.slug) || currentSet.has(t.combinedSlug);
          return `
            <label class="checkbox-label" style="background:var(--bg-elevated);padding:3px 8px;border-radius:4px;border:1px solid var(--border-color);font-size:11.5px;">
              <input type="checkbox" class="cfg-team-cb" value="${escapeHtml(t.slug)}" ${checked ? 'checked' : ''} />
              <span>${escapeHtml(t.slug)}</span>
            </label>
          `;
        })
        .join('');

      box.querySelectorAll('.cfg-team-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
          const selected = Array.from(box.querySelectorAll('.cfg-team-cb:checked')).map((el) => el.value);
          teamsInput.value = selected.join(', ');
        });
      });
    } catch {
      box.innerHTML = '';
    }
  };

  document.getElementById('cfgDiscoverTeamsBtn')?.addEventListener('click', renderDiscoveredTeamPills);
  renderDiscoveredTeamPills();

  confirmBtn.onclick = async () => {
    const githubUser = document.getElementById('cfgGithubUser').value.trim();
    const githubOrg = document.getElementById('cfgGithubOrg').value.trim();
    const githubTeams = document
      .getElementById('cfgGithubTeams')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const projectsDir = document.getElementById('cfgProjectsDir').value.trim();
    const reviewsDir = document.getElementById('cfgReviewsDir').value.trim();
    const jiraBaseUrl = document.getElementById('cfgJiraBaseUrl').value.trim();
    const jiraPrefixes = document
      .getElementById('cfgJiraPrefixes')
      .value.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubUser,
          githubOrg,
          githubTeams,
          projectsDir,
          reviewsDir,
          jiraBaseUrl,
          jiraPrefixes,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur sauvegarde configuration');
      state.config = data.config;
      modal.classList.add('hidden');
      await loadState(true);
      showToast('Configuration sauvegardée.');
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmer';
    }
  };
}

document.getElementById('settingsBtn')?.addEventListener('click', openSettingsModal);

document.getElementById('closeModalBtn')?.addEventListener('click', () => {
  document.getElementById('githubModal').classList.add('hidden');
});

document.getElementById('cancelModalBtn')?.addEventListener('click', () => {
  document.getElementById('githubModal').classList.add('hidden');
});

// =============================================================================
// Tab 5: Agent Rules Manager (3-Tier Rules + 1-Year Team PR Onboarding Queue)
// =============================================================================
async function loadRules() {
  try {
    const res = await fetch('/api/rules');
    if (!res.ok) return;
    const data = await res.json();
    state.rules = data.rules || [];
    state.candidateRules = data.candidates || [];
    state.commonSections = data.commonSections || [];
    state.dnaSections = data.dnaSections || [];
    state.fpSections = data.fpSections || [];

    const countEl = document.getElementById('tabRulesCount');
    if (countEl) countEl.textContent = String(state.rules.length + state.candidateRules.length);

    const candCountEl = document.getElementById('rulesCandidateCount');
    if (candCountEl) candCountEl.textContent = String(state.candidateRules.length);

    const commonCountEl = document.getElementById('rulesCommonCount');
    if (commonCountEl) {
      commonCountEl.textContent = String(state.rules.filter((r) => r.target === 'common').length);
    }

    const dnaCountEl = document.getElementById('rulesDnaCount');
    if (dnaCountEl) {
      dnaCountEl.textContent = String(state.rules.filter((r) => r.target === 'dna').length);
    }

    const fpCountEl = document.getElementById('rulesFpCount');
    if (fpCountEl) {
      fpCountEl.textContent = String(state.rules.filter((r) => r.target === 'false-positive').length);
    }

    renderRulesTab();
  } catch {
    // Ignore transient network errors
  }
}

function renderRulesTab() {
  const listEl = document.getElementById('rulesListContainer');
  if (!listEl) return;

  const q = (state.rulesSearch || '').toLowerCase();

  const candidateItems = (state.candidateRules || []).map((c) => ({
    ...c,
    target: 'candidate',
    startLine: null,
  }));

  const allItems =
    state.rulesFilter === 'candidate'
      ? candidateItems
      : state.rulesFilter === 'all'
      ? [...candidateItems, ...(state.rules || [])]
      : (state.rules || []).filter((r) => r.target === state.rulesFilter);

  const filtered = allItems.filter((r) => {
    if (q) {
      const hay = `${r.title} ${r.body} ${r.section}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    const emptyHint =
      state.rulesFilter === 'candidate'
        ? `Aucune règle candidate en attente de validation. Clique sur "Analyser PRs Équipe (1 an)" pour extraire les conventions de review des 365 derniers jours.`
        : `Aucune règle ne correspond aux critères.`;
    listEl.innerHTML = `<div class="empty-card" style="margin:24px auto;"><p>${escapeHtml(emptyHint)}</p></div>`;
    return;
  }

  const candidateBannerHtml =
    candidateItems.length > 0 && (state.rulesFilter === 'candidate' || state.rulesFilter === 'all')
      ? `
      <div class="rule-card" style="border-left:3px solid var(--accent);background:var(--bg-elevated);margin-bottom:8px;">
        <div class="rule-card-header">
          <div class="rule-card-title-group">
            <span class="badge badge-severity-question">ONBOARDING ÉQUIPE (1 AN)</span>
            <span class="rule-card-title">${candidateItems.length} règle(s) candidate(s) synthétisée(s) depuis l'historique GitHub — Validation requise avant activation</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button id="approveAllCandidatesLocalBtn" class="btn btn-primary btn-xs">Tout valider (ADN Local)</button>
          </div>
        </div>
      </div>
    `
      : '';

  const cardsHtml = filtered
    .map((r, idx) => {
      if (r.target === 'candidate') {
        const samplesHtml =
          Array.isArray(r.samples) && r.samples.length > 0
            ? `<div class="meta-text" style="margin-top:6px;">Exemples détectés (${r.occurrences || r.samples.length} occurrences) : ${r.samples
                .map((s) => `<code>${escapeHtml(s.pr)}</code> (@${escapeHtml(s.reviewer)})`)
                .join(' · ')}</div>`
            : '';
        return `
          <div class="rule-card" style="border-left:3px solid var(--accent);" data-idx="${idx}">
            <div class="rule-card-header">
              <div class="rule-card-title-group">
                <span class="badge badge-severity-question">CANDIDATE À VALIDER</span>
                <span class="rule-section-pill">${escapeHtml(r.section || '1. Architecture, Serialization & Clean Code')}</span>
                <span class="rule-card-title">${escapeHtml(r.title)}</span>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <button class="btn btn-primary btn-xs approve-candidate-dna-btn" data-idx="${idx}" title="Valider et ajouter à references/reviewer-dna.local.md">Valider (ADN Local)</button>
                <button class="btn btn-secondary btn-xs approve-candidate-common-btn" data-idx="${idx}" title="Valider et ajouter au socle commun references/common-dna.md">Valider (Commun)</button>
                <button class="btn btn-ghost btn-xs edit-candidate-btn" data-idx="${idx}">Éditer</button>
                <button class="btn btn-ghost btn-xs reject-candidate-btn" data-idx="${idx}">Rejeter</button>
              </div>
            </div>
            <div class="rule-card-body">${escapeHtml(r.body)}${samplesHtml}</div>
          </div>
        `;
      }

      const badgeLabel =
        r.target === 'common'
          ? 'SOCLE COMMUN'
          : r.target === 'dna'
          ? 'ADN LOCAL'
          : 'FALSE POSITIVE';
      const badgeClass =
        r.target === 'common'
          ? 'badge-severity-nit'
          : r.target === 'dna'
          ? 'badge-severity-ok'
          : 'badge-severity-major';

      return `
        <div class="rule-card ${r.target === 'false-positive' ? 'rule-fp' : 'rule-dna'}" data-idx="${idx}">
          <div class="rule-card-header">
            <div class="rule-card-title-group">
              <span class="badge ${badgeClass}">${badgeLabel}</span>
              <span class="rule-section-pill">${escapeHtml(r.section)}</span>
              <span class="rule-card-title">${escapeHtml(r.title)}</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${r.startLine ? `<span class="meta-text">L${r.startLine}</span>` : ''}
              <button class="btn btn-ghost btn-xs edit-rule-btn" data-idx="${idx}">Éditer</button>
              <button class="btn btn-ghost btn-xs delete-rule-btn" data-idx="${idx}">Retirer</button>
            </div>
          </div>
          <div class="rule-card-body">${escapeHtml(r.body)}</div>
        </div>
      `;
    })
    .join('');

  listEl.innerHTML = candidateBannerHtml + cardsHtml;

  document.getElementById('approveAllCandidatesLocalBtn')?.addEventListener('click', async () => {
    await decideCandidateRuleAction({ action: 'approve-all', target: 'dna' });
  });

  listEl.querySelectorAll('.approve-candidate-dna-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) await decideCandidateRuleAction({ id: rule.id, action: 'approve', target: 'dna' });
    });
  });

  listEl.querySelectorAll('.approve-candidate-common-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) await decideCandidateRuleAction({ id: rule.id, action: 'approve', target: 'common' });
    });
  });

  listEl.querySelectorAll('.reject-candidate-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) await decideCandidateRuleAction({ id: rule.id, action: 'reject' });
    });
  });

  listEl.querySelectorAll('.edit-candidate-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) openCandidateEditorModal(rule);
    });
  });

  listEl.querySelectorAll('.edit-rule-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) openRuleEditorModal(rule, rule.target);
    });
  });

  listEl.querySelectorAll('.delete-rule-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) promptDeleteRule(rule);
    });
  });
}

async function decideCandidateRuleAction(payload) {
  try {
    const res = await fetch('/api/rules/candidates/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur décision règle candidate');
    await loadRules();
    showToast(
      payload.action === 'reject'
        ? 'Règle candidate rejetée.'
        : payload.action === 'approve-all'
        ? 'Toutes les règles candidates ont été validées dans ADN Local.'
        : `Règle validée et ajoutée (${payload.target === 'common' ? 'Socle Commun' : 'ADN Local'}).`
    );
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 4500);
  }
}

function openCandidateEditorModal(candidateRule) {
  const sections =
    state.dnaSections.length > 0
      ? state.dnaSections
      : [
          '1. Architecture, Serialization & Clean Code',
          '2. Multi-Tenant, Security & Voter Isolation (Critical)',
          '3. Database, Migrations & Performance',
          '4. PHP 8.2+ & Symfony Idioms',
          '5. Testing Standards (PHPUnit & Behat)',
          '6. Naming, Typos & Boy Scout Hygiene',
        ];

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = `Éditer & Valider la règle candidate`;
  confirmBtn.textContent = 'Valider la règle';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Destination :</label>
        <select id="candidateTargetSelect" class="search-input">
          <option value="dna">ADN Local / Équipe (references/reviewer-dna.local.md)</option>
          <option value="common">Socle Commun (references/common-dna.md)</option>
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Section :</label>
        <select id="candidateSectionSelect" class="search-input">
          ${sections
            .map(
              (sec) =>
                `<option value="${escapeHtml(sec)}" ${candidateRule.section === sec ? 'selected' : ''}>${escapeHtml(sec)}</option>`
            )
            .join('')}
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Titre de la règle (Anglais) :</label>
        <input type="text" id="candidateTitleInput" class="search-input" value="${escapeHtml(candidateRule.title || '')}" />
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Description / Consigne (Anglais) :</label>
        <textarea id="candidateBodyInput" class="finding-textarea" style="min-height:110px;">${escapeHtml(candidateRule.body || '')}</textarea>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const target = document.getElementById('candidateTargetSelect').value;
    const section = document.getElementById('candidateSectionSelect').value.trim();
    const title = document.getElementById('candidateTitleInput').value.trim();
    const body = document.getElementById('candidateBodyInput').value.trim();
    if (!title || !body) {
      showToast('Titre et description requis.');
      return;
    }
    confirmBtn.disabled = true;
    await decideCandidateRuleAction({
      id: candidateRule.id,
      action: 'approve',
      target,
      section,
      title,
      body,
    });
    confirmBtn.disabled = false;
    modal.classList.add('hidden');
  };
}

function openRuleEditorModal(existingRule = null, defaultTarget = 'dna') {
  const isEdit = Boolean(existingRule);
  const target = existingRule ? existingRule.target : defaultTarget;
  const sections =
    target === 'false-positive'
      ? state.fpSections.length > 0
        ? state.fpSections
        : ['1. Architecture & Intentional Patterns', '2. Framework & Tooling Guarantees', '3. Scope & Legacy Exceptions']
      : target === 'common'
      ? state.commonSections.length > 0
        ? state.commonSections
        : [
            '1. Architecture, Serialization & Clean Code',
            '2. Security, Tenant Isolation & Access Control',
            '3. Database, Migrations & Performance',
            '4. Language & Framework Idioms',
            '5. Automated Testing Standards',
          ]
      : state.dnaSections.length > 0
      ? state.dnaSections
      : [
          '1. Architecture, Serialization & Clean Code',
          '2. Multi-Tenant, Security & Voter Isolation (Critical)',
          '3. Database, Migrations & Performance',
          '4. PHP 8.2+ & Symfony Idioms',
          '5. Testing Standards (PHPUnit & Behat)',
          '6. Naming, Typos & Boy Scout Hygiene',
        ];

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = isEdit
    ? `Éditer la règle : ${existingRule.title}`
    : target === 'false-positive'
    ? 'Ajouter un Faux Positif (false-positives.local.md)'
    : 'Ajouter une Règle Agent';
  confirmBtn.textContent = isEdit ? 'Mettre à jour' : 'Ajouter la règle';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Fichier cible :</label>
        <select id="editorRuleTargetSelect" class="search-input" ${isEdit ? 'disabled' : ''}>
          <option value="dna" ${target === 'dna' ? 'selected' : ''}>ADN Local / Équipe (references/reviewer-dna.local.md)</option>
          <option value="common" ${target === 'common' ? 'selected' : ''}>Socle Commun (references/common-dna.md)</option>
          <option value="false-positive" ${target === 'false-positive' ? 'selected' : ''}>Faux Positifs (references/false-positives.local.md)</option>
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Section :</label>
        <select id="editorRuleSectionSelect" class="search-input">
          ${sections
            .map(
              (sec) =>
                `<option value="${escapeHtml(sec)}" ${existingRule?.section === sec ? 'selected' : ''}>${escapeHtml(sec)}</option>`
            )
            .join('')}
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Titre de la règle (Anglais) :</label>
        <input type="text" id="editorRuleTitleInput" class="search-input" value="${escapeHtml(existingRule?.title || '')}" placeholder="Ex: Strict DateTimeImmutable Usage" />
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Description / Consigne (Anglais) :</label>
        <textarea id="editorRuleBodyInput" class="finding-textarea" style="min-height:110px;" placeholder="Explain what the agent should enforce or ignore...">${escapeHtml(existingRule?.body || '')}</textarea>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const selectedTarget = document.getElementById('editorRuleTargetSelect')?.value || target;
    const section = document.getElementById('editorRuleSectionSelect').value.trim();
    const title = document.getElementById('editorRuleTitleInput').value.trim();
    const body = document.getElementById('editorRuleBodyInput').value.trim();
    if (!title || !body) {
      showToast('Titre et description requis.');
      return;
    }

    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/rules', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isEdit
            ? { id: existingRule.id, target: selectedTarget, section, title, body }
            : { target: selectedTarget, section, title, body, source: 'PR Review Hub UI' }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur sauvegarde règle');
      modal.classList.add('hidden');
      await loadRules();
      showToast(isEdit ? `Règle "${title}" mise à jour.` : `Règle "${title}" ajoutée.`);
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmer';
    }
  };
}

function promptDeleteRule(rule) {
  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = `Retirer la règle de l'agent`;
  confirmBtn.textContent = 'Supprimer définitivement';

  const targetFileLabel =
    rule.target === 'common'
      ? 'references/common-dna.md'
      : rule.target === 'false-positive'
      ? 'references/false-positives.local.md'
      : 'references/reviewer-dna.local.md';

  bodyEl.innerHTML = `
    <div>
      <p style="margin:0 0 8px;">
        Confirmer la suppression de la règle <strong>${escapeHtml(rule.title)}</strong> dans
        <code>${escapeHtml(targetFileLabel)}</code> ?
      </p>
      <pre style="background:var(--bg-app);padding:8px 10px;border-radius:4px;border:1px solid var(--border);white-space:pre-wrap;font-size:11.5px;color:var(--text-secondary);">${escapeHtml(rule.rawMarkdown)}</pre>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/rules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id, target: rule.target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur suppression règle');
      modal.classList.add('hidden');
      await loadRules();
      showToast(`Règle "${rule.title}" retirée de l'agent.`);
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmer';
    }
  };
}

document.getElementById('bootstrapTeamRulesBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('bootstrapTeamRulesBtn');
  if (btn) btn.disabled = true;
  showToast('Analyse des PRs et commentaires de review de l’équipe sur 1 an (365j)...');
  try {
    const res = await fetch('/api/rules/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 365 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur analyse PRs sur 1 an');
    await loadRules();
    // Switch filter tab to "candidate" so the user sees the proposed rules to validate/reject
    state.rulesFilter = 'candidate';
    document
      .getElementById('rulesTargetFilterTabs')
      ?.querySelectorAll('.filter-tab')
      .forEach((b) => b.classList.toggle('active', b.dataset.ruleTarget === 'candidate'));
    renderRulesTab();
    showToast(
      `${data.addedCandidatesCount || 0} nouvelle(s) règle(s) candidate(s) extraite(s) sur ${data.analyzedCommentsCount || 0} commentaires (${data.analyzedPrsCount || 0} PRs).`
    );
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 5000);
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById('rulesTargetFilterTabs')?.querySelectorAll('.filter-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document
      .getElementById('rulesTargetFilterTabs')
      ?.querySelectorAll('.filter-tab')
      .forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.rulesFilter = btn.dataset.ruleTarget || 'all';
    renderRulesTab();
  });
});

document.getElementById('rulesSearchInput')?.addEventListener('input', (e) => {
  state.rulesSearch = e.target.value.trim();
  renderRulesTab();
});

document.getElementById('addDnaRuleBtn')?.addEventListener('click', () => {
  openRuleEditorModal(null, 'dna');
});

document.getElementById('addFpRuleBtn')?.addEventListener('click', () => {
  openRuleEditorModal(null, 'false-positive');
});

// =============================================================================
// Collapsible Panels: PR Sidebar ([), Modified Files List (]), and Full-Screen Focus Diff (z / f / Esc)
// =============================================================================
function renderCollapsibleLayoutState() {
  const appShell = document.getElementById('appShell');
  const diffLayout = document.getElementById('diffLayoutContainer');
  const treeLayout = document.getElementById('treeLayoutContainer');
  const prBtn = document.getElementById('togglePrSidebarBtn');
  const fileBtn = document.getElementById('toggleFileTreeBtn');
  const zenBtn = document.getElementById('toggleZenModeBtn');
  const inlineDiffBtn = document.getElementById('diffToggleFilesInlineBtn');
  const inlineFocusBtn = document.getElementById('diffToggleFocusInlineBtn');

  appShell?.classList.toggle('sidebar-collapsed', state.prSidebarCollapsed || state.focusDiffMode);
  appShell?.classList.toggle('focus-diff-mode', state.focusDiffMode);
  diffLayout?.classList.toggle('file-tree-collapsed', state.fileTreeCollapsed);
  treeLayout?.classList.toggle('file-tree-collapsed', state.fileTreeCollapsed);

  if (prBtn) {
    prBtn.textContent = state.prSidebarCollapsed ? 'Afficher PRs' : 'Masquer PRs';
    prBtn.classList.toggle('btn-primary', state.prSidebarCollapsed);
  }
  if (fileBtn) {
    fileBtn.textContent = state.fileTreeCollapsed ? 'Afficher Fichiers' : 'Masquer Fichiers';
    fileBtn.classList.toggle('btn-primary', state.fileTreeCollapsed);
  }
  if (zenBtn) {
    zenBtn.textContent = state.focusDiffMode ? 'Quitter Focus (Esc)' : 'Focus Diff';
    zenBtn.classList.toggle('btn-primary', state.focusDiffMode);
  }
  if (inlineDiffBtn) {
    const total = (state.currentDiff?.files || []).length;
    inlineDiffBtn.textContent = state.fileTreeCollapsed
      ? `Fichiers (${total})`
      : 'Masquer Fichiers';
  }
  if (inlineFocusBtn) {
    inlineFocusBtn.textContent = state.focusDiffMode ? 'Quitter Focus (Esc)' : 'Focus Diff (z)';
    inlineFocusBtn.classList.toggle('btn-primary', state.focusDiffMode);
    inlineFocusBtn.classList.toggle('btn-secondary', !state.focusDiffMode);
  }
}

function togglePrSidebar() {
  if (state.focusDiffMode) {
    setFocusDiffMode(false);
    return;
  }
  state.prSidebarCollapsed = !state.prSidebarCollapsed;
  renderCollapsibleLayoutState();
}

function toggleFileTree() {
  state.fileTreeCollapsed = !state.fileTreeCollapsed;
  renderCollapsibleLayoutState();
}

function setFocusDiffMode(enabled) {
  if (enabled) {
    state._prevPrSidebar = state.prSidebarCollapsed;
    state._prevFileTree = state.fileTreeCollapsed;
    if (state.splitMode) {
      toggleSplitMode();
    }
    state.focusDiffMode = true;
    state.prSidebarCollapsed = true;
    state.fileTreeCollapsed = true;
    switchTab('diff', { keepFocusDiff: true });
    renderCollapsibleLayoutState();
    setTimeout(() => {
      document.getElementById('diffScrollArea')?.focus({ preventScroll: true });
    }, 0);
  } else {
    state.focusDiffMode = false;
    state.prSidebarCollapsed = Boolean(state._prevPrSidebar);
    state.fileTreeCollapsed = Boolean(state._prevFileTree);
    renderCollapsibleLayoutState();
  }
}

function toggleZenMode() {
  setFocusDiffMode(!state.focusDiffMode);
}

function jumpToRelativeFinding(delta) {
  const isReport = state.activeTab === 'report';
  const selector = isReport ? '.report-detail-card' : '#findingsList .finding-card';
  const cards = Array.from(document.querySelectorAll(selector));
  if (cards.length === 0) return;

  if (state.activeFindingIndex < 0) {
    state.activeFindingIndex = delta > 0 ? 0 : cards.length - 1;
  } else {
    state.activeFindingIndex = Math.max(
      0,
      Math.min(cards.length - 1, state.activeFindingIndex + delta)
    );
  }
  const target = cards[state.activeFindingIndex];
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function scrollActivePanelBy(deltaY) {
  let scrollEl = null;
  if (state.focusDiffMode || state.activeTab === 'diff') {
    scrollEl = document.getElementById('diffScrollArea');
  } else if (state.activeTab === 'tree') {
    scrollEl = document.getElementById('treeScrollArea');
  } else {
    scrollEl = document.getElementById(`tab-${state.activeTab}`);
  }
  if (scrollEl) {
    scrollEl.scrollBy({ top: deltaY, behavior: 'auto' });
  }
}

function openKeyboardShortcutsModal() {
  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');
  if (!modal || !titleEl || !bodyEl || !confirmBtn) return;

  titleEl.textContent = 'Raccourcis Clavier (Navigation 100% Clavier)';
  confirmBtn.textContent = 'Fermer';

  const shortcuts = [
    ['← / → (ou h / l)', 'Fichier modifié précédent / suivant (Diff)'],
    ['↑ / ↓ / PageUp / PageDown', 'Défiler dans le diff ou le rapport actif'],
    ['- / + (ou =) / 0', 'Dézoomer / Zoomer dans le diff / Reset 100%'],
    ['n / p', 'Hunk ou Finding suivant / précédent'],
    ['z ou f', 'Mode Focus Diff plein écran (100% diff)'],
    ['Esc', 'Quitter Focus Diff / Fermer modale ou drawer'],
    ['g', 'Sélecteur rapide de fichier (Diff / Tree)'],
    ['j / k', 'PR suivante / PR précédente dans la queue'],
    ['1 — 5', 'Changer d’onglet (Audit, Commentaires, Diff, Tree, Règles)'],
    ['[ / ]', 'Masquer/Afficher liste PRs / liste Fichiers'],
    ['t', 'Basculer le fichier entre Diff Git et Arbre de Travail'],
    ['i', 'Ouvrir le fichier courant dans PhpStorm'],
    ['s', 'Mode Split côte-à-côte (Rapport + Code)'],
    ['o', 'Ouvrir le Diff dans une fenêtre Pop-out'],
    ['c', 'Ouvrir / Fermer le drawer Agent Q&A'],
    ['r', 'Relancer l’audit IA (Run Review) sur la PR'],
    ['m', 'Ouvrir la modale Publier Review sur GitHub'],
    ['/', 'Rechercher / Filtrer une PR'],
    ['?', 'Afficher cette aide des raccourcis clavier'],
  ];

  bodyEl.innerHTML = `
    <div class="shortcuts-grid">
      ${shortcuts
        .map(
          ([keys, desc]) => `
        <div class="shortcut-row">
          <span>${escapeHtml(desc)}</span>
          <span class="shortcut-keys"><kbd>${escapeHtml(keys)}</kbd></span>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  modal.classList.remove('hidden');
  confirmBtn.onclick = () => {
    modal.classList.add('hidden');
  };
}

document.getElementById('togglePrSidebarBtn')?.addEventListener('click', togglePrSidebar);
document.getElementById('toggleFileTreeBtn')?.addEventListener('click', toggleFileTree);
document.getElementById('toggleZenModeBtn')?.addEventListener('click', toggleZenMode);
document.getElementById('openShortcutsBtn')?.addEventListener('click', openKeyboardShortcutsModal);
document.getElementById('topbarShortcutsBtn')?.addEventListener('click', openKeyboardShortcutsModal);

// =============================================================================
// Keyboard Shortcuts (100% Keyboard-Driven Interface)
// =============================================================================
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('githubModal');
  const isModalOpen = modal && !modal.classList.contains('hidden');

  if (e.key === 'Escape') {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) {
      e.target.blur();
      return;
    }
    if (isModalOpen) {
      modal.classList.add('hidden');
      return;
    }
    if (state.chatOpen) {
      toggleChatDrawer(false);
      return;
    }
    if (state.focusDiffMode) {
      e.preventDefault();
      setFocusDiffMode(false);
      return;
    }
    return;
  }

  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) {
    return;
  }
  if (isModalOpen) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'ArrowLeft' || e.key === 'h') {
    if (state.focusDiffMode || state.activeTab === 'diff' || state.activeTab === 'tree' || state.splitMode) {
      e.preventDefault();
      selectRelativeDiffFile(-1);
    }
  } else if (e.key === 'ArrowRight' || e.key === 'l') {
    if (state.focusDiffMode || state.activeTab === 'diff' || state.activeTab === 'tree' || state.splitMode) {
      e.preventDefault();
      selectRelativeDiffFile(1);
    }
  } else if (e.key === 'ArrowDown') {
    if (!e.target?.classList?.contains('diff-scroll-area')) {
      e.preventDefault();
      scrollActivePanelBy(72);
    }
  } else if (e.key === 'ArrowUp') {
    if (!e.target?.classList?.contains('diff-scroll-area')) {
      e.preventDefault();
      scrollActivePanelBy(-72);
    }
  } else if (e.key === 'n' || e.key === 'p') {
    e.preventDefault();
    const delta = e.key === 'n' ? 1 : -1;
    if (state.focusDiffMode || state.activeTab === 'diff') {
      jumpToRelativeHunk(delta);
    } else if (state.activeTab === 'report' || state.activeTab === 'comments') {
      jumpToRelativeFinding(delta);
    }
  } else if (e.key === 'g') {
    e.preventDefault();
    if (state.focusDiffMode || state.activeTab === 'diff') {
      document.getElementById('diffFileJumpSelect')?.focus();
    } else if (state.activeTab === 'tree') {
      document.getElementById('treeFileFilterInput')?.focus();
    }
  } else if (e.key === 't') {
    e.preventDefault();
    if (state.activeTab === 'tree' && state.selectedTreeFile) {
      navigateToCodeLocation(state.selectedTreeFile, state.selectedTreeLine, 'diff');
    } else if (state.selectedDiffFile) {
      if (state.focusDiffMode) setFocusDiffMode(false);
      navigateToCodeLocation(state.selectedDiffFile, state.highlightedLine, 'tree');
    }
  } else if (e.key === 'i') {
    e.preventDefault();
    openCurrentPrInIde('phpstorm', state.selectedDiffFile || state.selectedTreeFile || '', state.highlightedLine || 1);
  } else if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const list = getFilteredPrs();
    if (list.length === 0) return;
    const idx = list.findIndex((p) => p.key === state.selectedPrKey);
    const nextIdx =
      e.key === 'j'
        ? Math.min(list.length - 1, idx + 1)
        : Math.max(0, idx <= 0 ? 0 : idx - 1);
    selectPr(list[nextIdx].key, true);
  } else if (e.key === '1') {
    switchTab('report');
  } else if (e.key === '2') {
    switchTab('comments');
  } else if (e.key === '3') {
    switchTab('diff');
  } else if (e.key === '4') {
    switchTab('tree');
  } else if (e.key === '5') {
    switchTab('rules');
  } else if (e.key === '[') {
    e.preventDefault();
    togglePrSidebar();
  } else if (e.key === ']') {
    e.preventDefault();
    toggleFileTree();
  } else if (e.key === 'z' || e.key === 'f') {
    e.preventDefault();
    toggleZenMode();
  } else if (e.key === 's') {
    e.preventDefault();
    if (state.focusDiffMode) setFocusDiffMode(false);
    toggleSplitMode();
  } else if (e.key === 'o') {
    openPopoutWorkspace();
  } else if (e.key === 'c') {
    e.preventDefault();
    toggleChatDrawer();
  } else if (e.key === 'r') {
    if (state.selectedPrKey) triggerManualReviewForKey(state.selectedPrKey);
  } else if (e.key === 'm') {
    e.preventDefault();
    openBatchReviewModal('APPROVE');
  } else if (e.key === '/') {
    e.preventDefault();
    if (state.focusDiffMode) setFocusDiffMode(false);
    if (state.prSidebarCollapsed) togglePrSidebar();
    document.getElementById('searchInput')?.focus();
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    adjustDiffZoom(-1);
  } else if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    adjustDiffZoom(1);
  } else if (e.key === '0') {
    e.preventDefault();
    applyDiffZoomVariables(100);
  } else if (e.key === '?') {
    e.preventDefault();
    openKeyboardShortcutsModal();
  }
});

// Initial load
loadState(false);
loadRules();
