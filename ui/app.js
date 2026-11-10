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
  prSortOrder: localStorage.getItem('prHub.prSortOrder') || 'desc', // 'desc' (newest createdAt first) | 'asc' (oldest createdAt first / FIFO)
  searchQuery: '',
  selectedPrKey: initialUrlPrKey,
  activeTab: initialUrlTab === 'tree' ? 'overview' : initialUrlTab,
  splitMode: false,
  splitLeftTab:
    localStorage.getItem('prHub.splitLeftTab') === 'tree'
      ? 'overview'
      : localStorage.getItem('prHub.splitLeftTab') || 'report',
  splitRightTab:
    localStorage.getItem('prHub.splitRightTab') === 'tree'
      ? 'diff'
      : localStorage.getItem('prHub.splitRightTab') || 'diff',
  lineRangeAnchor: null, // { filePath, line }
  isDraggingLineRange: false,
  chatOpen: false,
  chatFindingContext: null,
  chatMessages: [],
  currentReview: null, // { file, archived, markdown, findings }
  currentOverview: null, // { body, commits, generalComments, reviews, reviewThreads, commitsCount, commentsCount }
  overviewFilter: 'all', // 'all' | 'comments' | 'commits'
  currentDiff: null, // { files, resolvedFindings }
  selectedDiffFile: null,
  highlightedLine: null,
  selectedCommentCids: new Set(),
  worktreeStatus: { mounted: false, worktreePath: null },
  // Agent rules state (Tab 5)
  rules: [],
  candidateRules: [],
  commonSections: [],
  dnaSections: [],
  fpSections: [],
  rulesFilter: 'all',
  rulesSearch: '',
  // Full-Page PR Selection Queue, Modified Files Tree, and Full-Screen Focus Diff state
  prQueueFullPage: !initialUrlPrKey && !isPopoutWindow,
  prSidebarCollapsed: true,
  fileTreeCollapsed: false,
  focusDiffMode: false,
  _prevFileTree: false,
  activeHunkIndex: -1,
  activeFindingIndex: -1,
  diffZoom: Number(localStorage.getItem('prReviewHub.diffZoom')) || 100,
  fileSidebarWidth: Number(localStorage.getItem('prHub.fileSidebarWidth')) || 320,
  diffTreeMode: localStorage.getItem('prHub.diffTreeMode') || 'tree', // 'tree' | 'list'
  diffCollapsedFolders: new Set(),
  diffFolderFilter: '',
  diffBlobCache: {}, // key: `${prKey}::${filePath}` -> string[] (lines of file at HEAD)
  diffExpandedRanges: {}, // key: `${prKey}::${filePath}` -> Array<{ startRight, endRight, startLeft, endLeft }>
  prDiffCache: {}, // key: `${prKey}::${headRefOid}` -> diff response
  prOverviewCache: {}, // key: `${prKey}::${headRefOid}` -> overview response
  prReviewCache: {}, // key: `${prKey}::${headRefOid}` -> review response
  _prefetchInFlight: new Set(),
  keybindings: {},
};

const DEFAULT_KEYBINDINGS = {
  openPr: { key: 'Enter', label: 'Open PR on 1. Audit Report' },
  nextPr: { key: 'j', label: 'Next PR in queue' },
  prevPr: { key: 'k', label: 'Previous PR in queue' },
  prQueue: { key: 'q', label: 'Return to full-page PR selection queue (All PRs)' },
  prevFile: { key: 'ArrowLeft', label: 'Previous modified file (Diff)' },
  nextFile: { key: 'ArrowRight', label: 'Next modified file (Diff)' },
  toggleFiles: { key: 'b', label: 'Show / Hide modified files tree on the left' },
  nextHunk: { key: 'n', label: 'Next Hunk or Finding' },
  prevHunk: { key: 'p', label: 'Previous Hunk or Finding' },
  focusDiff: { key: 'z', label: 'Full-screen Focus Diff mode (show/hide PR header)' },
  openIde: { key: 'i', label: 'Open current file in PhpStorm' },
  splitMode: { key: 's', label: 'Side-by-side Split Mode (Left / Right pane choice)' },
  popout: { key: 'o', label: 'Open Diff in a Pop-out window' },
  agentChat: { key: 'c', label: 'Open Agent Q&A (Enter or Cmd+Enter to send)' },
  rerunReview: { key: 'r', label: 'Run / Re-run AI review on PR' },
  openGithub: { key: 'g', label: 'Open Pull Request on GitHub' },
  publishModal: { key: 'm', label: 'Open Submit Review to GitHub modal' },
  searchPr: { key: '/', label: 'Search / Filter PRs' },
  zoomOut: { key: '-', label: 'Zoom out in diff' },
  zoomIn: { key: '+', label: 'Zoom in in diff' },
  zoomReset: { key: '0', label: 'Reset diff zoom to 100%' },
  helpModal: { key: '?', label: 'Show / Customize keyboard shortcuts' },
  tab1: { key: '1', label: 'Tab 1: Audit Report' },
  tab2: { key: '2', label: 'Tab 2: Description & Conversation' },
  tab3: { key: '3', label: 'Tab 3: Git Diff' },
  tab4: { key: '4', label: 'Tab 4: AI Proposals' },
  tab5: { key: '5', label: 'Tab 5: Agent Rules' },
};

function loadSavedKeybindings() {
  const map = {};
  for (const [id, def] of Object.entries(DEFAULT_KEYBINDINGS)) {
    map[id] = def.key;
  }
  try {
    const raw = localStorage.getItem('prHub.keybindings');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [id, val] of Object.entries(parsed)) {
          if (DEFAULT_KEYBINDINGS[id] && typeof val === 'string' && val.length > 0) {
            map[id] = val;
          }
        }
      }
    }
  } catch {
    // Ignore invalid JSON
  }
  state.keybindings = map;
  return map;
}

function saveKeybindings() {
  try {
    localStorage.setItem('prHub.keybindings', JSON.stringify(state.keybindings));
  } catch {
    // Ignore storage quota errors
  }
}

function getKeybind(actionId) {
  return state.keybindings?.[actionId] || DEFAULT_KEYBINDINGS[actionId]?.key || '';
}

function formatKeybindLabel(key) {
  if (!key) return '';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  if (key === 'ArrowUp') return '↑';
  if (key === 'ArrowDown') return '↓';
  if (key === 'Enter') return 'Enter';
  if (key === 'Escape') return 'Esc';
  if (key === ' ') return 'Space';
  return key;
}

function setKeybind(actionId, newKey) {
  if (!DEFAULT_KEYBINDINGS[actionId] || !newKey) return;
  const previousKey = getKeybind(actionId);
  // Swap if another action already uses newKey
  for (const [otherId, boundKey] of Object.entries(state.keybindings)) {
    if (otherId !== actionId && boundKey === newKey) {
      state.keybindings[otherId] = previousKey;
    }
  }
  state.keybindings[actionId] = newKey;
  saveKeybindings();
  syncKeybindingLegends();
}

function resetKeybind(actionId) {
  if (!DEFAULT_KEYBINDINGS[actionId]) return;
  setKeybind(actionId, DEFAULT_KEYBINDINGS[actionId].key);
}

function resetAllKeybindings() {
  for (const [id, def] of Object.entries(DEFAULT_KEYBINDINGS)) {
    state.keybindings[id] = def.key;
  }
  saveKeybindings();
  syncKeybindingLegends();
}

function syncKeybindingLegends() {
  // Update all <kbd data-kb-id="..."> elements across the UI
  document.querySelectorAll('[data-kb-id]').forEach((el) => {
    const kbId = el.dataset.kbId;
    if (kbId === 'tabRange') {
      el.textContent = `${formatKeybindLabel(getKeybind('tab1'))}–${formatKeybindLabel(getKeybind('tab5'))}`;
    } else if (DEFAULT_KEYBINDINGS[kbId]) {
      el.textContent = formatKeybindLabel(getKeybind(kbId));
    }
  });

  const qLbl = formatKeybindLabel(getKeybind('prQueue'));
  const bLbl = formatKeybindLabel(getKeybind('toggleFiles'));
  const zLbl = formatKeybindLabel(getKeybind('focusDiff'));
  const cLbl = formatKeybindLabel(getKeybind('agentChat'));
  const sLbl = formatKeybindLabel(getKeybind('splitMode'));
  const pLbl = formatKeybindLabel(getKeybind('prevHunk'));
  const nLbl = formatKeybindLabel(getKeybind('nextHunk'));
  const tLbl = formatKeybindLabel(getKeybind('toggleTreeView'));
  const iLbl = formatKeybindLabel(getKeybind('openIde'));
  const gLbl = formatKeybindLabel(getKeybind('quickJump'));
  const prevFileLbl = formatKeybindLabel(getKeybind('prevFile'));
  const nextFileLbl = formatKeybindLabel(getKeybind('nextFile'));

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.placeholder = `Search by PR number, Jira ticket, title, branch or author name… (shortcut: ${formatKeybindLabel(getKeybind('searchPr'))} · navigate: ${formatKeybindLabel(getKeybind('nextPr'))}/${formatKeybindLabel(getKeybind('prevPr'))} + ${formatKeybindLabel(getKeybind('openPr'))})`;
  }

  const backBtn = document.getElementById('backToPrQueueBtn');
  if (backBtn) {
    backBtn.textContent = `← All PRs (${qLbl})`;
    backBtn.title = `Return to full-page PR selection queue (shortcut: ${qLbl})`;
  }

  const toggleTreeBtn = document.getElementById('toggleFileTreeBtn');
  if (toggleTreeBtn) {
    toggleTreeBtn.textContent = state.fileTreeCollapsed
      ? `Show Files (${bLbl})`
      : `Hide Files (${bLbl})`;
    toggleTreeBtn.title = `Show / Hide modified files tree on the left (shortcut: ${bLbl})`;
  }

  const inlineFilesBtn = document.getElementById('diffToggleFilesInlineBtn');
  if (inlineFilesBtn) {
    const total = (state.currentDiff?.files || []).length;
    inlineFilesBtn.textContent = state.fileTreeCollapsed
      ? `Files (${total}) (${bLbl})`
      : `Hide Files (${bLbl})`;
    inlineFilesBtn.title = `Show / Hide modified files tree (shortcut: ${bLbl})`;
  }

  const inlineFocusBtn = document.getElementById('diffToggleFocusInlineBtn');
  if (inlineFocusBtn) {
    inlineFocusBtn.textContent = state.focusDiffMode
      ? `Exit Focus (${zLbl})`
      : `Focus (${zLbl})`;
    inlineFocusBtn.title = `Show / Hide PR header and tabs (shortcut: ${zLbl} or Esc)`;
  }

  const inlineChatBtn = document.getElementById('diffOpenChatInlineBtn');
  if (inlineChatBtn) {
    inlineChatBtn.textContent = `Q&A (${cLbl})`;
    inlineChatBtn.title = `Ask AI about this file (shortcut: ${cLbl})`;
  }

  const topChatBtn = document.getElementById('toggleChatDrawerBtn');
  if (topChatBtn) {
    topChatBtn.textContent = `Agent Q&A (${cLbl})`;
    topChatBtn.title = `Ask review agent about this PR (shortcut: ${cLbl})`;
  }

  const splitBtn = document.getElementById('toggleSplitModeBtn') || document.getElementById('toggleSplitViewBtn');
  if (splitBtn) {
    splitBtn.textContent = `Split (${sLbl})`;
    splitBtn.title = `Side-by-side Report + Diff view (shortcut: ${sLbl})`;
  }

  const rLbl = formatKeybindLabel(getKeybind('rerunReview'));
  const oLbl = formatKeybindLabel(getKeybind('popout'));
  const ghLbl = formatKeybindLabel(getKeybind('openGithub'));
  const mLbl = formatKeybindLabel(getKeybind('publishModal'));

  const triggerReviewBtn = document.getElementById('triggerReviewBtn');
  const triggerReviewLabel = document.getElementById('triggerReviewLabel');
  if (triggerReviewBtn) {
    triggerReviewBtn.title = `Run or re-run AI review now (shortcut: ${rLbl})`;
  }
  if (triggerReviewLabel) {
    const activePr = state.prs.find((p) => p.key === state.selectedPrKey);
    if (!activePr?.runningJob) {
      const baseText = activePr?.hasReviewFile ? 'Re-run Review' : 'Run Review';
      triggerReviewLabel.textContent = `${baseText} (${rLbl})`;
    }
  }

  const popoutBtn = document.getElementById('popoutWorkspaceBtn');
  if (popoutBtn) {
    popoutBtn.textContent = `Pop-out (${oLbl}) ↗`;
    popoutBtn.title = `Open Diff workspace in a separate synchronized window (shortcut: ${oLbl})`;
  }

  const openGithubBtn = document.getElementById('openGithubPrBtn');
  if (openGithubBtn) {
    openGithubBtn.textContent = `GitHub (${ghLbl}) ↗`;
    openGithubBtn.title = `Open Pull Request on GitHub (shortcut: ${ghLbl})`;
  }

  const submitReviewBtn = document.getElementById('openBatchReviewModalBtn');
  if (submitReviewBtn) {
    submitReviewBtn.textContent = `Submit Review (${mLbl})`;
    submitReviewBtn.title = `Open Submit Review to GitHub modal (shortcut: ${mLbl})`;
  }

  const prevFileBtn = document.getElementById('diffPrevFileBtn');
  if (prevFileBtn) prevFileBtn.title = `Previous file (${prevFileLbl})`;
  const nextFileBtn = document.getElementById('diffNextFileBtn');
  if (nextFileBtn) nextFileBtn.title = `Next file (${nextFileLbl})`;
  const prevHunkBtn = document.getElementById('diffPrevHunkBtn');
  if (prevHunkBtn) prevHunkBtn.title = `Previous Hunk / Finding (shortcut: ${pLbl})`;
  const nextHunkBtn = document.getElementById('diffNextHunkBtn');
  if (nextHunkBtn) nextHunkBtn.title = `Next Hunk / Finding (shortcut: ${nLbl})`;
}

function applySidebarWidthVariables(widthPx = state.fileSidebarWidth) {
  const clamped = Math.max(200, Math.min(780, Number(widthPx) || 320));
  state.fileSidebarWidth = clamped;
  try {
    localStorage.setItem('prHub.fileSidebarWidth', String(clamped));
  } catch {
    // Ignore storage quota errors
  }
  document.documentElement.style.setProperty('--file-sidebar-width', `${clamped}px`);
}

function initSidebarResizers() {
  const resizers = [
    document.getElementById('diffSidebarResizer'),
    document.getElementById('treeSidebarResizer'),
  ].filter(Boolean);

  resizers.forEach((resizer) => {
    resizer.addEventListener('mousedown', (startEvent) => {
      startEvent.preventDefault();
      resizer.classList.add('resizing');
      const startX = startEvent.clientX;
      const startWidth = state.fileSidebarWidth || 320;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        applySidebarWidthVariables(startWidth + deltaX);
      };

      const onMouseUp = () => {
        resizer.classList.remove('resizing');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });

    resizer.addEventListener('dblclick', () => {
      // Auto-fit to longest file path or toggle between 320px and 480px
      const files = state.currentDiff?.files || [];
      const maxLen = files.reduce(
        (acc, f) => Math.max(acc, f.filename.replace(/^projects\/services\//, '').length),
        32
      );
      const target = state.fileSidebarWidth > 420 ? 320 : Math.min(680, Math.max(420, maxLen * 7.2));
      applySidebarWidthVariables(Math.round(target));
    });
  });
}

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

const THEME_ORDER = ['light', 'purple', 'dark'];
const THEME_LABELS = {
  light: 'Light',
  purple: 'Lavender (Purple)',
  dark: 'Dark',
};

function applySavedTheme(themeName) {
  const validTheme = THEME_ORDER.includes(themeName) ? themeName : 'dark';
  document.documentElement.setAttribute('data-theme', validTheme);
  try {
    localStorage.setItem('prReviewHub.theme', validTheme);
  } catch {
    // Ignore storage quota errors
  }
}

loadSavedKeybindings();
applySavedTheme(localStorage.getItem('prReviewHub.theme') || 'dark');
applyDiffZoomVariables(state.diffZoom);
applySidebarWidthVariables(state.fileSidebarWidth);
initSidebarResizers();
syncKeybindingLegends();

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
    .replace(/(\d+)\s*🔴\s*(?:Blocker|Blockers|Blocking)?/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Blockers' : 'Blocker'}`)
    .replace(/(\d+)\s*🟠\s*(?:Major|Majors|Important)?/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Majors' : 'Major'}`)
    .replace(/(\d+)\s*🟡\s*(?:Minor|Minors|Suggestion|Suggestions)?/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Minors' : 'Minor'}`)
    .replace(/(\d+)\s*🟢\s*(?:Nitpick|Nitpicks|Nit|Nits)?/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Nitpicks' : 'Nitpick'}`)
    .replace(/(\d+)\s*(?:🔵|❓)\s*(?:Question|Questions|Nit|Nitpick)?/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Questions' : 'Question'}`)
    .replace(/\b(\d+)\s+blk(?:\s+Blocking|\s+Blocker)?\b/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Blockers' : 'Blocker'}`)
    .replace(/\b(\d+)\s+maj(?:\s+Major)?\b/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Majors' : 'Major'}`)
    .replace(/\b(\d+)\s+min(?:\s+Minor)?\b/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Minors' : 'Minor'}`)
    .replace(/\b(\d+)\s+nit(?:\s+Nit|\s+Nitpick)?\b/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Nitpicks' : 'Nitpick'}`)
    .replace(/\b(\d+)\s+qst(?:\s+Question|\s+Questions)?\b/gi, (_, count) => `${count} ${Number(count) > 1 ? 'Questions' : 'Question'}`);
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
  if (pr.isArchived || pr.isDraft) return false;
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
const notifiedJobIds = new Set();

function scheduleJobPollingIfNeeded() {
  const hasRunning = (state.jobs || []).some((j) => j.status === 'running');
  if (hasRunning && !jobPollTimer) {
    jobPollTimer = setInterval(async () => {
      await loadState(true);
      const stillRunning = (state.jobs || []).some((j) => j.status === 'running');
      for (const j of state.jobs || []) {
        if (j.status !== 'running' && j.id && !notifiedJobIds.has(j.id)) {
          notifiedJobIds.add(j.id);
          if (j.status === 'failed') {
            showToast(
              `AI review failed for ${j.prKey}: ${j.error || 'Unknown error'} (check Doctor for CLI status)`,
              7000
            );
          } else if (j.status === 'completed') {
            showToast(`AI review completed for ${j.prKey}.`, 3500);
          }
        }
      }
      if (!stillRunning) {
        clearInterval(jobPollTimer);
        jobPollTimer = null;
        if (state.selectedPrKey) {
          selectPr(state.selectedPrKey, false);
        }
      }
    }, 2500);
  }
}

async function loadState(preserveSelection = true) {
  const res = await fetch('/api/state');
  const data = await res.json();
  state.prs = data.prs || [];
  state.uiState = data.uiState || {};
  state.config = data.config || {};
  state.jobs = data.jobs || [];
  state.appVersion = data.version || '1.1.0';

  const versionBadgeEl = document.getElementById('appVersionBadge');
  if (versionBadgeEl) {
    versionBadgeEl.textContent = `v${state.appVersion}`;
  }

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

  if (data.neverSynced && state.prs.length === 0 && !state._autoSyncedFirstRun) {
    state._autoSyncedFirstRun = true;
    runQueueSync();
    return;
  }

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
      if (!stillExists.hasReviewFile && state.activeTab === 'report') {
        selectPr(stillExists.key, false);
      }
    }
  }
  renderCollapsibleLayoutState();
  scheduleClientPrPrefetch();
}

function getPrClientCacheKey(pr) {
  if (!pr || !pr.key) return '';
  return `${pr.key}::${pr.headRefOid || pr.lastReviewedSha || 'latest'}`;
}

async function prefetchPrData(pr) {
  if (!pr || !pr.key || pr.isArchived) return;
  const cacheKey = getPrClientCacheKey(pr);
  if (!cacheKey || state._prefetchInFlight.has(cacheKey)) return;

  const needReview = pr.reviewFile && !state.prReviewCache[cacheKey];
  const needDiff = !state.prDiffCache[cacheKey];
  const needOverview = !state.prOverviewCache[cacheKey];
  if (!needReview && !needDiff && !needOverview) return;

  state._prefetchInFlight.add(cacheKey);
  try {
    const tasks = [];
    if (needReview) {
      tasks.push(
        fetch(
          `/api/review?file=${encodeURIComponent(pr.reviewFile)}&key=${encodeURIComponent(pr.key)}`
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d) state.prReviewCache[cacheKey] = d;
          })
          .catch(() => {})
      );
    }
    if (needDiff) {
      tasks.push(
        fetch(
          `/api/diff?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&reviewFile=${encodeURIComponent(pr.reviewFile || '')}`
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d) state.prDiffCache[cacheKey] = d;
          })
          .catch(() => {})
      );
    }
    if (needOverview) {
      tasks.push(
        fetch(
          `/api/github/overview?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}`
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && !d.offlineError) state.prOverviewCache[cacheKey] = d;
          })
          .catch(() => {})
      );
    }
    await Promise.all(tasks);
  } finally {
    state._prefetchInFlight.delete(cacheKey);
  }
}

let clientPrefetchRunning = false;

async function scheduleClientPrPrefetch() {
  if (clientPrefetchRunning) return;
  const candidates = getFilteredPrs()
    .filter((p) => !p.isArchived)
    .slice(0, 12);
  if (candidates.length === 0) return;

  clientPrefetchRunning = true;
  try {
    for (const pr of candidates) {
      await prefetchPrData(pr);
    }
  } finally {
    clientPrefetchRunning = false;
  }
}

function updateFilterCounts() {
  const openPrs = state.prs.filter((p) => !p.isArchived);
  const nonDraftOpenPrs = openPrs.filter((p) => !p.isDraft);
  document.getElementById('count-open').textContent = nonDraftOpenPrs.length;
  document.getElementById('count-actionable').textContent = nonDraftOpenPrs.filter(isActionablePr).length;
  document.getElementById('count-peer').textContent = nonDraftOpenPrs.filter((p) => p.reviewMode === 'Peer-Review').length;
  document.getElementById('count-self').textContent = nonDraftOpenPrs.filter((p) => p.reviewMode === 'Self-Review').length;
  const draftCountEl = document.getElementById('count-draft');
  if (draftCountEl) {
    draftCountEl.textContent = openPrs.filter((p) => Boolean(p.isDraft)).length;
  }
  document.getElementById('count-archived').textContent = state.prs.filter((p) => p.isArchived && !p.isDraft).length;
}

function renderRepoPills() {
  const container = document.getElementById('repoFilterPills');
  const repos = [...new Set(state.prs.map((p) => p.repo).filter(Boolean))];
  const pillsHtml = [
    `<button class="repo-pill ${state.activeRepo === 'all' ? 'active' : ''}" data-repo="all">All repositories</button>`,
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

function formatRelativeAgeFr(isoDate, prefix = 'Updated') {
  if (!isoDate) return '';
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const p = prefix ? `${prefix} ` : '';
  if (diffSec < 60) return `${p}just now`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${p}${diffMin} ${diffMin > 1 ? 'minutes' : 'minute'} ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${p}${diffHours} ${diffHours > 1 ? 'hours' : 'hour'} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${p}${diffDays} ${diffDays > 1 ? 'days' : 'day'} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${p}${diffMonths} ${diffMonths > 1 ? 'months' : 'month'} ago`;
}

function formatRelativeTime(isoDate) {
  return formatRelativeAgeFr(isoDate, '');
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
  const matchPr = state.prs.find((p) => p.author === state.activeAuthor);
  const displayName = matchPr?.authorDisplayName || `@${state.activeAuthor}`;
  label.textContent = `Author filter: ${displayName}`;
}

function syncPrSortOrderButton() {
  const btn = document.getElementById('prSortOrderBtn');
  if (!btn) return;
  if (state.prSortOrder === 'asc') {
    btn.innerHTML = `Opened Date &uarr; (Oldest / FIFO)`;
  } else {
    btn.innerHTML = `Opened Date &darr; (Newest)`;
  }
}

function getFilteredPrs() {
  const filtered = state.prs.filter((pr) => {
    if (state.activeFilter === 'draft') {
      if (pr.isArchived || !pr.isDraft) return false;
    } else {
      if (pr.isDraft) return false;
      if (state.activeFilter === 'open' && pr.isArchived) return false;
      if (state.activeFilter === 'actionable' && !isActionablePr(pr)) return false;
      if (state.activeFilter === 'peer' && (pr.isArchived || pr.reviewMode !== 'Peer-Review')) return false;
      if (state.activeFilter === 'self' && (pr.isArchived || pr.reviewMode !== 'Self-Review')) return false;
      if (state.activeFilter === 'archived' && !pr.isArchived) return false;
    }

    if (state.activeRepo !== 'all' && pr.repo !== state.activeRepo) return false;
    if (state.activeAuthor && pr.author !== state.activeAuthor) return false;

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const approvers = (pr.approvedBy || []).join(' ');
      const pending = (pr.pendingReviewers || []).join(' ');
      const labels = (pr.labels || []).map((l) => l.name).join(' ');
      const owners = (pr.requiredOwnerTeams || []).map((t) => t.teamSlug).join(' ');
      const draftToken = pr.isDraft ? 'draft brouillon' : '';
      const mergeableToken = pr.mergeReadiness?.isMergeable ? 'mergeable prete' : '';
      const hay = `${pr.key} ${pr.title} ${pr.author} ${pr.authorDisplayName || ''} ${pr.jiraKey || ''} ${pr.headRefName || ''} ${approvers} ${pending} ${labels} ${owners} ${draftToken} ${mergeableToken}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
    const dateA = String(a.createdAt || a.updatedAt || '');
    const dateB = String(b.createdAt || b.updatedAt || '');
    return state.prSortOrder === 'asc'
      ? dateA.localeCompare(dateB)
      : dateB.localeCompare(dateA);
  });

  return filtered;
}

function renderCodeOwnerTagsHtml(pr) {
  const teams = Array.isArray(pr.requiredOwnerTeams) ? pr.requiredOwnerTeams : [];
  if (teams.length === 0) return '';
  return teams
    .map((t) => {
      if (t.approved) {
        const who = Array.isArray(t.approvedBy) && t.approvedBy.length > 0 ? ` (${t.approvedBy.join(', ')})` : '';
        return `<span class="pr-owner-tag owner-approved" title="Responsible owner team (${escapeHtml(t.teamSlug)}) — Approved by ${escapeHtml((t.approvedBy || []).join(', '))}">Owner: ${escapeHtml(t.teamSlug)} &check;${escapeHtml(who)}</span>`;
      }
      return `<span class="pr-owner-tag owner-pending" title="Waiting for at least 1 approval from a member of responsible team ${escapeHtml(t.teamSlug)} (CODEOWNERS)">Owner: ${escapeHtml(t.teamSlug)} (pending)</span>`;
    })
    .join('');
}

function renderMergeableTagHtml(pr, asBadge = false) {
  const mr = pr.mergeReadiness;
  if (!mr) {
    if (pr.mergeable === 'CONFLICTING') {
      return `<span class="${asBadge ? 'badge badge-severity-blocker' : 'pr-tag pr-tag-conflict'}">Git conflict</span>`;
    }
    return '';
  }
  if (mr.isMergeable) {
    return `<span class="${asBadge ? 'badge badge-mergeable-ok' : 'pr-tag pr-tag-mergeable-ok'}" title="Ready to merge: Non-Draft, no Git conflict, CODEOWNERS team(s) approved, and CI passing">Mergeable &check;</span>`;
  }
  const reasons = Array.isArray(mr.blockingReasons) && mr.blockingReasons.length > 0
    ? mr.blockingReasons.join(' · ')
    : 'Requirements not met';
  return `<span class="${asBadge ? 'badge badge-mergeable-blocked' : 'pr-tag pr-tag-mergeable-blocked'}" title="Not mergeable: ${escapeHtml(reasons)}">Not mergeable: ${escapeHtml(reasons)}</span>`;
}

function renderPrList() {
  syncPrSortOrderButton();
  const listEl = document.getElementById('prList');
  const filtered = getFilteredPrs();

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state meta-text" style="padding:20px;text-align:center;">No PRs match this filter.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((pr) => {
      const isSelected = pr.key === state.selectedPrKey;
      const statusClass = getCardStatusClass(pr);
      const authorFullLabel = pr.authorDisplayName || `@${pr.author || 'unknown'}`;
      const isAuthorActive = state.activeAuthor === pr.author;

      const draftBadge = pr.isDraft
        ? `<span class="badge badge-draft" title="Draft Pull Request — Automatic AI review paused">Draft</span>`
        : '';
      const modeBadge = `<span class="badge">${escapeHtml(pr.reviewMode === 'Self-Review' ? 'Self-Review' : 'Peer-Review')}</span>`;
      const jiraBadge =
        pr.jiraKey && pr.jiraKey !== '—'
          ? `<span class="badge">Ticket ${escapeHtml(pr.jiraKey)}</span>`
          : '';
      const stackBadge = pr.isStacked
        ? `<span class="badge badge-severity-major" title="Target branch: ${escapeHtml(pr.baseRefName)}">Stacked branch → ${escapeHtml(pr.baseRefName)}</span>`
        : '';
      const ciBadge =
        pr.ciStatus === 'PASS'
          ? `<span class="badge badge-severity-ok">CI: Success</span>`
          : pr.ciStatus === 'FAIL'
          ? `<span class="badge badge-severity-blocker">CI: Failure</span>`
          : pr.ciStatus === 'PENDING'
          ? `<span class="badge">CI: Pending</span>`
          : '';
      const wtBadge = pr.worktreeMounted ? `<span class="badge badge-severity-ok" title="Worktree mounted locally">Worktree mounted</span>` : '';

      const postedInfo =
        pr.findingsCount > 0
          ? `<span class="badge" title="Comments posted on GitHub">${pr.postedCount}/${pr.findingsCount} comments posted</span>`
          : '';

      const needsRun = pr.syncStatus === 'NEEDS_REVIEW' || pr.syncStatus === 'NEEDS_UPDATE' || pr.syncStatus === 'DRAFT';
      const quickRunBtn = pr.runningJob
        ? `<span class="badge"><span class="spinner"></span> AI Review running…</span>`
        : needsRun
        ? `<button class="btn btn-secondary btn-xs card-run-review-btn" data-key="${escapeHtml(pr.key)}" title="Run AI review now">Run AI Review</button>`
        : `<button class="btn btn-secondary btn-xs card-run-review-btn" data-key="${escapeHtml(pr.key)}" title="Re-run AI review">Re-run Review</button>`;

      const cleanStatus = formatCleanStatus(pr.reviewStatus);
      const cleanSummary = formatCleanSummary(pr.findingsSummary);
      const shaShort = (pr.headRefOid || pr.lastReviewedSha || '').slice(0, 7);
      const branchSummary = pr.headRefName
        ? `<div class="pr-card-branch">${escapeHtml(pr.headRefName)} → ${escapeHtml(pr.baseRefName || 'develop')}${shaShort ? ` · commit ${escapeHtml(shaShort)}` : ''}</div>`
        : '';

      // Detailed PR metadata & review tags
      const detailTags = [];
      const mergeableTag = renderMergeableTagHtml(pr, false);
      if (mergeableTag) {
        detailTags.push(mergeableTag);
      }
      const codeOwnerTags = renderCodeOwnerTagsHtml(pr);
      if (codeOwnerTags) {
        detailTags.push(codeOwnerTags);
      }
      if (pr.mergeable === 'CONFLICTING') {
        detailTags.push(`<span class="pr-tag pr-tag-conflict">Git conflict</span>`);
      }
      if (Array.isArray(pr.approvedBy) && pr.approvedBy.length > 0) {
        detailTags.push(
          `<span class="pr-tag pr-tag-approved">Approved by: ${escapeHtml(pr.approvedBy.join(', '))}</span>`
        );
      }
      if (Array.isArray(pr.changesRequestedBy) && pr.changesRequestedBy.length > 0) {
        detailTags.push(
          `<span class="pr-tag pr-tag-changes">Changes requested by: ${escapeHtml(pr.changesRequestedBy.join(', '))}</span>`
        );
      }
      if (Array.isArray(pr.commentedBy) && pr.commentedBy.length > 0) {
        detailTags.push(
          `<span class="pr-tag">Commented by: ${escapeHtml(pr.commentedBy.join(', '))}</span>`
        );
      }
      if (Array.isArray(pr.pendingReviewers) && pr.pendingReviewers.length > 0) {
        detailTags.push(
          `<span class="pr-tag pr-tag-pending">Waiting for: ${escapeHtml(pr.pendingReviewers.join(', '))}</span>`
        );
      }
      if (typeof pr.changedFiles === 'number') {
        const fileWord = pr.changedFiles > 1 ? 'files' : 'file';
        detailTags.push(
          `<span class="pr-tag pr-tag-diffstat">${pr.changedFiles} ${fileWord} · <span class="add-stat">+${pr.additions ?? 0}</span> / <span class="del-stat">-${pr.deletions ?? 0}</span></span>`
        );
      }
      if (Array.isArray(pr.labels) && pr.labels.length > 0) {
        for (const lbl of pr.labels) {
          if (lbl?.name) {
            detailTags.push(`<span class="pr-tag">Label: ${escapeHtml(lbl.name)}</span>`);
          }
        }
      }
      const openedAge = formatRelativeAgeFr(pr.createdAt, 'Opened');
      if (openedAge) {
        detailTags.push(`<span class="pr-tag" title="Opened at: ${escapeHtml(pr.createdAt || '')}">${escapeHtml(openedAge)}</span>`);
      }
      const relativeAge = formatRelativeAgeFr(pr.updatedAt, 'Updated');
      if (relativeAge) {
        detailTags.push(`<span class="pr-tag">${escapeHtml(relativeAge)}</span>`);
      }

      const detailTagsRowHtml =
        detailTags.length > 0
          ? `<div class="pr-meta-tags-row">${detailTags.join('')}</div>`
          : '';

      return `
        <div class="pr-card ${statusClass} ${isSelected ? 'active' : ''}" data-key="${escapeHtml(pr.key)}">
          <div class="pr-card-top">
            <div class="pr-card-identity">
              <span class="pr-card-key">${escapeHtml(pr.repo)} #${pr.number}</span>
              ${draftBadge}
              <span class="pr-author-pill author-badge ${isAuthorActive ? 'active' : ''}" data-author="${escapeHtml(pr.author)}" title="Click to filter by author (@${escapeHtml(pr.author)})">
                <span class="author-full-name">${escapeHtml(authorFullLabel)}</span>
              </span>
              ${modeBadge}
            </div>
            <div class="pr-card-badges">
              ${wtBadge}
              ${stackBadge}
              ${ciBadge}
              ${jiraBadge}
            </div>
          </div>
          <div class="pr-card-middle">
            <div class="pr-card-title">${escapeHtml(pr.title || pr.key)}</div>
            ${branchSummary}
            ${detailTagsRowHtml}
          </div>
          <div class="pr-card-bottom">
            <div class="pr-card-verdict-group">
              <span class="pr-verdict-text">${escapeHtml(cleanStatus)}</span>
              ${cleanSummary ? `<span class="pr-summary-pill">${escapeHtml(cleanSummary)}</span>` : ''}
              ${postedInfo}
            </div>
            <div class="pr-card-actions">
              <button class="btn btn-primary btn-xs card-open-report-btn" data-key="${escapeHtml(pr.key)}" title="Open full audit report (default click action)">Read Audit</button>
              <button class="btn btn-secondary btn-xs card-open-diff-btn" data-key="${escapeHtml(pr.key)}" title="Open 3. Git Diff tab">Open Diff</button>
              ${quickRunBtn}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.pr-card').forEach((card) => {
    card.addEventListener('mouseenter', () => {
      const hoverPr = state.prs.find((p) => p.key === card.dataset.key);
      if (hoverPr) {
        prefetchPrData(hoverPr);
      }
    });
    card.addEventListener('click', (e) => {
      if (
        e.target.closest('.author-badge') ||
        e.target.closest('.card-run-review-btn') ||
        e.target.closest('.card-open-report-btn') ||
        e.target.closest('.card-open-diff-btn')
      ) {
        return;
      }
      enterPrReviewWorkspace(card.dataset.key, 'report');
    });
  });

  listEl.querySelectorAll('.card-open-report-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      enterPrReviewWorkspace(btn.dataset.key, 'report');
    });
  });

  listEl.querySelectorAll('.card-open-diff-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      enterPrReviewWorkspace(btn.dataset.key, 'diff');
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

  const activeCard = listEl.querySelector('.pr-card.active');
  activeCard?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderTopbar(pr) {
  document.getElementById('emptyMainState').classList.add('hidden');
  document.getElementById('prContentArea').classList.remove('hidden');

  document.getElementById('prRepoBadge').textContent = `${pr.repo} #${pr.number}`;
  const draftBadgeEl = document.getElementById('prDraftBadge');
  if (draftBadgeEl) {
    draftBadgeEl.classList.toggle('hidden', !pr.isDraft);
  }
  const authorBadgeEl = document.getElementById('prAuthorBadge');
  if (authorBadgeEl) {
    authorBadgeEl.textContent = pr.authorDisplayName || (pr.author ? `@${pr.author}` : '');
    authorBadgeEl.title = pr.author ? `@${pr.author}` : '';
  }
  const modeBadge = document.getElementById('prModeBadge');
  modeBadge.textContent = pr.reviewMode === 'Self-Review' ? 'Self-Review' : 'Peer-Review';
  modeBadge.className = 'badge';

  const mergeableBadgeEl = document.getElementById('prMergeableBadge');
  if (mergeableBadgeEl) {
    if (pr.mergeReadiness) {
      mergeableBadgeEl.outerHTML = `<span id="prMergeableBadge">${renderMergeableTagHtml(pr, true)}</span>`;
    } else {
      mergeableBadgeEl.classList.add('hidden');
    }
  }

  const codeOwnersEl = document.getElementById('prCodeOwnersBadges');
  if (codeOwnersEl) {
    codeOwnersEl.innerHTML = renderCodeOwnerTagsHtml(pr);
  }

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
      ciEl.textContent =
        pr.ciStatus === 'PASS'
          ? 'CI: Success'
          : pr.ciStatus === 'FAIL'
          ? 'CI: Failure'
          : 'CI: Pending';
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
      stackEl.textContent = `Stacked branch → ${pr.baseRefName}`;
      stackEl.classList.remove('hidden');
    } else {
      stackEl.classList.add('hidden');
    }
  }

  const jiraEl = document.getElementById('prJiraLink');
  if (pr.jiraKey && pr.jiraKey !== '—') {
    jiraEl.textContent = `Ticket ${pr.jiraKey} ↗`;
    jiraEl.href = `https://ubitransport.atlassian.net/browse/${pr.jiraKey}`;
    jiraEl.classList.remove('hidden');
  } else {
    jiraEl.classList.add('hidden');
  }

  const sha = (pr.headRefOid || pr.lastReviewedSha || '').slice(0, 7);
  document.getElementById('prShaBadge').textContent = sha ? `commit ${sha}` : '';
  document.getElementById('prTitleHeader').textContent = pr.title || pr.key;
  document.getElementById('prBranchRow').textContent = pr.headRefName
    ? `${pr.headRefName} → ${pr.baseRefName || 'develop'}`
    : '';
  document.getElementById('openGithubPrBtn').href =
    pr.url || `https://github.com/ubitransports/${pr.repo}/pull/${pr.number}`;

  // Review trigger button state
  const reviewSpinner = document.getElementById('reviewJobSpinner');
  const reviewLabel = document.getElementById('triggerReviewLabel');
  const rLbl = formatKeybindLabel(getKeybind('rerunReview'));
  if (pr.runningJob) {
    reviewSpinner?.classList.remove('hidden');
    if (reviewLabel) {
      reviewLabel.textContent = pr.runningJob.phase || 'AI Review running…';
    }
  } else {
    reviewSpinner?.classList.add('hidden');
    if (reviewLabel) {
      reviewLabel.textContent = `${pr.hasReviewFile ? 'Re-run Review' : 'Run Review'} (${rLbl})`;
    }
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
    badge.textContent = 'Worktree: Mounted';
    badge.className = 'badge badge-mono badge-severity-ok';
    badge.title = state.worktreeStatus?.worktreePath || pr?.worktreePath || '';
    mountBtn.textContent = 'Sync Worktree';
    unmountBtn.classList.remove('hidden');
  } else {
    badge.textContent = 'Worktree: Direct Git';
    badge.className = 'badge badge-mono';
    badge.title = 'Direct Git exploration (click Mount Worktree to create an isolated worktree folder)';
    mountBtn.textContent = 'Mount Worktree';
    unmountBtn.classList.add('hidden');
  }
}

async function selectPr(prKey, broadcast = true) {
  state.selectedPrKey = prKey;
  state.overviewFilter = 'all';
  state.selectedDiffFile = null;
  state.highlightedLine = null;
  state.diffFolderFilter = '';
  state.chatFindingContext = null;
  renderPrList();

  const pr = state.prs.find((p) => p.key === prKey);
  if (!pr) return;

  const cacheKey = getPrClientCacheKey(pr);
  state.currentReview = state.prReviewCache[cacheKey] || null;
  state.currentOverview = state.prOverviewCache[cacheKey] || null;
  state.currentDiff = state.prDiffCache[cacheKey] || null;

  state.worktreeStatus = {
    mounted: Boolean(pr.worktreeMounted),
    worktreePath: pr.worktreePath || null,
  };

  renderTopbar(pr);
  document.getElementById('tabFilesCount').textContent = state.currentDiff
    ? (state.currentDiff.files || []).length
    : (pr.changedFiles ?? '…');
  const commitsBadge = document.getElementById('tabOverviewCommitsCount');
  const commentsBadge = document.getElementById('tabOverviewCommentsCount');
  if (commitsBadge) {
    const cCount = state.currentOverview?.commitsCount ?? pr.commitsCount ?? '…';
    commitsBadge.textContent = `${cCount} commit${cCount === 1 ? '' : 's'}`;
  }
  if (commentsBadge) {
    const gCount = state.currentOverview?.commentsCount ?? pr.githubCommentsCount ?? '…';
    commentsBadge.textContent = `${gCount} comment${gCount === 1 ? '' : 's'}`;
  }

  if (broadcast && syncChannel) {
    syncChannel.postMessage({ type: 'SELECT_PR', prKey });
  }

  loadDiffForCurrentPr(pr);
  loadPrOverview(pr, false);
  if (state.chatOpen) {
    loadChatForCurrentPr(pr);
  }

  if (state.currentReview) {
    state.selectedCommentCids = new Set(
      (state.currentReview.findings || []).filter((f) => !f.posted && !f.dismissed).map((f) => f.cid)
    );
    renderReportFindingsQuickBar();
    renderMarkdownReport(state.currentReview.markdown);
    renderFindingsTab();
  }

  if (pr.reviewFile) {
    const res = await fetch(
      `/api/review?file=${encodeURIComponent(pr.reviewFile)}&key=${encodeURIComponent(pr.key)}`
    );
    if (res.ok) {
      const reviewData = await res.json();
      state.prReviewCache[cacheKey] = reviewData;
      if (state.selectedPrKey !== pr.key) return;
      state.currentReview = reviewData;
      state.selectedCommentCids = new Set(
        state.currentReview.findings.filter((f) => !f.posted && !f.dismissed).map((f) => f.cid)
      );
      renderReportFindingsQuickBar();
      renderMarkdownReport(state.currentReview.markdown);
      renderFindingsTab();
    } else if (state.selectedPrKey !== pr.key) {
      return;
    } else if (!state.currentReview) {
      document.getElementById('reportExecutiveHeader')?.classList.add('hidden');
      document.getElementById('reportFindingsQuickBar')?.classList.add('hidden');
      document.getElementById('markdownContainer').innerHTML = `<div class="empty-state meta-text">Review file not found (${escapeHtml(pr.reviewFile)}).</div>`;
      document.getElementById('findingsList').innerHTML = '';
      document.getElementById('tabFindingsCount').textContent = '0';
    }
  } else {
    document.getElementById('reportExecutiveHeader')?.classList.add('hidden');
    document.getElementById('reportFindingsQuickBar')?.classList.add('hidden');
    if (pr.runningJob) {
      document.getElementById('markdownContainer').innerHTML = `
        <div class="empty-card" style="margin:40px auto;">
          <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:10px;">
            <span class="spinner"></span>
            <h3 style="margin:0;">AI Review in progress (${escapeHtml((pr.runningJob.cli || 'gemini').toUpperCase())})</h3>
          </div>
          <p class="meta-text" style="margin-bottom:6px;">${escapeHtml(pr.runningJob.phase || 'Analyzing Pull Request diff against 4-layer engineering rules…')}</p>
          <p class="meta-text" style="margin:0;font-size:11.5px;">This page will refresh automatically as soon as the review report is saved.</p>
        </div>
      `;
    } else if (pr.lastFailedJob) {
      document.getElementById('markdownContainer').innerHTML = `
        <div class="empty-card" style="margin:40px auto;max-width:680px;border-color:var(--sev-blocker-border);background:var(--sev-blocker-bg);">
          <h3 style="color:var(--sev-blocker);margin-top:0;">Last AI Review Attempt Failed</h3>
          <p class="meta-text" style="margin-bottom:10px;color:var(--text-primary);white-space:pre-wrap;text-align:left;font-family:var(--font-mono);font-size:12px;padding:10px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);">${escapeHtml(pr.lastFailedJob.error || 'Unknown error while running AI agent CLI.')}</p>
          <p class="meta-text" style="margin-bottom:14px;">Click <strong>Doctor</strong> in the top bar to verify your <code>gemini</code> / <code>claude</code> CLI installation and authentication.</p>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
            <button id="emptyCardRunReviewBtn" class="btn btn-primary btn-sm">Retry AI Review</button>
            <button id="emptyCardOpenDoctorBtn" class="btn btn-secondary btn-sm">Open Doctor &amp; Setup Check</button>
            <a href="${escapeHtml(pr.url)}" target="_blank" class="btn btn-secondary btn-sm">Open on GitHub ↗</a>
          </div>
        </div>
      `;
      document.getElementById('emptyCardOpenDoctorBtn')?.addEventListener('click', () => {
        openDoctorModal();
      });
    } else {
      document.getElementById('markdownContainer').innerHTML = `
        <div class="empty-card" style="margin:40px auto;">
          <h3>No local review file</h3>
          <p class="meta-text" style="margin-bottom:14px;">Status: ${escapeHtml(formatCleanStatus(pr.reviewStatus || pr.syncStatus || 'Pending'))}</p>
          <div style="display:flex;gap:8px;justify-content:center;">
            <button id="emptyCardRunReviewBtn" class="btn btn-primary btn-sm">Run AI Review Now</button>
            <a href="${escapeHtml(pr.url)}" target="_blank" class="btn btn-secondary btn-sm">Open on GitHub ↗</a>
          </div>
        </div>
      `;
    }
    document.getElementById('emptyCardRunReviewBtn')?.addEventListener('click', () => {
      triggerManualReviewForKey(pr.key);
    });
    // Still load any manual inline comments created on this PR
    try {
      const res = await fetch(`/api/review?key=${encodeURIComponent(pr.key)}`);
      if (state.selectedPrKey !== pr.key) return;
      if (res.ok) {
        state.currentReview = await res.json();
        if (state.selectedPrKey !== pr.key) return;
        state.selectedCommentCids = new Set(
          (state.currentReview.findings || [])
            .filter((f) => !f.posted && !f.dismissed)
            .map((f) => f.cid)
        );
        renderFindingsTab();
      } else {
        document.getElementById('findingsList').innerHTML = '';
        document.getElementById('tabFindingsCount').textContent = '0';
      }
    } catch {
      if (state.selectedPrKey !== pr.key) return;
      document.getElementById('findingsList').innerHTML = '';
      document.getElementById('tabFindingsCount').textContent = '0';
    }
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
        <strong style="font-size:12.5px;color:var(--text-primary);">Findings Summary (${findings.length})</strong>
        ${summaryPills}
      </div>
      <span class="meta-text">Click #ID to jump to details &middot; Click a file to open it in Diff</span>
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
                <a href="#report-finding-${idx}" class="finding-id-link qbar-jump-btn" data-idx="${idx}" title="Jump to detailed section ${escapeHtml(f.id)}">${escapeHtml(f.id)}</a>
                ${f.category ? `<span class="finding-cat-pill">${formatInlineCodeHtml(f.category)}</span>` : ''}
                <span class="report-finding-title">${formatInlineCodeHtml(f.title)}</span>
              </div>
              <div class="report-finding-meta">
                <div class="report-finding-loc">
                  ${
                    fullLoc
                      ? renderClickableBreadcrumbsHtml(f.filePath, f.startLine, 'finding')
                      : `<span class="meta-text">General PR scope</span>`
                  }
                </div>
                <div class="report-finding-actions">
                  <button class="btn btn-ghost btn-xs qbar-ask-btn" data-idx="${idx}" title="Ask agent about this finding">Ask Agent</button>
                  <button class="btn btn-ghost btn-xs qbar-add-rule-btn" data-idx="${idx}" title="Extract a permanent rule into reviewer-dna.md">+ Rule</button>
                  <button class="btn btn-ghost btn-xs qbar-dismiss-btn" data-idx="${idx}" title="Mark as false positive (updates false-positives.md)">${f.dismissed ? 'Dismissed' : 'False Positive'}</button>
                  <button class="btn btn-secondary btn-xs qbar-copy-btn" data-idx="${idx}">Copy MD</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;

  bindClickableBreadcrumbs(barEl);

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
        showToast(`Comment ${f.id} copied.`);
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
            ? `<button class="finding-file-btn rcard-file-btn" data-path="${escapeHtml(finding.filePath)}" data-line="${finding.startLine || ''}" title="View in Git Diff: ${escapeHtml(fullLoc)}">${renderFindingFileButtonInnerHtml(finding.filePath, finding.startLine)}</button>`
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
      summary.innerHTML = `<span>Ready-to-paste GitHub comment preview</span><span class="meta-text">Click to expand / collapse</span>`;
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
      showToast(`Comment ${finding.id} copied.`);
    });
  });
}

function renderClickableBreadcrumbsHtml(filePath, lineNum = null, context = 'diff', endLineNum = null) {
  if (!filePath) return '';
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  const repoLabel = pr?.repo || 'repo';
  const clean = String(filePath).replace(/^\/+/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return '';

  const fileName = parts[parts.length - 1];
  const folders = parts.slice(0, -1);
  const segments = [
    `<button type="button" class="crumb-segment" data-crumb-dir="" data-crumb-context="${escapeHtml(context)}" title="Repository root (${escapeHtml(repoLabel)})">${escapeHtml(repoLabel)}</button>`,
  ];

  let acc = '';
  for (const folder of folders) {
    acc = acc ? `${acc}/${folder}` : folder;
    segments.push(
      `<span class="crumb-sep">/</span><button type="button" class="crumb-segment" data-crumb-dir="${escapeHtml(acc)}" data-crumb-context="${escapeHtml(context)}" title="Filter by folder: ${escapeHtml(acc)}">${escapeHtml(folder)}</button>`
    );
  }

  const lineSuffix =
    lineNum && endLineNum && Number(endLineNum) > Number(lineNum)
      ? `:${lineNum}-${endLineNum}`
      : lineNum
      ? `:${lineNum}`
      : '';
  const fileDisplay = `${fileName}${lineSuffix}`;
  segments.push(
    `<span class="crumb-sep">/</span><button type="button" class="crumb-segment crumb-file" data-crumb-file="${escapeHtml(clean)}" data-crumb-line="${lineNum || ''}" data-crumb-context="${escapeHtml(context)}" title="${escapeHtml(clean)}${lineSuffix}">${escapeHtml(fileDisplay)}</button>`
  );

  return `<div class="clickable-breadcrumb-bar">${segments.join('')}</div>`;
}

function bindClickableBreadcrumbs(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.crumb-segment[data-crumb-dir]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dirPath = btn.dataset.crumbDir || '';
      const ctx = btn.dataset.crumbContext || 'diff';
      const pr = state.prs.find((p) => p.key === state.selectedPrKey);
      if (!pr) return;

      const diffFiles = state.currentDiff?.files || [];
      const matchingDiffFiles = dirPath
        ? diffFiles.filter((f) => f.filename === dirPath || f.filename.startsWith(dirPath + '/'))
        : diffFiles;

      if (matchingDiffFiles.length > 0) {
        state.diffFolderFilter = state.diffFolderFilter === dirPath ? '' : dirPath;
        if (state.fileTreeCollapsed) {
          state.fileTreeCollapsed = false;
          renderCollapsibleLayoutState();
        }
        if (ctx === 'finding' && state.activeTab !== 'diff' && !state.splitMode) {
          switchTab('diff');
        }
        renderDiffTree();
        if (
          state.diffFolderFilter &&
          (!state.selectedDiffFile || !state.selectedDiffFile.startsWith(dirPath + '/'))
        ) {
          selectDiffFile(matchingDiffFiles[0].filename, null);
        }
        showToast(
          state.diffFolderFilter
            ? `Tree filtered on ${dirPath} (${matchingDiffFiles.length} file${matchingDiffFiles.length > 1 ? 's' : ''})`
            : 'Folder filter cleared',
          2000
        );
      } else {
        showToast(`No modified files under: ${dirPath || pr.repo}`, 1800);
      }
    });
  });

  rootEl.querySelectorAll('.crumb-segment[data-crumb-file]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const filePath = btn.dataset.crumbFile || '';
      const lineNum = Number(btn.dataset.crumbLine) || null;
      const ctx = btn.dataset.crumbContext || 'diff';
      if (!filePath) return;

      if (ctx === 'finding' || ctx === 'overview') {
        navigateToCodeLocation(filePath, lineNum, 'diff');
      } else {
        await navigator.clipboard.writeText(filePath);
        showToast(`Path copied: ${filePath}`, 1800);
      }
    });
  });
}

async function saveManualInlineComment({
  cid = null,
  filePath,
  line,
  startLine = null,
  endLine = null,
  title,
  severity,
  comment,
}) {
  const prKey = state.selectedPrKey;
  if (!prKey || !comment) return null;
  const rawStart = Number(startLine ?? line) || 1;
  const rawEnd = Number(endLine ?? line ?? rawStart) || rawStart;
  const startLineNum = Math.max(1, Math.min(rawStart, rawEnd));
  const endLineNum = Math.max(startLineNum, Math.max(rawStart, rawEnd));

  const res = await fetch('/api/manual-comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prKey,
      cid,
      filePath,
      line: endLineNum,
      startLine: startLineNum,
      endLine: endLineNum,
      title,
      severity,
      comment,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save comment');

  const saved = data.comment;
  if (!state.currentReview) {
    state.currentReview = { file: null, archived: false, markdown: '', findings: [] };
  }
  const findings = state.currentReview.findings || [];
  const existingIdx = findings.findIndex((f) => f.cid === saved.cid);
  if (existingIdx >= 0) {
    findings[existingIdx] = saved;
  } else {
    findings.push(saved);
  }
  state.currentReview.findings = findings;
  state.selectedCommentCids.add(saved.cid);

  if (state.currentDiff) {
    const resolvedList = state.currentDiff.resolvedFindings || [];
    const resolvedEntry = {
      ...saved,
      resolvedPath: saved.filePath,
      resolvedStartLine:
        saved.startLine && saved.endLine && saved.startLine < saved.endLine
          ? saved.startLine
          : null,
      resolvedLine: saved.endLine || saved.startLine || 1,
      inDiff: true,
    };
    const rIdx = resolvedList.findIndex((f) => f.cid === saved.cid);
    if (rIdx >= 0) {
      resolvedList[rIdx] = resolvedEntry;
    } else {
      resolvedList.push(resolvedEntry);
    }
    state.currentDiff.resolvedFindings = resolvedList;
  }

  renderFindingsTab();
  renderReportFindingsQuickBar();
  loadState(true);
  return saved;
}

async function deleteManualInlineComment(cid) {
  const prKey = state.selectedPrKey;
  if (!prKey || !cid) return;
  const res = await fetch('/api/manual-comments', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prKey, cid }),
  });
  if (!res.ok) {
    showToast('Unable to delete manual comment');
    return;
  }

  if (state.currentReview?.findings) {
    state.currentReview.findings = state.currentReview.findings.filter((f) => f.cid !== cid);
  }
  if (state.currentDiff?.resolvedFindings) {
    state.currentDiff.resolvedFindings = state.currentDiff.resolvedFindings.filter(
      (f) => f.cid !== cid
    );
  }
  state.selectedCommentCids.delete(cid);
  renderFindingsTab();
  renderReportFindingsQuickBar();
  if (state.selectedDiffFile) {
    selectDiffFile(state.selectedDiffFile, state.highlightedLine);
  }
  loadState(true);
  showToast('Manual comment deleted.');
}

function highlightSelectedLineRange(tableEl, startLine, endLine) {
  if (!tableEl) return;
  const s = Math.min(Number(startLine) || 0, Number(endLine) || 0);
  const e = Math.max(Number(startLine) || 0, Number(endLine) || 0);
  tableEl.querySelectorAll('tr').forEach((tr) => {
    const rLine = Number(tr.dataset.rightLine || tr.dataset.blobLine || 0);
    if (rLine && s > 0 && rLine >= s && rLine <= e) {
      tr.classList.add('comment-range-selected');
    } else {
      tr.classList.remove('comment-range-selected');
    }
  });
}

function collectRangeCodeSnippet(tableEl, startLine, endLine) {
  if (!tableEl) return '';
  const s = Math.min(Number(startLine) || 1, Number(endLine) || 1);
  const e = Math.max(Number(startLine) || 1, Number(endLine) || 1);
  const lines = [];
  tableEl.querySelectorAll('tr').forEach((tr) => {
    const rLine = Number(tr.dataset.rightLine || tr.dataset.blobLine || 0);
    if (rLine >= s && rLine <= e) {
      const codeCell = tr.querySelector('.diff-line-code, .blob-line-code');
      if (codeCell) lines.push(codeCell.textContent || '');
    }
  });
  return lines.join('\n');
}

function openInlineCommentComposer({
  tableEl,
  anchorRow,
  filePath,
  lineNum,
  startLine = null,
  endLine = null,
  codeSnippet = '',
  existingFinding = null,
  colSpan = 3,
}) {
  if (!tableEl || !anchorRow || !filePath || !lineNum) return;

  // Remove any open composer in this table
  tableEl.querySelectorAll('tr.inline-comment-composer-row').forEach((r) => r.remove());

  const initStart = Math.max(
    1,
    Math.min(
      Number(startLine ?? existingFinding?.startLine ?? lineNum) || 1,
      Number(endLine ?? existingFinding?.endLine ?? lineNum) || 1
    )
  );
  const initEnd = Math.max(
    initStart,
    Math.max(
      Number(startLine ?? existingFinding?.startLine ?? lineNum) || 1,
      Number(endLine ?? existingFinding?.endLine ?? lineNum) || 1
    )
  );

  highlightSelectedLineRange(tableEl, initStart, initEnd);

  const baseName = filePath.split('/').pop() || filePath;
  const initRangeStr = initStart !== initEnd ? `${initStart}-${initEnd}` : `${initEnd}`;
  const defaultTitle =
    existingFinding?.title || `Comment on \`${baseName}:${initRangeStr}\``;
  const defaultSeverity = existingFinding?.severity || '🟡 Minor';
  const defaultBody = existingFinding?.customComment || '';

  const composerRow = document.createElement('tr');
  composerRow.className = 'inline-comment-composer-row';
  composerRow.innerHTML = `
    <td colspan="${colSpan}" class="inline-comment-composer-cell">
      <div class="inline-comment-composer">
        <div class="inline-comment-composer-header">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span id="inlineComposerHeaderLabel">${
              existingFinding
                ? `Edit ${escapeHtml(existingFinding.id)}`
                : `New comment on ${escapeHtml(baseName)}:${initRangeStr}`
            }</span>
            <span class="line-range-inputs" title="Select multiple lines with the mouse (drag or Shift+Click on line numbers) or adjust the line range here">
              <label>Start line <input id="inlineComposerStartLine" type="number" min="1" class="line-range-input" value="${initStart}" /></label>
              <span>&rarr;</span>
              <label>End line <input id="inlineComposerEndLine" type="number" min="1" class="line-range-input" value="${initEnd}" /></label>
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <select id="inlineComposerSeverity" class="diff-file-jump-select" style="min-width:120px;max-width:160px;">
              <option value="🟡 Minor" ${/minor/i.test(defaultSeverity) ? 'selected' : ''}>MINOR (Suggestion)</option>
              <option value="🟠 Major" ${/major/i.test(defaultSeverity) ? 'selected' : ''}>MAJOR (Important)</option>
              <option value="🔴 Blocker" ${/blocker/i.test(defaultSeverity) ? 'selected' : ''}>BLOCKER (Blocking)</option>
              <option value="🟢 Nit" ${/nit/i.test(defaultSeverity) ? 'selected' : ''}>NIT (Nitpick)</option>
              <option value="🔵 Question" ${/question/i.test(defaultSeverity) ? 'selected' : ''}>QUESTION</option>
            </select>
            <input id="inlineComposerTitle" type="text" class="search-input" style="width:280px;padding:4px 8px;font-size:11.5px;" value="${escapeHtml(defaultTitle)}" placeholder="Short comment title..." />
          </div>
        </div>
        <textarea id="inlineComposerTextarea" class="finding-textarea" rows="4" placeholder="Write your Markdown comment (or your question for the AI Agent)... Cmd+Enter to save to review.">${escapeHtml(defaultBody)}</textarea>
        <div class="inline-comment-composer-actions">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <button type="button" id="inlineComposerSaveBtn" class="btn btn-primary btn-sm">
              ${existingFinding ? 'Save changes' : 'Add to review (4. AI Proposals)'}
            </button>
            <button type="button" id="inlineComposerPostNowBtn" class="btn btn-secondary btn-sm" title="Publish this inline comment directly to GitHub">
              Post directly to GitHub
            </button>
            <button type="button" id="inlineComposerAskAiBtn" class="btn btn-ghost btn-sm" title="Open Agent Q&A targeted at this line range">
              Ask AI Agent (${escapeHtml(formatKeybindLabel(getKeybind('agentChat')))})
            </button>
          </div>
          <button type="button" id="inlineComposerCancelBtn" class="btn btn-ghost btn-sm">Cancel (Esc)</button>
        </div>
      </div>
    </td>
  `;

  anchorRow.insertAdjacentElement('afterend', composerRow);

  const textarea = composerRow.querySelector('#inlineComposerTextarea');
  const titleInput = composerRow.querySelector('#inlineComposerTitle');
  const sevSelect = composerRow.querySelector('#inlineComposerSeverity');
  const startInput = composerRow.querySelector('#inlineComposerStartLine');
  const endInput = composerRow.querySelector('#inlineComposerEndLine');
  const headerLabel = composerRow.querySelector('#inlineComposerHeaderLabel');
  textarea?.focus();

  const readCurrentRange = () => {
    const rawS = Number(startInput?.value) || initStart;
    const rawE = Number(endInput?.value) || rawS;
    const s = Math.max(1, Math.min(rawS, rawE));
    const e = Math.max(s, Math.max(rawS, rawE));
    return { startLine: s, endLine: e, rangeStr: s !== e ? `${s}-${e}` : `${e}` };
  };

  const syncRangeUi = () => {
    const { startLine: s, endLine: e, rangeStr } = readCurrentRange();
    highlightSelectedLineRange(tableEl, s, e);
    if (!existingFinding && headerLabel) {
      headerLabel.textContent = `New comment on ${baseName}:${rangeStr}`;
    }
    if (
      !existingFinding &&
      titleInput &&
      /^(?:Comment on|Commentaire sur) `[^`]+:\d+(?:-\d+)?`$/.test(titleInput.value.trim())
    ) {
      titleInput.value = `Comment on \`${baseName}:${rangeStr}\``;
    }
  };

  startInput?.addEventListener('input', syncRangeUi);
  endInput?.addEventListener('input', syncRangeUi);

  const closeComposer = () => {
    highlightSelectedLineRange(tableEl, 0, 0);
    composerRow.remove();
  };

  const handleSaveToReview = async () => {
    const body = textarea?.value.trim() || '';
    if (!body) {
      showToast('Please enter a comment before saving.');
      textarea?.focus();
      return;
    }
    const { startLine: s, endLine: e, rangeStr } = readCurrentRange();
    try {
      const saved = await saveManualInlineComment({
        cid: existingFinding?.cid || null,
        filePath,
        line: e,
        startLine: s,
        endLine: e,
        title: titleInput?.value.trim() || `Comment on \`${baseName}:${rangeStr}\``,
        severity: sevSelect?.value || '🟡 Minor',
        comment: body,
      });
      closeComposer();
      if (state.selectedDiffFile === filePath) {
        selectDiffFile(filePath, e);
      }
      showToast(`Comment ${saved.id} added to review (${baseName}:${rangeStr}).`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 4000);
    }
  };

  composerRow.querySelector('#inlineComposerSaveBtn')?.addEventListener('click', handleSaveToReview);

  composerRow.querySelector('#inlineComposerPostNowBtn')?.addEventListener('click', async () => {
    const body = textarea?.value.trim() || '';
    if (!body) {
      showToast('Please enter a comment before publishing to GitHub.');
      textarea?.focus();
      return;
    }
    const { startLine: s, endLine: e, rangeStr } = readCurrentRange();
    try {
      const saved = await saveManualInlineComment({
        cid: existingFinding?.cid || null,
        filePath,
        line: e,
        startLine: s,
        endLine: e,
        title: titleInput?.value.trim() || `Comment on \`${baseName}:${rangeStr}\``,
        severity: sevSelect?.value || '🟡 Minor',
        comment: body,
      });
      closeComposer();
      openSingleCommentModal(saved, 'inline');
    } catch (err) {
      showToast(`Error: ${err.message}`, 4000);
    }
  });

  composerRow.querySelector('#inlineComposerAskAiBtn')?.addEventListener('click', () => {
    const typedQuestion = textarea?.value.trim() || '';
    const { startLine: s, endLine: e, rangeStr } = readCurrentRange();
    const snippet = collectRangeCodeSnippet(tableEl, s, e) || codeSnippet;
    closeComposer();
    openChatWithFindingContext({
      id: `L${rangeStr}`,
      severity: '🔵 Question',
      title: `${s !== e ? `Lines ${rangeStr}` : `Line ${e}`} in ${baseName}`,
      filePath,
      startLine: s,
      endLine: e,
      customComment: snippet ? `Lines ${rangeStr}:\n\`\`\`\n${snippet}\n\`\`\`` : '',
    });
    if (typedQuestion) {
      const chatInput = document.getElementById('agentChatInput');
      if (chatInput) {
        chatInput.value = typedQuestion;
        chatInput.focus();
      }
    }
  });

  composerRow.querySelector('#inlineComposerCancelBtn')?.addEventListener('click', () => {
    closeComposer();
  });

  textarea?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      handleSaveToReview();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeComposer();
    }
  });
}

let _activeLineDragMouseUpHandler = null;

function getSelectedTextLineRange(tableEl) {
  if (!tableEl || typeof window.getSelection !== 'function') return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;

  const findRowNum = (node) => {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el || !tableEl.contains(el)) return 0;
    const tr = el.closest('tr[data-right-line], tr[data-blob-line]');
    return Number(tr?.dataset?.rightLine || tr?.dataset?.blobLine || 0);
  };

  const range = sel.getRangeAt(0);
  const startLine = findRowNum(range.startContainer);
  const endLine = findRowNum(range.endContainer);
  if (startLine > 0 && endLine > 0) {
    return {
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
    };
  }
  return null;
}

function bindMultiLineCommentSelection(tableEl, filePath, colSpan = 3) {
  if (!tableEl || !filePath) return;
  let dragStartLine = null;
  let dragCurrentLine = null;

  const findRowByLine = (lineNum) =>
    tableEl.querySelector(`tr[data-right-line="${lineNum}"], tr[data-blob-line="${lineNum}"]`);

  const openForRange = (lineA, lineB) => {
    const startLine = Math.min(lineA, lineB);
    const endLine = Math.max(lineA, lineB);
    const endRow = findRowByLine(endLine) || findRowByLine(startLine);
    if (!endRow) return;
    const snippet = collectRangeCodeSnippet(tableEl, startLine, endLine);
    openInlineCommentComposer({
      tableEl,
      anchorRow: endRow,
      filePath,
      lineNum: endLine,
      startLine,
      endLine,
      codeSnippet: snippet,
      colSpan,
    });
  };

  tableEl.querySelectorAll('.commentable-line').forEach((cell) => {
    cell.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const lineNum = Number(cell.dataset.commentLine);
      if (!lineNum) return;

      // Prevent native browser text selection so dragging across line numbers or '+' buttons always tracks smoothly
      ev.preventDefault();
      ev.stopPropagation();

      if (
        ev.shiftKey &&
        state.lineRangeAnchor &&
        state.lineRangeAnchor.filePath === filePath &&
        state.lineRangeAnchor.line
      ) {
        dragStartLine = state.lineRangeAnchor.line;
        dragCurrentLine = lineNum;
        state.isDraggingLineRange = true;
        highlightSelectedLineRange(tableEl, dragStartLine, dragCurrentLine);
        return;
      }

      const textSelRange = getSelectedTextLineRange(tableEl);
      if (
        textSelRange &&
        textSelRange.endLine > textSelRange.startLine &&
        lineNum >= textSelRange.startLine &&
        lineNum <= textSelRange.endLine
      ) {
        dragStartLine = textSelRange.startLine;
        dragCurrentLine = textSelRange.endLine;
        state.isDraggingLineRange = true;
        highlightSelectedLineRange(tableEl, dragStartLine, dragCurrentLine);
        return;
      }

      dragStartLine = lineNum;
      dragCurrentLine = lineNum;
      state.isDraggingLineRange = true;
      highlightSelectedLineRange(tableEl, lineNum, lineNum);
    });
  });

  // Track mouse movement across ANY part of the table rows while dragging
  tableEl.addEventListener('mouseover', (ev) => {
    if (!state.isDraggingLineRange || !dragStartLine) return;
    const row = ev.target?.closest?.('tr[data-right-line], tr[data-blob-line]');
    const lineNum = Number(row?.dataset?.rightLine || row?.dataset?.blobLine || 0);
    if (!lineNum || lineNum === dragCurrentLine) return;
    dragCurrentLine = lineNum;
    highlightSelectedLineRange(tableEl, dragStartLine, dragCurrentLine);
  });

  // Also support selecting multiple lines directly in the code column: on mouseup, open composer for the selected lines
  tableEl.addEventListener('mouseup', () => {
    if (state.isDraggingLineRange) return;
    setTimeout(() => {
      const selRange = getSelectedTextLineRange(tableEl);
      if (selRange && selRange.endLine > selRange.startLine) {
        state.lineRangeAnchor = { filePath, line: selRange.startLine };
        openForRange(selRange.startLine, selRange.endLine);
      }
    }, 10);
  });

  if (_activeLineDragMouseUpHandler) {
    window.removeEventListener('mouseup', _activeLineDragMouseUpHandler);
  }

  _activeLineDragMouseUpHandler = () => {
    if (!state.isDraggingLineRange || !dragStartLine) return;
    const s = dragStartLine;
    const e = dragCurrentLine || dragStartLine;
    state.isDraggingLineRange = false;
    dragStartLine = null;
    dragCurrentLine = null;
    state.lineRangeAnchor = { filePath, line: Math.min(s, e) };
    openForRange(s, e);
  };

  window.addEventListener('mouseup', _activeLineDragMouseUpHandler);
}

function navigateToCodeLocation(filePath, line = null, preferredView = 'diff') {
  if (syncChannel && !isPopoutWindow) {
    syncChannel.postMessage({
      type: 'OPEN_FILE',
      prKey: state.selectedPrKey,
      filePath,
      line,
      view: 'diff',
    });
  }

  if (state.splitMode) {
    if (state.splitLeftTab !== 'diff' && state.splitRightTab !== 'diff') {
      setSplitRightPanel('diff');
    }
  } else {
    switchTab('diff');
  }
  openFileInDiffViewer(filePath, line);
}

function renderFindingsTab() {
  const findings = state.currentReview?.findings || [];
  document.getElementById('tabFindingsCount').textContent = findings.length;
  const listEl = document.getElementById('findingsList');

  const postedCount = findings.filter((f) => f.posted).length;
  const dismissedCount = findings.filter((f) => f.dismissed).length;
  document.getElementById('commentsSummaryStats').textContent =
    `${postedCount}/${findings.length} posted` +
    (dismissedCount > 0 ? ` · ${dismissedCount} false positive(s)` : '');

  if (findings.length === 0) {
    listEl.innerHTML = `<div class="empty-card" style="margin:32px auto;"><p>No AI comment proposals or manual drafts for this PR. Click or drag on line numbers in <strong>3. Git Diff</strong> to write a comment on one or more lines.</p></div>`;
    return;
  }

  listEl.innerHTML = findings
    .map((f, idx) => {
      const isSelected = state.selectedCommentCids.has(f.cid);
      const sev = getSeverityMeta(f.severity);
      const lineRangeLabel =
        f.startLine && f.endLine && Number(f.endLine) > Number(f.startLine)
          ? `:${f.startLine}-${f.endLine}`
          : f.startLine
          ? `:${f.startLine}`
          : '';
      const fullLocation = f.filePath
        ? `${f.filePath}${lineRangeLabel}`
        : 'General PR comment';

      return `
        <div class="finding-card ${sev.cardClass} ${f.posted ? 'posted' : ''}" data-cid="${escapeHtml(f.cid)}" data-idx="${idx}" style="${f.dismissed ? 'opacity:0.5;' : ''}">
          <div class="finding-card-header">
            <div class="finding-header-left">
              <input
                type="checkbox"
                class="finding-select-cb"
                data-cid="${escapeHtml(f.cid)}"
                ${isSelected ? 'checked' : ''}
                title="Include in batch review submission"
              />
              <span class="badge ${sev.badgeClass}">${escapeHtml(sev.label)}</span>
              <span class="finding-id">${escapeHtml(f.id)}</span>
              ${f.category ? `<span class="finding-cat-pill">${formatInlineCodeHtml(f.category)}</span>` : ''}
              <span class="finding-title">${formatInlineCodeHtml(f.title)}</span>
              ${f.dismissed ? `<span class="badge">FALSE POSITIVE</span>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              ${
                f.filePath
                  ? `${renderClickableBreadcrumbsHtml(f.filePath, f.startLine, 'finding', f.endLine)}`
                  : `<span class="meta-text">${escapeHtml(fullLocation)}</span>`
              }
              <label class="checkbox-label">
                <input type="checkbox" class="finding-posted-cb" data-cid="${escapeHtml(f.cid)}" ${f.posted ? 'checked' : ''} />
                <span>Posted</span>
              </label>
            </div>
          </div>

          <div class="finding-body">
            <textarea class="finding-textarea" data-cid="${escapeHtml(f.cid)}">${escapeHtml(f.customComment)}</textarea>

            <div class="finding-actions">
              <div class="finding-actions-left">
                <button class="btn btn-secondary btn-sm copy-comment-btn" data-idx="${idx}">
                  Copy Markdown
                </button>
                <button class="btn btn-ghost btn-sm ask-agent-finding-btn" data-idx="${idx}">
                  Ask Agent
                </button>
                <button class="btn btn-ghost btn-sm add-rule-finding-btn" data-idx="${idx}" title="Add this pattern as a permanent agent rule">
                  + Rule
                </button>
                ${
                  f.isManual
                    ? `<button class="btn btn-ghost btn-sm delete-manual-finding-btn" data-cid="${escapeHtml(f.cid)}" title="Delete this manual comment">
                        Delete
                      </button>`
                    : `<button class="btn btn-ghost btn-sm dismiss-finding-btn" data-idx="${idx}">
                        False Positive
                      </button>
                      <button class="btn btn-ghost btn-sm reset-comment-btn" data-idx="${idx}">
                        Reset
                      </button>`
                }
              </div>
              <div class="finding-actions-right">
                ${
                  f.filePath
                    ? `<button class="btn btn-primary btn-sm post-inline-btn" data-idx="${idx}">
                        Post inline
                      </button>`
                    : ''
                }
                <button class="btn btn-secondary btn-sm post-general-btn" data-idx="${idx}">
                  Post general
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  bindClickableBreadcrumbs(listEl);

  listEl.querySelectorAll('.delete-manual-finding-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      deleteManualInlineComment(btn.dataset.cid);
    });
  });

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
      showToast(`Comment ${f.id} copied.`);
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
      showToast(`Text for ${f.id} reset.`);
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

async function loadDiffForCurrentPr(pr, forceRefresh = false) {
  if (!pr || state.selectedPrKey !== pr.key) return;
  const treeEl = document.getElementById('diffFileTree');
  const viewerEl = document.getElementById('diffViewerContainer');
  const cacheKey = getPrClientCacheKey(pr);

  const applyDiffData = (data) => {
    if (state.selectedPrKey !== pr.key) return;
    state.currentDiff = data;
    const files = data.files || [];
    document.getElementById('tabFilesCount').textContent = files.length;
    renderDiffTree();

    const hasValidSelected =
      Boolean(state.selectedDiffFile) &&
      files.some((f) => f.filename === state.selectedDiffFile);

    if (files.length > 0 && !hasValidSelected) {
      const fileWithFinding = data.resolvedFindings?.find(
        (f) => f.inDiff && f.resolvedPath && files.some((df) => df.filename === f.resolvedPath)
      )?.resolvedPath;
      selectDiffFile(fileWithFinding || files[0].filename, null);
    } else if (hasValidSelected) {
      selectDiffFile(state.selectedDiffFile, state.highlightedLine);
    } else {
      viewerEl.innerHTML = `<div class="empty-state meta-text">No files in diff.</div>`;
    }
  };

  if (!forceRefresh && state.prDiffCache[cacheKey]) {
    applyDiffData(state.prDiffCache[cacheKey]);
    return;
  }

  if (!state.currentDiff) {
    treeEl.innerHTML = `<div class="empty-state meta-text" style="padding:16px;">Loading files...</div>`;
    viewerEl.innerHTML = `<div class="empty-state meta-text">Loading diff...</div>`;
  }

  try {
    const res = await fetch(
      `/api/diff?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&reviewFile=${encodeURIComponent(pr.reviewFile || '')}`
    );
    if (!res.ok) throw new Error('Error fetching GitHub diff');
    const data = await res.json();
    state.prDiffCache[cacheKey] = data;
    if (state.selectedPrKey !== pr.key) return;
    applyDiffData(data);
  } catch (err) {
    if (state.selectedPrKey === pr.key && !state.currentDiff) {
      treeEl.innerHTML = `<div class="empty-state meta-text" style="padding:16px;">${escapeHtml(err.message)}</div>`;
    }
  }
}

function getFileStatusMeta(status) {
  const s = String(status || 'modified').toLowerCase();
  if (s === 'added') {
    return { code: 'A', cls: 'status-added', title: 'Added file' };
  }
  if (s === 'removed' || s === 'deleted') {
    return { code: 'D', cls: 'status-removed', title: 'Deleted file' };
  }
  if (s === 'renamed') {
    return { code: 'R', cls: 'status-renamed', title: 'Renamed file' };
  }
  return { code: 'M', cls: 'status-modified', title: 'Modified file' };
}

function getFileExtMeta(filename) {
  const clean = String(filename || '').toLowerCase();
  const base = clean.split('/').pop() || '';
  const dotIdx = base.lastIndexOf('.');
  const ext = dotIdx >= 0 ? base.slice(dotIdx + 1) : '';
  if (ext === 'php') return { label: 'PHP', cls: 'ext-php', hljsLang: 'php' };
  if (ext === 'feature') return { label: 'FEATURE', cls: 'ext-feature', hljsLang: 'gherkin' };
  if (ext === 'ts' || ext === 'tsx') return { label: 'TS', cls: 'ext-ts', hljsLang: 'typescript' };
  if (ext === 'vue') return { label: 'VUE', cls: 'ext-vue', hljsLang: 'xml' };
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return { label: 'JS', cls: 'ext-js', hljsLang: 'javascript' };
  if (ext === 'json') return { label: 'JSON', cls: 'ext-json', hljsLang: 'json' };
  if (ext === 'yaml' || ext === 'yml') return { label: 'YAML', cls: 'ext-yaml', hljsLang: 'yaml' };
  if (ext === 'sql') return { label: 'SQL', cls: 'ext-sql', hljsLang: 'sql' };
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return { label: 'SH', cls: 'ext-sh', hljsLang: 'bash' };
  if (ext === 'css' || ext === 'scss') return { label: 'CSS', cls: 'ext-css', hljsLang: 'css' };
  if (ext === 'xml' || ext === 'html' || ext === 'twig') return { label: ext.toUpperCase() || 'XML', cls: 'ext-xml', hljsLang: 'xml' };
  if (ext === 'md' || ext === 'markdown') return { label: 'MD', cls: 'ext-md', hljsLang: 'markdown' };
  return { label: ext ? ext.slice(0, 6).toUpperCase() : 'FILE', cls: '', hljsLang: null };
}

function renderFindingFileButtonInnerHtml(filePath, startLine = null) {
  const short = formatShortFilePath(filePath, null);
  const parts = short.split('/');
  const base = parts.pop() || short;
  const dir = parts.length > 0 ? `${parts.join('/')}/` : '';
  const lineStr = startLine ? `:${startLine}` : '';
  return `${dir ? `<span class="finding-file-dir">${escapeHtml(dir)}</span>` : ''}<span class="finding-file-basename">${escapeHtml(base + lineStr)}</span>`;
}

function highlightDiffCodeLine(codeText, filename = state.selectedDiffFile) {
  const raw = String(codeText ?? '');
  if (!raw) return '<span class="diff-line-prefix"> </span><span class="diff-line-syntax"></span>';
  const firstChar = raw.charAt(0);
  const hasDiffPrefix = firstChar === '+' || firstChar === '-' || firstChar === ' ';
  const prefix = hasDiffPrefix ? firstChar : ' ';
  const body = hasDiffPrefix ? raw.slice(1) : raw;

  let highlighted = escapeHtml(body);
  const extMeta = getFileExtMeta(filename);
  const lang = extMeta.hljsLang;
  if (
    body.trim().length > 0 &&
    lang &&
    typeof window !== 'undefined' &&
    window.hljs &&
    typeof window.hljs.highlight === 'function'
  ) {
    try {
      if (!window.hljs.getLanguage || window.hljs.getLanguage(lang)) {
        highlighted = window.hljs.highlight(body, { language: lang, ignoreIllegals: true }).value;
      }
    } catch {
      highlighted = escapeHtml(body);
    }
  }
  return `<span class="diff-line-prefix">${escapeHtml(prefix)}</span><span class="diff-line-syntax">${highlighted}</span>`;
}

function renderDiffFileItemHtml(file, resolvedFindings, showSubPath = true) {
  const isSelected = file.filename === state.selectedDiffFile;
  const fileFindings = resolvedFindings.filter(
    (f) => f.resolvedPath === file.filename && !f.dismissed
  );
  const findingBadge =
    fileFindings.length > 0
      ? `<span class="badge badge-severity-major">${fileFindings.length}</span>`
      : '';
  const shortPath = file.filename.replace(/^projects\/services\//, '');
  const parts = shortPath.split('/');
  const baseName = parts.pop() || shortPath;
  const dirSub = parts.join('/');
  const statusMeta = getFileStatusMeta(file.status);

  return `
    <div class="diff-file-item ${isSelected ? 'active' : ''}" data-filename="${escapeHtml(file.filename)}" title="${escapeHtml(file.filename)} (${escapeHtml(statusMeta.title)})">
      <div class="diff-file-item-info">
        <div class="diff-file-name-row">
          <span class="file-status-badge ${statusMeta.cls}" title="${escapeHtml(statusMeta.title)}">${escapeHtml(statusMeta.code)}</span>
          <span class="diff-file-name">${escapeHtml(baseName)}</span>
        </div>
        ${showSubPath && dirSub ? `<span class="diff-file-path-sub">${escapeHtml(dirSub)}</span>` : ''}
      </div>
      <div class="diff-stats">
        ${findingBadge}
        <span class="stat-add">+${file.additions}</span>
        <span class="stat-del">-${file.deletions}</span>
      </div>
    </div>
  `;
}

function renderDiffTree() {
  const treeEl = document.getElementById('diffFileTree');
  if (!treeEl) return;
  const allFiles = state.currentDiff?.files || [];
  const resolvedFindings = state.currentDiff?.resolvedFindings || [];

  const activeFilter = state.diffFolderFilter || '';
  const files = activeFilter
    ? allFiles.filter(
        (f) => f.filename === activeFilter || f.filename.startsWith(activeFilter + '/')
      )
    : allFiles;

  const isTreeMode = state.diffTreeMode !== 'list';

  const toolbarHtml = `
    <div class="diff-tree-toolbar">
      <span class="meta-text" style="font-weight:600;">${files.length}/${allFiles.length} file${files.length > 1 ? 's' : ''}</span>
      <div style="display:flex;align-items:center;gap:4px;">
        <button type="button" id="diffTreeToggleModeBtn" class="btn btn-ghost btn-xs" title="Toggle between collapsible folder view and flat list">
          ${isTreeMode ? 'Folder View' : 'List View'}
        </button>
        ${
          isTreeMode
            ? `<button type="button" id="diffTreeExpandCollapseAllBtn" class="btn btn-ghost btn-xs" title="Collapse all / Expand all">
                ${state.diffCollapsedFolders.size > 0 ? 'Expand' : 'Collapse'}
              </button>`
            : ''
        }
      </div>
    </div>
    ${
      activeFilter
        ? `<div class="diff-folder-filter-banner">
            <span style="word-break:break-all;">Folder: <strong>${escapeHtml(activeFilter.replace(/^projects\/services\//, ''))}</strong></span>
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <button type="button" id="diffClearFolderFilterBtn" class="btn btn-secondary btn-xs" title="Show all modified files">&times;</button>
            </div>
          </div>`
        : ''
    }
  `;

  let bodyHtml = '';
  if (!isTreeMode) {
    bodyHtml = files.map((file) => renderDiffFileItemHtml(file, resolvedFindings, true)).join('');
  } else {
    // Group files by directory path so every folder can be collapsed/expanded and full names are visible
    const groups = new Map();
    for (const file of files) {
      const shortPath = file.filename.replace(/^projects\/services\//, '');
      const lastSlash = shortPath.lastIndexOf('/');
      const folderKey = lastSlash >= 0 ? shortPath.slice(0, lastSlash) : '(root)';
      const fullFolder =
         file.filename.lastIndexOf('/') >= 0
          ? file.filename.slice(0, file.filename.lastIndexOf('/'))
          : '';
      if (!groups.has(folderKey)) {
        groups.set(folderKey, { folderKey, fullFolder, files: [] });
      }
      groups.get(folderKey).files.push(file);
    }

    bodyHtml = Array.from(groups.values())
      .map((grp) => {
        const isCollapsed = state.diffCollapsedFolders.has(grp.folderKey);
        const itemsHtml = grp.files
          .map((file) => renderDiffFileItemHtml(file, resolvedFindings, false))
          .join('');
        return `
          <div class="diff-folder-group ${isCollapsed ? 'collapsed' : ''}" data-folder-key="${escapeHtml(grp.folderKey)}">
            <div class="diff-folder-header" data-folder-key="${escapeHtml(grp.folderKey)}" title="Click to collapse / expand folder ${escapeHtml(grp.folderKey)}">
              <span class="diff-folder-header-title">
                <span>${isCollapsed ? '▸' : '▾'}</span>
                <span>${escapeHtml(grp.folderKey)}</span>
              </span>
              <span class="meta-text" style="flex-shrink:0;">${grp.files.length}</span>
            </div>
            <div class="diff-folder-children">
              ${itemsHtml}
            </div>
          </div>
        `;
      })
      .join('');
  }

  treeEl.innerHTML = toolbarHtml + bodyHtml;

  document.getElementById('diffTreeToggleModeBtn')?.addEventListener('click', () => {
    state.diffTreeMode = state.diffTreeMode === 'list' ? 'tree' : 'list';
    try {
      localStorage.setItem('prHub.diffTreeMode', state.diffTreeMode);
    } catch {
      // Ignore storage errors
    }
    renderDiffTree();
  });

  document.getElementById('diffTreeExpandCollapseAllBtn')?.addEventListener('click', () => {
    if (state.diffCollapsedFolders.size > 0) {
      state.diffCollapsedFolders.clear();
    } else {
      treeEl.querySelectorAll('.diff-folder-group').forEach((el) => {
        if (el.dataset.folderKey) state.diffCollapsedFolders.add(el.dataset.folderKey);
      });
    }
    renderDiffTree();
  });

  document.getElementById('diffClearFolderFilterBtn')?.addEventListener('click', () => {
    state.diffFolderFilter = '';
    renderDiffTree();
  });

  treeEl.querySelectorAll('.diff-folder-header').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const key = hdr.dataset.folderKey;
      if (!key) return;
      if (state.diffCollapsedFolders.has(key)) {
        state.diffCollapsedFolders.delete(key);
      } else {
        state.diffCollapsedFolders.add(key);
      }
      renderDiffTree();
    });
  });

  treeEl.querySelectorAll('.diff-file-item').forEach((item) => {
    item.addEventListener('click', () => {
      selectDiffFile(item.dataset.filename, null);
    });
  });
}

function selectDiffFile(filename, highlightLine = null) {
  const viewerEl = document.getElementById('diffViewerContainer');
  const files = state.currentDiff?.files || [];
  let fileObj = files.find((f) => f.filename === filename);

  // If the requested file is not in the current PR's diff (e.g. stale selection), fall back to the first valid file
  if (!fileObj && files.length > 0) {
    const fileWithFinding = (state.currentDiff?.resolvedFindings || []).find(
      (f) => f.inDiff && f.resolvedPath && files.some((df) => df.filename === f.resolvedPath)
    )?.resolvedPath;
    fileObj = files.find((f) => f.filename === fileWithFinding) || files[0];
    filename = fileObj.filename;
    highlightLine = null;
  }

  state.selectedDiffFile = filename;
  state.highlightedLine = highlightLine;
  state.activeHunkIndex = -1;
  renderDiffTree();

  // Keep active file item visible in the file tree sidebar
  const activeTreeItem = document.querySelector('#diffFileTree .diff-file-item.active');
  activeTreeItem?.scrollIntoView({ block: 'nearest' });

  if (!fileObj) {
    viewerEl.innerHTML = `<div class="empty-state meta-text">No files in diff.</div>`;
    return;
  }

  const fileFindings = (state.currentDiff?.resolvedFindings || []).filter(
    (f) => f.resolvedPath === filename && !f.dismissed
  );
  const fileThreads = (state.currentOverview?.reviewThreads || []).filter(
    (t) =>
      t.path === filename ||
      filename.endsWith('/' + t.path) ||
      t.path.endsWith('/' + filename)
  );

  const cacheKey = `${state.selectedPrKey || ''}::${filename}`;
  const blobLines = state.diffBlobCache[cacheKey] || null;
  const expandedRanges = state.diffExpandedRanges[cacheKey] || [];
  const hasFullFileExpanded =
    blobLines &&
    expandedRanges.some((r) => r.startRight <= 1 && r.endRight >= blobLines.length);

  const rowsHtml = renderPatchTableRows(
    fileObj.patch || '',
    fileFindings,
    highlightLine,
    filename,
    fileThreads
  );
  const fileIdx = files.findIndex((f) => f.filename === filename);
  const prevFile = fileIdx > 0 ? files[fileIdx - 1] : null;
  const nextFile = fileIdx >= 0 && fileIdx < files.length - 1 ? files[fileIdx + 1] : null;

  const bLbl = formatKeybindLabel(getKeybind('toggleFiles'));
  const zLbl = formatKeybindLabel(getKeybind('focusDiff'));
  const cLbl = formatKeybindLabel(getKeybind('agentChat'));
  const statusMeta = getFileStatusMeta(fileObj.status);

  viewerEl.innerHTML = `
    <div class="diff-file-header">
      <div class="diff-file-header-identity">
        <div class="diff-file-identity-left">
          <span class="file-status-badge ${statusMeta.cls}" title="${escapeHtml(statusMeta.title)}">${escapeHtml(statusMeta.code)}</span>
          ${renderClickableBreadcrumbsHtml(fileObj.filename, null, 'diff')}
          <button id="diffCopyPathBtn" class="btn btn-ghost btn-xs" style="flex-shrink:0;" title="Copy full path: ${escapeHtml(fileObj.filename)}">Copy path</button>
        </div>
        <div class="diff-stats" style="flex-shrink:0;">
          <span class="stat-add">+${fileObj.additions}</span>
          <span class="stat-del">-${fileObj.deletions}</span>
        </div>
      </div>
      <div class="diff-file-header-toolbar">
        <div class="diff-file-header-main">
          <button id="diffToggleFilesInlineBtn" class="btn ${state.fileTreeCollapsed ? 'btn-primary' : 'btn-secondary'} btn-xs" title="Show / Hide modified files tree (shortcut: ${escapeHtml(bLbl)})">
            ${state.fileTreeCollapsed ? `Files (${files.length}) (${escapeHtml(bLbl)})` : `Hide Files (${escapeHtml(bLbl)})`}
          </button>
          <div class="diff-nav-group">
            <button id="diffPrevFileBtn" class="btn btn-xs" ${prevFile ? '' : 'disabled'} title="Previous file">&larr;</button>
            <span class="diff-nav-counter">${fileIdx + 1}/${files.length}</span>
            <button id="diffNextFileBtn" class="btn btn-xs" ${nextFile ? '' : 'disabled'} title="Next file">&rarr;</button>
          </div>
        </div>
        <div class="diff-file-header-actions">
          <div class="diff-zoom-group" title="Zoom in / out in diff">
            <button id="diffZoomOutBtn" class="btn btn-xs" title="Zoom out (-)">&minus;</button>
            <button id="diffZoomResetBtn" class="btn btn-xs diff-zoom-label" title="Reset zoom to 100% (0)">${state.diffZoom}%</button>
            <button id="diffZoomInBtn" class="btn btn-xs" title="Zoom in (+)">+</button>
          </div>
          <button id="diffExpandAllContextBtn" class="btn ${expandedRanges.length > 0 ? 'btn-primary' : 'btn-ghost'} btn-xs" title="Expand or collapse all unchanged lines of this file directly in the diff">
            ${hasFullFileExpanded ? 'Collapse context' : '&uarr;&darr; All'}
          </button>
          <div class="diff-hunk-nav-group" title="Navigate between changes (hunks / findings)">
            <button id="diffPrevHunkBtn" class="btn btn-xs" title="Previous Hunk / Finding in this file">&uarr;</button>
            <button id="diffNextHunkBtn" class="btn btn-xs" title="Next Hunk / Finding in this file">&darr;</button>
          </div>
          <button id="diffOpenChatInlineBtn" class="btn ${state.chatOpen ? 'btn-primary' : 'btn-ghost'} btn-xs" title="Ask AI about this file">Q&amp;A (${escapeHtml(cLbl)})</button>
          <button id="diffToggleFocusInlineBtn" class="btn ${state.focusDiffMode ? 'btn-primary' : 'btn-secondary'} btn-xs" title="Show / Hide PR header and tabs">
            ${state.focusDiffMode ? `Exit Focus (${escapeHtml(zLbl)})` : `Focus (${escapeHtml(zLbl)})`}
          </button>
        </div>
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

  bindClickableBreadcrumbs(viewerEl);
  syncKeybindingLegends();

  document.getElementById('diffZoomOutBtn')?.addEventListener('click', () => {
    adjustDiffZoom(-1);
  });
  document.getElementById('diffZoomResetBtn')?.addEventListener('click', () => {
    applyDiffZoomVariables(100);
  });
  document.getElementById('diffZoomInBtn')?.addEventListener('click', () => {
    adjustDiffZoom(1);
  });

  document.getElementById('diffCopyPathBtn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(fileObj.filename);
    showToast(`Path copied: ${fileObj.filename}`);
  });

  document.getElementById('diffExpandAllContextBtn')?.addEventListener('click', () => {
    toggleExpandAllDiffContext(fileObj.filename);
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

  document.getElementById('diffOpenChatInlineBtn')?.addEventListener('click', () => {
    toggleChatDrawer();
  });

  if (state.chatOpen) {
    renderAgentContextBanner();
  }

  // Bind multi-line selection (drag, Shift+Click, or single click) on line numbers / '+' buttons
  const diffTable = viewerEl.querySelector('.diff-table');
  bindMultiLineCommentSelection(diffTable, fileObj.filename, 3);
  bindGitHubThreadActionListeners(viewerEl);

  viewerEl.querySelectorAll('.diff-edit-manual-finding-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = btn.dataset.cid;
      const f = fileFindings.find((x) => x.cid === cid);
      const row = btn.closest('tr');
      if (f && row && diffTable) {
        openInlineCommentComposer({
          tableEl: diffTable,
          anchorRow: row,
          filePath: fileObj.filename,
          lineNum: Number(f.resolvedLine || f.endLine || f.startLine || 1),
          startLine: Number(f.startLine || f.resolvedLine || 1),
          endLine: Number(f.endLine || f.resolvedLine || f.startLine || 1),
          existingFinding: f,
          colSpan: 3,
        });
      }
    });
  });

  viewerEl.querySelectorAll('.diff-delete-manual-finding-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      deleteManualInlineComment(btn.dataset.cid);
    });
  });

  viewerEl.querySelectorAll('.diff-copy-finding-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cid = btn.dataset.cid;
      const f = fileFindings.find((x) => x.cid === cid);
      if (f) {
        await navigator.clipboard.writeText(f.customComment);
        showToast(`Comment ${f.id} copied.`);
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

  viewerEl.querySelectorAll('.diff-expand-range-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const startRight = Number(btn.dataset.startRight);
      const endRight = Number(btn.dataset.endRight);
      const startLeft = Number(btn.dataset.startLeft);
      const endLeft = Number(btn.dataset.endLeft);
      if (!startRight || !endRight || endRight < startRight) return;
      btn.disabled = true;
      await expandDiffContextRange(fileObj.filename, {
        startRight,
        endRight,
        startLeft,
        endLeft,
      });
    });
  });

  viewerEl.querySelectorAll('.diff-expand-eof-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const startRight = Number(btn.dataset.startRight);
      const startLeft = Number(btn.dataset.startLeft);
      const step = Number(btn.dataset.step) || 0;
      if (!startRight) return;
      btn.disabled = true;
      await expandDiffContextToEof(fileObj.filename, startRight, startLeft, step);
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
    showToast(delta < 0 ? 'First file in diff.' : 'Last file in diff.', 1400);
    return false;
  }
  const targetFile = files[targetIdx];
  selectDiffFile(targetFile.filename, null);
  return true;
}

function jumpToRelativeHunk(delta) {
  const viewerEl = document.getElementById('diffViewerContainer');
  if (!viewerEl) return;
  const targets = Array.from(
    viewerEl.querySelectorAll('tr.diff-row-hunk, td.diff-inline-finding, td.diff-github-thread')
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

async function ensureDiffFileBlobLoaded(filename) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr || !filename) return null;
  const cacheKey = `${pr.key}::${filename}`;
  if (state.diffBlobCache[cacheKey]) {
    return state.diffBlobCache[cacheKey];
  }

  try {
    const res = await fetch(
      `/api/blob?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}&sha=${encodeURIComponent(pr.headRefOid || '')}&path=${encodeURIComponent(filename)}`
    );
    if (!res.ok) throw new Error('Unable to load full file content');
    const data = await res.json();
    const rawLines = String(data.content ?? '').split('\n');
    if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    state.diffBlobCache[cacheKey] = rawLines;
    return rawLines;
  } catch (err) {
    showToast(err.message || 'Unable to load unchanged lines');
    return null;
  }
}

function addDiffExpandedRange(cacheKey, newRange) {
  const existing = state.diffExpandedRanges[cacheKey] || [];
  const list = [...existing, newRange].sort((a, b) => a.startRight - b.startRight);
  const merged = [];
  for (const r of list) {
    if (merged.length === 0) {
      merged.push({ ...r });
    } else {
      const prev = merged[merged.length - 1];
      if (r.startRight <= prev.endRight + 1) {
        if (r.endRight > prev.endRight) {
          prev.endRight = r.endRight;
          prev.endLeft = r.endLeft;
        }
      } else {
        merged.push({ ...r });
      }
    }
  }
  state.diffExpandedRanges[cacheKey] = merged;
}

async function expandDiffContextRange(filename, range) {
  const scrollArea = document.getElementById('diffScrollArea');
  const prevScrollTop = scrollArea ? scrollArea.scrollTop : 0;

  const blobLines = await ensureDiffFileBlobLoaded(filename);
  if (!blobLines) return;

  const cacheKey = `${state.selectedPrKey || ''}::${filename}`;
  const clampedStartRight = Math.max(1, range.startRight);
  const clampedEndRight = Math.min(blobLines.length, range.endRight);
  if (clampedEndRight >= clampedStartRight) {
    const deltaStart = clampedStartRight - range.startRight;
    const clampedStartLeft = Math.max(1, (range.startLeft || clampedStartRight) + deltaStart);
    const clampedEndLeft = clampedStartLeft + (clampedEndRight - clampedStartRight);
    addDiffExpandedRange(cacheKey, {
      startRight: clampedStartRight,
      endRight: clampedEndRight,
      startLeft: clampedStartLeft,
      endLeft: clampedEndLeft,
    });
  }

  selectDiffFile(filename, state.highlightedLine);
  const newScrollArea = document.getElementById('diffScrollArea');
  if (newScrollArea) {
    newScrollArea.scrollTop = prevScrollTop;
  }
}

async function expandDiffContextToEof(filename, startRight, startLeft, step = 0) {
  const scrollArea = document.getElementById('diffScrollArea');
  const prevScrollTop = scrollArea ? scrollArea.scrollTop : 0;

  const blobLines = await ensureDiffFileBlobLoaded(filename);
  if (!blobLines) return;

  const totalRight = blobLines.length;
  if (startRight > totalRight) {
    showToast('End of file already reached.', 1500);
    return;
  }

  const endRight = step > 0 ? Math.min(totalRight, startRight + step - 1) : totalRight;
  const endLeft = startLeft + (endRight - startRight);
  const cacheKey = `${state.selectedPrKey || ''}::${filename}`;
  addDiffExpandedRange(cacheKey, {
    startRight,
    endRight,
    startLeft,
    endLeft,
  });

  selectDiffFile(filename, state.highlightedLine);
  const newScrollArea = document.getElementById('diffScrollArea');
  if (newScrollArea) {
    newScrollArea.scrollTop = prevScrollTop;
  }
}

async function toggleExpandAllDiffContext(filename) {
  const scrollArea = document.getElementById('diffScrollArea');
  const prevScrollTop = scrollArea ? scrollArea.scrollTop : 0;

  const blobLines = await ensureDiffFileBlobLoaded(filename);
  if (!blobLines) return;

  const cacheKey = `${state.selectedPrKey || ''}::${filename}`;
  const current = state.diffExpandedRanges[cacheKey] || [];
  const isFullExpanded = current.some(
    (r) => r.startRight <= 1 && r.endRight >= blobLines.length
  );

  if (isFullExpanded) {
    state.diffExpandedRanges[cacheKey] = [];
  } else {
    state.diffExpandedRanges[cacheKey] = [
      {
        startRight: 1,
        endRight: blobLines.length,
        startLeft: 1,
        endLeft: blobLines.length,
      },
    ];
  }

  selectDiffFile(filename, state.highlightedLine);
  const newScrollArea = document.getElementById('diffScrollArea');
  if (newScrollArea) {
    newScrollArea.scrollTop = prevScrollTop;
  }
}

function parsePatchIntoHunks(patch) {
  const lines = String(patch || '').split('\n');
  const hunks = [];
  let current = null;

  for (const rawLine of lines) {
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      const startLeft = Number(hunkMatch[1]);
      const startRight = Number(hunkMatch[3]);
      current = {
        header: rawLine,
        startLeft,
        startRight,
        endLeft: startLeft - 1,
        endRight: startRight - 1,
        rows: [],
      };
      continue;
    }

    if (!current) continue;
    if (rawLine.startsWith('\\ No newline at end of file')) continue;

    if (rawLine.startsWith('+')) {
      current.endRight += 1;
      current.rows.push({
        type: 'add',
        leftNum: '',
        rightNum: current.endRight,
        rawLine,
      });
    } else if (rawLine.startsWith('-')) {
      current.endLeft += 1;
      current.rows.push({
        type: 'del',
        leftNum: current.endLeft,
        rightNum: '',
        rawLine,
      });
    } else {
      current.endLeft += 1;
      current.endRight += 1;
      current.rows.push({
        type: 'ctx',
        leftNum: current.endLeft,
        rightNum: current.endRight,
        rawLine,
      });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function renderDiffLineAndFindingsHtml({
  rowClass,
  lNum,
  rNum,
  codeText,
  fileFindings,
  fileThreads = [],
  highlightLine,
  filename = state.selectedDiffFile,
}) {
  const isHighlighted = highlightLine && rNum && Number(rNum) === Number(highlightLine);
  const finalClass = `${rowClass}${isHighlighted ? ' diff-row-highlight' : ''}`.trim();
  const rightCellHtml = rNum
    ? `<td class="diff-line-num commentable-line" data-comment-line="${rNum}" title="Click or drag to write a comment on line ${rNum}"><button type="button" class="diff-line-add-btn" tabindex="-1">+</button>${rNum}</td>`
    : `<td class="diff-line-num"></td>`;
  const out = [
    `<tr class="${finalClass}" ${rNum ? `data-right-line="${rNum}"` : ''}><td class="diff-line-num">${lNum}</td>${rightCellHtml}<td class="diff-line-code">${highlightDiffCodeLine(codeText, filename)}</td></tr>`,
  ];

  if (rNum) {
    const matchingFindings = fileFindings.filter((f) => Number(f.resolvedLine) === Number(rNum));
    for (const mf of matchingFindings) {
      const sev = getSeverityMeta(mf.severity);
      const rangeBadgeHtml =
        mf.startLine && mf.endLine && Number(mf.endLine) > Number(mf.startLine)
          ? `<span class="badge" title="Multi-line comment (L${mf.startLine} to L${mf.endLine})">L${mf.startLine}&ndash;L${mf.endLine}</span>`
          : `<span class="badge">L${rNum}</span>`;
      out.push(`
        <tr>
          <td colspan="3" class="diff-inline-finding">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span class="badge ${sev.badgeClass}">${escapeHtml(sev.label)}</span>
                ${rangeBadgeHtml}
                <strong style="font-size:12.5px;">${escapeHtml(mf.id)} — ${formatInlineCodeHtml(mf.title)}</strong>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${
                  mf.isManual
                    ? `<button class="btn btn-ghost btn-sm diff-edit-manual-finding-btn" data-cid="${escapeHtml(mf.cid)}">Edit</button>
                       <button class="btn btn-ghost btn-sm diff-delete-manual-finding-btn" data-cid="${escapeHtml(mf.cid)}">Delete</button>`
                    : ''
                }
                <button class="btn btn-secondary btn-sm diff-copy-finding-btn" data-cid="${escapeHtml(mf.cid)}">Copy</button>
                <button class="btn btn-primary btn-sm diff-post-finding-btn" data-cid="${escapeHtml(mf.cid)}">Post here</button>
              </div>
            </div>
            <pre style="margin:0;white-space:pre-wrap;background:var(--bg-app);padding:10px;border-radius:4px;border:1px solid var(--border-color);font-size:11.5px;">${escapeHtml(mf.customComment)}</pre>
          </td>
        </tr>
      `);
    }

    const matchingThreads = (fileThreads || []).filter(
      (t) => Number(t.line || t.startLine || 0) === Number(rNum)
    );
    for (const thread of matchingThreads) {
      out.push(`
        <tr>
          <td colspan="3" class="diff-github-thread">
            ${renderGitHubThreadCardHtml(thread, { inDiff: true })}
          </td>
        </tr>
      `);
    }
  }

  return out.join('');
}

function renderGapWithExpanderHtml({
  gapStartRight,
  gapEndRight,
  gapStartLeft,
  gapEndLeft,
  hunkHeaderText,
  blobLines,
  expandedRanges,
  fileFindings,
  fileThreads = [],
  highlightLine,
  isTopOfFile = false,
  filename = state.selectedDiffFile,
}) {
  const rows = [];
  const step = 20;

  if (gapEndRight < gapStartRight) {
    // Zero hidden lines above this hunk, just render the standard hunk header row if provided
    if (hunkHeaderText) {
      rows.push(
        `<tr class="diff-row-hunk"><td class="diff-line-num">…</td><td class="diff-line-num">…</td><td class="diff-line-code"><div class="diff-hunk-header-bar"><span>${escapeHtml(hunkHeaderText)}</span></div></td></tr>`
      );
    }
    return rows.join('');
  }

  // Partition [gapStartRight .. gapEndRight] into unexpanded vs expanded sub-segments
  const overlapping = expandedRanges
    .map((r) => ({
      startRight: Math.max(gapStartRight, r.startRight),
      endRight: Math.min(gapEndRight, r.endRight),
    }))
    .filter((r) => r.endRight >= r.startRight)
    .sort((a, b) => a.startRight - b.startRight);

  const segments = [];
  let cursor = gapStartRight;
  for (const ov of overlapping) {
    if (ov.startRight > cursor) {
      segments.push({ type: 'hidden', startRight: cursor, endRight: ov.startRight - 1 });
    }
    segments.push({ type: 'expanded', startRight: ov.startRight, endRight: ov.endRight });
    cursor = ov.endRight + 1;
  }
  if (cursor <= gapEndRight) {
    segments.push({ type: 'hidden', startRight: cursor, endRight: gapEndRight });
  }

  segments.forEach((seg, segIdx) => {
    const segOffset = seg.startRight - gapStartRight;
    const segStartLeft = gapStartLeft + segOffset;
    const segCount = seg.endRight - seg.startRight + 1;
    const segEndLeft = segStartLeft + segCount - 1;
    const isLastSegment = segIdx === segments.length - 1;

    if (seg.type === 'expanded' && blobLines) {
      for (let rLine = seg.startRight; rLine <= seg.endRight; rLine++) {
        const lLine = gapStartLeft + (rLine - gapStartRight);
        const lineContent = blobLines[rLine - 1] ?? '';
        rows.push(
          renderDiffLineAndFindingsHtml({
            rowClass: 'diff-row-expanded-ctx',
            lNum: lLine,
            rNum: rLine,
            codeText: ` ${lineContent}`,
            fileFindings,
            fileThreads,
            highlightLine,
            filename,
          })
        );
      }
      if (isLastSegment && hunkHeaderText) {
        rows.push(
          `<tr class="diff-row-hunk"><td class="diff-line-num">…</td><td class="diff-line-num">…</td><td class="diff-line-code"><div class="diff-hunk-header-bar"><span>${escapeHtml(hunkHeaderText)}</span></div></td></tr>`
        );
      }
    } else {
      // Hidden segment -> render ultra-thin single-line expander row with ↑ / ↓ arrow buttons
      const upStartRight = Math.max(seg.startRight, seg.endRight - step + 1);
      const upEndRight = seg.endRight;
      const upStartLeft = segStartLeft + (upStartRight - seg.startRight);
      const upEndLeft = segEndLeft;

      const downStartRight = seg.startRight;
      const downEndRight = Math.min(seg.endRight, seg.startRight + step - 1);
      const downStartLeft = segStartLeft;
      const downEndLeft = segStartLeft + (downEndRight - downStartRight);

      const headerLabel =
        isLastSegment && hunkHeaderText
          ? `${hunkHeaderText}   ·   ${segCount} unchanged ${segCount > 1 ? 'lines' : 'line'} hidden (lines ${seg.startRight}–${seg.endRight})`
          : `@@ ${segCount} unchanged ${segCount > 1 ? 'lines' : 'line'} hidden (lines ${seg.startRight}–${seg.endRight}) @@`;

      const canExpandDown = !isTopOfFile && segCount > step;
      const expandAllBtnHtml =
        segCount > step
          ? `<button type="button" class="diff-expand-btn diff-expand-range-btn" data-start-right="${seg.startRight}" data-end-right="${seg.endRight}" data-start-left="${segStartLeft}" data-end-left="${segEndLeft}" title="Show all ${segCount} hidden lines (lines ${seg.startRight} to ${seg.endRight})">&uarr;&darr; All (${segCount})</button>`
          : '';

      rows.push(
        `<tr class="diff-row-hunk"><td colspan="2" class="diff-hunk-expand-cell"><div class="diff-hunk-actions"><button type="button" class="diff-expand-btn diff-expand-range-btn" data-start-right="${upStartRight}" data-end-right="${upEndRight}" data-start-left="${upStartLeft}" data-end-left="${upEndLeft}" title="Expand upwards (lines ${upStartRight} to ${upEndRight})">&uarr; ${upEndRight - upStartRight + 1}</button>${canExpandDown ? `<button type="button" class="diff-expand-btn diff-expand-range-btn" data-start-right="${downStartRight}" data-end-right="${downEndRight}" data-start-left="${downStartLeft}" data-end-left="${downEndLeft}" title="Expand downwards (lines ${downStartRight} to ${downEndRight})">&darr; ${downEndRight - downStartRight + 1}</button>` : ''}</div></td><td class="diff-line-code"><div class="diff-hunk-header-bar"><span>${escapeHtml(headerLabel)}</span>${expandAllBtnHtml}</div></td></tr>`
      );
    }
  });

  return rows.join('');
}

function renderPatchTableRows(
  patch,
  fileFindings,
  highlightLine,
  filename = state.selectedDiffFile,
  fileThreads = []
) {
  if (!patch) {
    return `<tr><td colspan="3" class="diff-line-code meta-text">No text diff available for this file.</td></tr>`;
  }

  const cacheKey = `${state.selectedPrKey || ''}::${filename || ''}`;
  const blobLines = state.diffBlobCache[cacheKey] || null;
  const expandedRanges = state.diffExpandedRanges[cacheKey] || [];
  const hunks = parsePatchIntoHunks(patch);

  if (hunks.length === 0) {
    return `<tr><td colspan="3" class="diff-line-code meta-text">No text diff available for this file.</td></tr>`;
  }

  const rows = [];
  let prevEndRight = 0;
  let prevEndLeft = 0;

  hunks.forEach((hunk, idx) => {
    const gapStartRight = prevEndRight + 1;
    const gapEndRight = hunk.startRight - 1;
    const gapStartLeft = prevEndLeft + 1;
    const gapEndLeft = hunk.startLeft - 1;

    rows.push(
      renderGapWithExpanderHtml({
        gapStartRight,
        gapEndRight,
        gapStartLeft,
        gapEndLeft,
        hunkHeaderText: hunk.header,
        blobLines,
        expandedRanges,
        fileFindings,
        fileThreads,
        highlightLine,
        isTopOfFile: idx === 0,
        filename,
      })
    );

    for (const r of hunk.rows) {
      const rowClass =
        r.type === 'add' ? 'diff-row-add' : r.type === 'del' ? 'diff-row-del' : '';
      rows.push(
        renderDiffLineAndFindingsHtml({
          rowClass,
          lNum: r.leftNum,
          rNum: r.rightNum,
          codeText: r.rawLine,
          fileFindings,
          fileThreads,
          highlightLine,
          filename,
        })
      );
    }

    prevEndRight = Math.max(prevEndRight, hunk.endRight);
    prevEndLeft = Math.max(prevEndLeft, hunk.endLeft);
  });

  // Bottom-of-file expander (after the last hunk)
  const lastRight = prevEndRight;
  const lastLeft = prevEndLeft;
  const eofStartRight = lastRight + 1;
  const eofStartLeft = lastLeft + 1;

  if (blobLines) {
    if (eofStartRight <= blobLines.length) {
      rows.push(
        renderGapWithExpanderHtml({
          gapStartRight: eofStartRight,
          gapEndRight: blobLines.length,
          gapStartLeft: eofStartLeft,
          gapEndLeft: eofStartLeft + (blobLines.length - eofStartRight),
          hunkHeaderText: '',
          blobLines,
          expandedRanges,
          fileFindings,
          fileThreads,
          highlightLine,
          isTopOfFile: false,
          filename,
        })
      );
    }
  } else {
    // Blob not loaded yet -> show interactive ↓ +20 / ↓ End of file bar at bottom
    rows.push(
      `<tr class="diff-row-hunk"><td colspan="2" class="diff-hunk-expand-cell"><div class="diff-hunk-actions"><button type="button" class="diff-expand-btn diff-expand-eof-btn" data-start-right="${eofStartRight}" data-start-left="${eofStartLeft}" data-step="20" title="Expand next 20 lines downwards (starting from line ${eofStartRight})">&darr; 20</button></div></td><td class="diff-line-code"><div class="diff-hunk-header-bar"><span>@@ Show remaining file after line ${lastRight} @@</span><button type="button" class="diff-expand-btn diff-expand-eof-btn" data-start-right="${eofStartRight}" data-start-left="${eofStartLeft}" data-step="0" title="Show all remaining lines until end of file">&darr; Until end of file</button></div></td></tr>`
    );
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
    showToast(`File not modified in this PR (${cleanTarget}). Opening in PhpStorm...`);
    openCurrentPrInIde('phpstorm', cleanTarget, line || 1);
  }
}

// =============================================================================
// PR Overview Tab (2. Description, Commits & GitHub Conversation / Review Threads)
// =============================================================================
function renderMarkdownSafe(mdText) {
  const raw = String(mdText || '').trim();
  if (!raw) return '<span class="meta-text"><em>(No description provided)</em></span>';
  if (window.marked && typeof window.marked.parse === 'function') {
    try {
      return window.marked.parse(raw);
    } catch {
      // Fallback to escaped pre-wrap
    }
  }
  return `<div style="white-space:pre-wrap;">${escapeHtml(raw)}</div>`;
}

function renderGitHubThreadCardHtml(thread, { inDiff = false } = {}) {
  const comments = thread.comments || [];
  const firstComment = comments[0] || {};
  const shortPath = String(thread.path || '').replace(/^projects\/services\//, '');
  const lineLabel =
    thread.startLine && thread.line && Number(thread.line) > Number(thread.startLine)
      ? `L${thread.startLine}–L${thread.line}`
      : thread.line
      ? `L${thread.line}`
      : '';

  const statusBadges = [];
  if (thread.isResolved) {
    statusBadges.push('<span class="badge badge-pass">Resolved</span>');
  } else {
    statusBadges.push('<span class="badge badge-warning">Open</span>');
  }
  if (thread.isOutdated) {
    statusBadges.push('<span class="badge">Outdated</span>');
  }

  const jumpBtnHtml =
    !inDiff && thread.path
      ? `<button type="button" class="btn btn-secondary btn-xs gh-thread-jump-diff-btn" data-path="${escapeHtml(thread.path)}" data-line="${thread.line || thread.startLine || 1}" title="View this thread directly below the line in 3. Git Diff">View in Diff &rarr;</button>`
      : '';

  const resolveBtnHtml = thread.id
    ? `<button type="button" class="btn btn-ghost btn-xs gh-thread-resolve-btn" data-thread-id="${escapeHtml(thread.id)}" data-resolved="${thread.isResolved ? '1' : '0'}">${thread.isResolved ? 'Reopen' : 'Resolve'}</button>`
    : '';

  const commentsHtml = comments
    .map(
      (c) => {
        const cAuthor = c.authorName || c.authorLogin || c.author || 'unknown';
        return `
      <div class="pr-thread-comment">
        <div class="pr-thread-comment-meta">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <strong style="color:var(--text-primary);">${escapeHtml(cAuthor)}</strong>
            ${c.authorAssociation === 'MEMBER' || c.authorAssociation === 'OWNER' ? '<span class="badge">Member</span>' : ''}
            <span>${escapeHtml(formatRelativeTime(c.createdAt))}</span>
          </div>
          ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-xs">GitHub &nearr;</a>` : ''}
        </div>
        <div class="pr-thread-comment-body markdown-body">${renderMarkdownSafe(c.body)}</div>
      </div>
    `;
      }
    )
    .join('');

  const firstAuthor = firstComment.authorName || firstComment.authorLogin || firstComment.author || 'this thread';
  const replyFormHtml = thread.id
    ? `
      <form class="pr-thread-reply-box gh-thread-reply-form" data-thread-id="${escapeHtml(thread.id)}">
        <textarea class="finding-textarea gh-thread-reply-input" rows="2" placeholder="Reply to ${escapeHtml(firstAuthor)} on GitHub..." required></textarea>
        <div style="display:flex;flex-direction:column;gap:4px;justify-content:flex-end;">
          <button type="submit" class="btn btn-primary btn-xs">Reply</button>
        </div>
      </form>
    `
    : '';

  const cardInnerHtml = `
    <div class="pr-thread-header">
      <div class="pr-thread-header-left">
        <span class="badge badge-peer">GitHub Review Thread</span>
        ${statusBadges.join(' ')}
        ${
          shortPath
            ? `<code style="font-size:11.5px;color:var(--accent);word-break:break-all;">${escapeHtml(shortPath)}${lineLabel ? `:${escapeHtml(lineLabel)}` : ''}</code>`
            : ''
        }
      </div>
      <div class="pr-thread-header-right">
        ${jumpBtnHtml}
        ${resolveBtnHtml}
      </div>
    </div>
    <div class="pr-thread-comments">${commentsHtml}</div>
    ${replyFormHtml}
  `;

  if (inDiff && thread.isResolved) {
    return `
      <details class="pr-thread-card resolved" style="padding:6px 10px;">
        <summary style="cursor:pointer;font-size:11.5px;color:var(--text-secondary);display:flex;align-items:center;gap:8px;">
          <span class="badge badge-pass">Resolved GitHub Thread</span>
          <strong>${escapeHtml(firstAuthor)}</strong>
          <span>(${comments.length} message${comments.length > 1 ? 's' : ''}) — Click to expand</span>
        </summary>
        <div style="margin-top:8px;">${cardInnerHtml}</div>
      </details>
    `;
  }

  return `<div class="pr-thread-card ${thread.isResolved ? 'resolved' : ''}">${cardInnerHtml}</div>`;
}

function bindGitHubThreadActionListeners(containerEl) {
  if (!containerEl) return;

  containerEl.querySelectorAll('.gh-thread-jump-diff-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const path = btn.dataset.path;
      const line = Number(btn.dataset.line) || null;
      if (!path) return;
      navigateToCodeLocation(path, line, 'diff');
    });
  });

  containerEl.querySelectorAll('.gh-thread-resolve-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const threadId = btn.dataset.threadId;
      const currentlyResolved = btn.dataset.resolved === '1';
      if (!threadId) return;
      btn.disabled = true;
      await toggleGitHubThreadResolution(threadId, !currentlyResolved);
      btn.disabled = false;
    });
  });

  containerEl.querySelectorAll('.gh-thread-reply-form').forEach((form) => {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const threadId = form.dataset.threadId;
      const textarea = form.querySelector('.gh-thread-reply-input');
      const body = textarea?.value?.trim();
      if (!threadId || !body) return;
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      const ok = await submitGitHubThreadReply(threadId, body);
      if (ok && textarea) textarea.value = '';
      if (submitBtn) submitBtn.disabled = false;
    });
  });
}

async function submitGitHubThreadReply(threadId, body) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return false;
  try {
    const res = await fetch('/api/github/thread-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: pr.repo,
        number: pr.number,
        threadId,
        body,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'GitHub reply error');
    showToast('Reply published to GitHub thread.');
    await loadPrOverview(pr, true);
    return true;
  } catch (err) {
    showToast(`Error: ${err.message}`, 4500);
    return false;
  }
}

async function toggleGitHubThreadResolution(threadId, resolve) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return false;
  try {
    const res = await fetch('/api/github/thread-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: pr.repo,
        number: pr.number,
        threadId,
        resolve,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'GitHub thread resolution error');
    showToast(resolve ? 'Thread marked as resolved on GitHub.' : 'Thread reopened on GitHub.');
    await loadPrOverview(pr, true);
    return true;
  } catch (err) {
    showToast(`Error: ${err.message}`, 4500);
    return false;
  }
}

async function submitGeneralPrCommentFromOverview(body) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr || !body) return false;
  try {
    const res = await fetch('/api/github/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: pr.repo,
        number: pr.number,
        mode: 'general',
        body,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'GitHub comment publish error');
    showToast('General comment published on PR.');
    await loadPrOverview(pr, true);
    return true;
  } catch (err) {
    showToast(`Error: ${err.message}`, 4500);
    return false;
  }
}

async function loadPrOverview(pr, forceRefresh = false) {
  const containerEl = document.getElementById('prOverviewContainer');
  if (!pr || state.selectedPrKey !== pr.key) return;
  const cacheKey = getPrClientCacheKey(pr);

  const applyOverviewData = (data) => {
    if (state.selectedPrKey !== pr.key) return;
    state.currentOverview = data;

    // Update tab badges
    const commitsBadge = document.getElementById('tabOverviewCommitsCount');
    const commentsBadge = document.getElementById('tabOverviewCommentsCount');
    if (commitsBadge) {
      const cCount = data.commitsCount ?? (data.commits || []).length ?? 0;
      commitsBadge.textContent = `${cCount} commit${cCount === 1 ? '' : 's'}`;
    }
    if (commentsBadge) {
      const gCount = data.commentsCount ?? data.totalCommentsCount ?? 0;
      commentsBadge.textContent = `${gCount} comment${gCount === 1 ? '' : 's'}`;
    }

    renderPrOverviewTab();

    // If a diff file is currently selected, re-render it so inline GitHub threads appear under the lines
    const diffFiles = state.currentDiff?.files || [];
    if (state.selectedDiffFile && diffFiles.some((f) => f.filename === state.selectedDiffFile)) {
      const scrollArea = document.getElementById('diffScrollArea');
      const prevScroll = scrollArea ? scrollArea.scrollTop : 0;
      selectDiffFile(state.selectedDiffFile, state.highlightedLine);
      const nextScrollArea = document.getElementById('diffScrollArea');
      if (nextScrollArea) nextScrollArea.scrollTop = prevScroll;
    }
  };

  if (!forceRefresh && state.prOverviewCache[cacheKey]) {
    applyOverviewData(state.prOverviewCache[cacheKey]);
    return;
  }

  if (containerEl && !state.currentOverview) {
    containerEl.innerHTML = `<div class="empty-state meta-text">Loading PR description, commits and GitHub comments for ${escapeHtml(pr.key)}...</div>`;
  }

  try {
    const res = await fetch(
      `/api/github/overview?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}${forceRefresh ? '&refresh=1' : ''}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unable to load Description & Conversation view');
    if (!data.offlineError) {
      state.prOverviewCache[cacheKey] = data;
    }
    if (state.selectedPrKey !== pr.key) return;
    applyOverviewData(data);
  } catch (err) {
    if (containerEl && !state.currentOverview) {
      containerEl.innerHTML = `<div class="empty-state meta-text">${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderPrOverviewTab() {
  const containerEl = document.getElementById('prOverviewContainer');
  if (!containerEl) return;
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  const ov = state.currentOverview;
  if (!pr || !ov) {
    containerEl.innerHTML = `<div class="empty-state meta-text">Select a PR to view its description, commits, and GitHub comments.</div>`;
    return;
  }

  const commits = ov.commits || [];
  const generalComments = ov.generalComments || [];
  const reviews = (ov.reviews || []).filter(
    (r) => String(r.body || '').trim().length > 0 || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'
  );
  const reviewThreads = ov.reviewThreads || [];
  const unresolvedThreadsCount = reviewThreads.filter((t) => !t.isResolved).length;
  const totalDiscussionItems = generalComments.length + reviews.length + reviewThreads.length;
  const filter = state.overviewFilter || 'all';

  // Build chronological timeline of general comments, formal reviews, and inline review threads
  const timelineEntries = [];
  for (const c of generalComments) {
    timelineEntries.push({
      kind: 'general-comment',
      createdAt: c.createdAt || '',
      item: c,
    });
  }
  for (const r of reviews) {
    timelineEntries.push({
      kind: 'review',
      createdAt: r.submittedAt || '',
      item: r,
    });
  }
  for (const t of reviewThreads) {
    const firstDate = t.comments?.[0]?.createdAt || t.updatedAt || '';
    timelineEntries.push({
      kind: 'thread',
      createdAt: firstDate,
      item: t,
    });
  }
  timelineEntries.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  const showDescription = filter === 'all';
  const showCommits = filter === 'all' || filter === 'commits';
  const showComments = filter === 'all' || filter === 'comments' || filter === 'unresolved';

  const filteredTimeline =
    filter === 'unresolved'
      ? timelineEntries.filter((e) => e.kind === 'thread' && !e.item.isResolved)
      : timelineEntries;

  const descriptionSectionHtml = showDescription
    ? `
      <div class="pr-overview-card">
        <div class="pr-overview-card-header">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong>Pull Request Description</strong>
            <span class="meta-text">opened by <strong>${escapeHtml(ov.authorName || ov.authorLogin || ov.author || pr.authorName || pr.author || '')}</strong> · ${escapeHtml(formatRelativeTime(ov.createdAt || pr.createdAt))}</span>
          </div>
          ${ov.url ? `<a href="${escapeHtml(ov.url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-xs">View on GitHub &nearr;</a>` : ''}
        </div>
        <div class="pr-overview-card-body markdown-body">${renderMarkdownSafe(ov.body)}</div>
      </div>
    `
    : '';

  const commitsSectionHtml = showCommits
    ? `
      <div class="pr-overview-card">
        <div class="pr-overview-card-header">
          <div style="display:flex;align-items:center;gap:8px;">
            <strong>Commits in chronological order</strong>
            <span class="badge">${commits.length} commit${commits.length > 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="pr-commits-list">
          ${
            commits.length === 0
              ? `<div class="empty-state meta-text" style="padding:14px;">No commits found.</div>`
              : commits
                  .map(
                    (c, idx) => `
                  <div class="pr-commit-item">
                    <div class="pr-commit-top-row">
                      <div class="pr-commit-title-group">
                        <span class="badge pr-commit-index-badge">#${idx + 1}</span>
                        <span class="pr-commit-headline" title="${escapeHtml(c.messageHeadline)}">${escapeHtml(c.messageHeadline)}</span>
                      </div>
                      <div class="pr-commit-actions">
                        <button type="button" class="pr-commit-sha copy-commit-sha-btn" data-sha="${escapeHtml(c.oid)}" title="Click to copy SHA (${escapeHtml(c.oid)})">${escapeHtml(c.shortOid)}</button>
                        ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-xs" title="View commit on GitHub">&nearr;</a>` : ''}
                      </div>
                    </div>
                    <div class="pr-commit-sub-row">
                      <span class="pr-commit-author">${escapeHtml(c.authorName || c.authorLogin || c.author || '')}</span>
                      <span>·</span>
                      <span>${escapeHtml(formatRelativeTime(c.committedDate))}</span>
                    </div>
                  </div>
                `
                  )
                  .join('')
          }
        </div>
      </div>
    `
    : '';

  const timelineHtml = filteredTimeline
    .map((entry) => {
      if (entry.kind === 'thread') {
        return renderGitHubThreadCardHtml(entry.item, { inDiff: false });
      }
      if (entry.kind === 'review') {
        const r = entry.item;
        const hasBody = Boolean(String(r.body || '').trim());
        const badgeHtml =
          r.state === 'APPROVED'
            ? '<span class="badge badge-pass">Approved</span>'
            : r.state === 'CHANGES_REQUESTED'
            ? '<span class="badge badge-blocker">Changes Requested</span>'
            : '<span class="badge badge-peer">Review Commented</span>';
        return `
          <div class="pr-thread-card ${hasBody ? '' : 'compact-review'}">
            <div class="pr-thread-header">
              <div class="pr-thread-header-left">
                ${badgeHtml}
                <strong>${escapeHtml(r.authorName || r.authorLogin || r.author || 'unknown')}</strong>
                <span class="meta-text">${escapeHtml(formatRelativeTime(r.submittedAt))}</span>
              </div>
              <div class="pr-thread-header-right">
                ${r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-xs">GitHub &nearr;</a>` : ''}
              </div>
            </div>
            ${
              hasBody
                ? `<div class="pr-thread-comments"><div class="pr-thread-comment"><div class="pr-thread-comment-body markdown-body">${renderMarkdownSafe(r.body)}</div></div></div>`
                : ''
            }
          </div>
        `;
      }
      const c = entry.item;
      return `
        <div class="pr-thread-card">
          <div class="pr-thread-header">
            <div class="pr-thread-header-left">
              <span class="badge">General Comment</span>
              <strong>${escapeHtml(c.authorName || c.authorLogin || c.author || 'unknown')}</strong>
              <span class="meta-text">${escapeHtml(formatRelativeTime(c.createdAt))}</span>
            </div>
            <div class="pr-thread-header-right">
              ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-xs">GitHub &nearr;</a>` : ''}
            </div>
          </div>
          <div class="pr-thread-comments">
            <div class="pr-thread-comment">
              <div class="pr-thread-comment-body markdown-body">${renderMarkdownSafe(c.body)}</div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  const commentsSectionHtml = showComments
    ? `
      <div class="pr-overview-card">
        <div class="pr-overview-card-header">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong>Conversation &amp; GitHub Review Comments</strong>
            <span class="badge">${totalDiscussionItems} item${totalDiscussionItems > 1 ? 's' : ''}</span>
            ${
              unresolvedThreadsCount > 0
                ? `<span class="badge badge-warning">${unresolvedThreadsCount} unresolved thread${unresolvedThreadsCount > 1 ? 's' : ''}</span>`
                : reviewThreads.length > 0
                ? `<span class="badge badge-pass">All threads resolved</span>`
                : ''
            }
          </div>
        </div>
        <div class="pr-overview-card-body" style="display:flex;flex-direction:column;gap:12px;">
          ${
            filteredTimeline.length === 0
              ? `<div class="empty-state meta-text" style="padding:16px;">No GitHub comments in this view.</div>`
              : `<div class="pr-timeline-list">${timelineHtml}</div>`
          }
          <form id="overviewGeneralCommentForm" style="display:flex;flex-direction:column;gap:8px;margin-top:6px;padding-top:12px;border-top:1px solid var(--border-color);">
            <label style="font-size:12px;font-weight:600;color:var(--text-primary);">Write a new general comment on this PR:</label>
            <textarea id="overviewGeneralCommentInput" class="finding-textarea" rows="3" placeholder="Your general comment on this PR (Markdown supported)..." required></textarea>
            <div style="display:flex;justify-content:flex-end;">
              <button type="submit" class="btn btn-primary btn-sm">Publish Comment on GitHub</button>
            </div>
          </form>
        </div>
      </div>
    `
    : '';

  containerEl.innerHTML = `
    <div class="pr-overview-toolbar">
      <div class="pr-overview-badges">
        <div class="filter-tabs" id="overviewSectionFilterTabs">
          <button type="button" class="filter-tab ${filter === 'all' ? 'active' : ''}" data-ov-filter="all">All</button>
          <button type="button" class="filter-tab ${filter === 'comments' ? 'active' : ''}" data-ov-filter="comments">Comments &amp; Reviews (${totalDiscussionItems})</button>
          ${
            unresolvedThreadsCount > 0
              ? `<button type="button" class="filter-tab ${filter === 'unresolved' ? 'active' : ''}" data-ov-filter="unresolved">Open threads (${unresolvedThreadsCount})</button>`
              : ''
          }
          <button type="button" class="filter-tab ${filter === 'commits' ? 'active' : ''}" data-ov-filter="commits">Commits (${commits.length})</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button type="button" id="refreshPrOverviewBtn" class="btn btn-secondary btn-xs" title="Refresh description, commits and comments from GitHub">&#8635; Refresh GitHub</button>
      </div>
    </div>
    ${descriptionSectionHtml}
    ${commitsSectionHtml}
    ${commentsSectionHtml}
  `;

  containerEl.querySelectorAll('#overviewSectionFilterTabs .filter-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.overviewFilter = btn.dataset.ovFilter || 'all';
      renderPrOverviewTab();
    });
  });

  document.getElementById('refreshPrOverviewBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refreshPrOverviewBtn');
    if (btn) btn.disabled = true;
    await loadPrOverview(pr, true);
    showToast('GitHub description, commits and comments refreshed.');
  });

  containerEl.querySelectorAll('.copy-commit-sha-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sha = btn.dataset.sha;
      if (!sha) return;
      await navigator.clipboard.writeText(sha);
      showToast(`Commit SHA copied: ${sha.slice(0, 8)}`);
    });
  });

  document.getElementById('overviewGeneralCommentForm')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = document.getElementById('overviewGeneralCommentInput');
    const body = input?.value?.trim();
    if (!body) return;
    const submitBtn = ev.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    const ok = await submitGeneralPrCommentFromOverview(body);
    if (ok && input) input.value = '';
    if (submitBtn) submitBtn.disabled = false;
  });

  bindGitHubThreadActionListeners(containerEl);
}

// Mount / Unmount Worktree & Open IDE
document.getElementById('mountWorktreeBtn')?.addEventListener('click', async () => {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;
  showToast(`Mounting worktree for ${pr.key}...`);
  try {
    const res = await fetch('/api/worktree/mount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: pr.repo, number: pr.number, headSha: pr.headRefOid }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Worktree mount error');
    state.worktreeStatus = data;
    pr.worktreeMounted = true;
    pr.worktreePath = data.worktreePath;
    renderWorktreeStatusBar(pr);
    renderPrList();
    showToast(`Worktree ready: ${data.worktreePath}`);
  } catch (err) {
    showToast(`Error: ${err.message}`, 5000);
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
    if (!res.ok) throw new Error(data.error || 'Worktree unmount error');
    state.worktreeStatus = data;
    pr.worktreeMounted = false;
    pr.worktreePath = null;
    renderWorktreeStatusBar(pr);
    renderPrList();
    showToast(`Worktree unmounted.`);
  } catch (err) {
    showToast(`Error: ${err.message}`, 5000);
  }
});

async function openCurrentPrInIde(ide, filePath = '', line = null) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;
  showToast(`Opening in ${ide === 'code' ? 'VS Code' : 'PhpStorm'} (mounting worktree)...`);
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
    if (!res.ok) throw new Error(data.error || 'IDE open error');
    state.worktreeStatus = { mounted: true, worktreePath: data.worktreePath };
    pr.worktreeMounted = true;
    renderWorktreeStatusBar(pr);
    renderPrList();
    showToast(`Opened in ${ide}: ${data.worktreePath}`);
  } catch (err) {
    showToast(`Error: ${err.message}`, 5000);
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
  if (!options.keepQueueFullPage && state.prQueueFullPage) {
    state.prQueueFullPage = false;
    state.prSidebarCollapsed = !state.prSidebarPinned;
    renderCollapsibleLayoutState();
  }
  if (!options.keepFocusDiff && state.focusDiffMode && tabName !== 'diff') {
    setFocusDiffMode(false);
  }
  state.activeTab = tabName;
  state.activeFindingIndex = -1;

  if (state.splitMode) {
    if (options.splitSide === 'right') {
      setSplitRightPanel(tabName);
    } else if (options.splitSide === 'left') {
      setSplitLeftPanel(tabName);
    } else if (tabName !== state.splitLeftTab && tabName !== state.splitRightTab) {
      setSplitLeftPanel(tabName);
    } else {
      applySplitLayout();
    }
  } else {
    document.querySelectorAll('.view-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
      panel.removeAttribute('data-split-pane');
      panel.classList.remove('split-right-active');
    });
  }

  if (tabName === 'rules' || (state.splitMode && (state.splitLeftTab === 'rules' || state.splitRightTab === 'rules'))) {
    loadRules();
  }
  const isDiffVisible =
    tabName === 'diff' ||
    (state.splitMode && (state.splitLeftTab === 'diff' || state.splitRightTab === 'diff'));
  if (isDiffVisible) {
    const diffFiles = state.currentDiff?.files || [];
    if (
      diffFiles.length > 0 &&
      (!state.selectedDiffFile || !diffFiles.some((f) => f.filename === state.selectedDiffFile))
    ) {
      const fileWithFinding = (state.currentDiff?.resolvedFindings || []).find(
        (f) => f.inDiff && f.resolvedPath && diffFiles.some((df) => df.filename === f.resolvedPath)
      )?.resolvedPath;
      selectDiffFile(fileWithFinding || diffFiles[0].filename, null);
    }
  }
  renderCollapsibleLayoutState();
  if (tabName === 'diff') {
    setTimeout(() => {
      document.getElementById('diffScrollArea')?.focus({ preventScroll: true });
    }, 0);
  }
}

function applySplitLayout() {
  const container = document.getElementById('panelsContainer');
  const btn = document.getElementById('toggleSplitViewBtn');
  const selectorsWrap = document.getElementById('splitPaneSelectors');
  const leftSelect = document.getElementById('splitLeftTabSelect');
  const rightSelect = document.getElementById('splitRightTabSelect');

  if (!state.splitMode) {
    container?.classList.remove('split-mode');
    btn?.classList.remove('btn-primary');
    selectorsWrap?.classList.add('hidden');
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.removeAttribute('data-split-pane');
      p.classList.remove('split-right-active');
      p.classList.toggle('active', p.id === `tab-${state.activeTab}`);
    });
    document.querySelectorAll('.view-tab').forEach((tabBtn) => {
      tabBtn.classList.toggle('active', tabBtn.dataset.tab === state.activeTab);
    });
    return;
  }

  if (state.splitLeftTab === state.splitRightTab) {
    state.splitRightTab = state.splitLeftTab === 'diff' ? 'report' : 'diff';
  }

  try {
    localStorage.setItem('prHub.splitLeftTab', state.splitLeftTab);
    localStorage.setItem('prHub.splitRightTab', state.splitRightTab);
  } catch {
    // Ignore storage errors
  }

  container?.classList.add('split-mode');
  btn?.classList.add('btn-primary');
  selectorsWrap?.classList.remove('hidden');

  if (leftSelect) leftSelect.value = state.splitLeftTab;
  if (rightSelect) rightSelect.value = state.splitRightTab;

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const isLeft = panel.id === `tab-${state.splitLeftTab}`;
    const isRight = panel.id === `tab-${state.splitRightTab}`;
    panel.classList.toggle('active', isLeft);
    panel.classList.toggle('split-right-active', isRight);
    if (isLeft) {
      panel.setAttribute('data-split-pane', 'left');
    } else if (isRight) {
      panel.setAttribute('data-split-pane', 'right');
    } else {
      panel.removeAttribute('data-split-pane');
    }
  });

  document.querySelectorAll('.view-tab').forEach((tabBtn) => {
    const t = tabBtn.dataset.tab;
    tabBtn.classList.toggle('active', t === state.splitLeftTab || t === state.splitRightTab);
  });

  if (state.splitLeftTab === 'rules' || state.splitRightTab === 'rules') {
    loadRules();
  }
  renderCollapsibleLayoutState();
}

function setSplitLeftPanel(leftTab = 'report') {
  if (!leftTab) return;
  if (leftTab === state.splitRightTab) {
    state.splitRightTab = state.splitLeftTab;
  }
  state.splitLeftTab = leftTab;
  state.activeTab = leftTab;
  if (state.splitMode) {
    applySplitLayout();
  }
}

function setSplitRightPanel(rightTab = 'diff') {
  if (!rightTab) return;
  if (rightTab === state.splitLeftTab) {
    state.splitLeftTab = state.splitRightTab;
  }
  state.splitRightTab = rightTab;
  if (state.splitMode) {
    applySplitLayout();
  }
}

function toggleSplitMode() {
  state.splitMode = !state.splitMode;
  if (state.splitMode) {
    if (state.focusDiffMode) {
      setFocusDiffMode(false);
    }
    state._prevSplitFileTree = state.fileTreeCollapsed;
    state.fileTreeCollapsed = true;
    if (!state.splitLeftTab) state.splitLeftTab = state.activeTab || 'report';
    if (!state.splitRightTab || state.splitRightTab === state.splitLeftTab) {
      state.splitRightTab = state.splitLeftTab === 'diff' ? 'report' : 'diff';
    }
  } else if (typeof state._prevSplitFileTree === 'boolean') {
    state.fileTreeCollapsed = state._prevSplitFileTree;
  }
  renderCollapsibleLayoutState();
  applySplitLayout();
}

document.getElementById('toggleSplitViewBtn')?.addEventListener('click', toggleSplitMode);
document.getElementById('splitLeftTabSelect')?.addEventListener('change', (e) => {
  setSplitLeftPanel(e.target.value);
});
document.getElementById('splitRightTabSelect')?.addEventListener('change', (e) => {
  setSplitRightPanel(e.target.value);
});

function openPopoutWorkspace() {
  if (!state.selectedPrKey) return;
  const targetTab = state.activeTab || 'diff';
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
      switchTab('diff');
      openFileInDiffViewer(msg.filePath, msg.line);
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
    if (!res.ok) throw new Error(data.error || 'Unable to start review');
    showToast(`AI review started for ${prKey}...`);
    await loadState(true);
  } catch (err) {
    showToast(`Error: ${err.message}`, 4500);
  }
}

document.getElementById('triggerReviewBtn')?.addEventListener('click', () => {
  if (state.selectedPrKey) triggerManualReviewForKey(state.selectedPrKey);
});

document.getElementById('reviewAllPendingBtn')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/agent/review-all-pending', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Batch launch error');
    showToast(`${data.count || 0} AI review(s) started in background.`);
    await loadState(true);
  } catch (err) {
    showToast(`Error: ${err.message}`, 4500);
  }
});

let chatPollTimer = null;

function renderAgentContextBanner() {
  const banner = document.getElementById('agentFindingContextBanner');
  const textEl = document.getElementById('agentFindingContextText');
  if (!banner || !textEl) return;

  if (state.chatFindingContext) {
    textEl.textContent = `Target: ${state.chatFindingContext.id} — ${stripEmojis(state.chatFindingContext.title)}`;
    banner.classList.remove('hidden');
    return;
  }

  const currentFile = state.selectedDiffFile || state.selectedTreeFile;
  if (currentFile) {
    const shortPath = formatShortFilePath(currentFile, state.highlightedLine || state.selectedTreeLine);
    textEl.textContent = `Active file: ${shortPath}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function toggleChatDrawer(forceState = null) {
  state.chatOpen = typeof forceState === 'boolean' ? forceState : !state.chatOpen;
  const drawer = document.getElementById('agentChatDrawer');
  const btn = document.getElementById('toggleChatDrawerBtn');
  if (state.chatOpen) {
    drawer?.classList.remove('hidden');
    btn?.classList.add('btn-primary');
    renderAgentContextBanner();
    const pr = state.prs.find((p) => p.key === state.selectedPrKey);
    if (pr) loadChatForCurrentPr(pr);
    setTimeout(() => {
      document.getElementById('agentChatInput')?.focus();
    }, 20);
  } else {
    drawer?.classList.add('hidden');
    btn?.classList.remove('btn-primary');
    if (chatPollTimer) {
      clearInterval(chatPollTimer);
      chatPollTimer = null;
    }
  }
}

document.getElementById('toggleChatDrawerBtn')?.addEventListener('click', () => toggleChatDrawer());
document.getElementById('closeChatDrawerBtn')?.addEventListener('click', () => toggleChatDrawer(false));

function openChatWithFindingContext(finding) {
  state.chatFindingContext = finding;
  renderAgentContextBanner();
  toggleChatDrawer(true);
}

document.getElementById('clearFindingContextBtn')?.addEventListener('click', () => {
  state.chatFindingContext = null;
  renderAgentContextBanner();
});

async function loadChatForCurrentPr(pr) {
  const res = await fetch(
    `/api/agent/chat?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}`
  );
  if (!res.ok) return;
  const data = await res.json();
  state.chatMessages = data.messages || [];
  state.chatActiveStream = data.activeStream || null;
  renderChatMessages();
  if (state.chatActiveStream && !chatPollTimer) {
    startChatStreamPolling(pr);
  }
}

function startChatStreamPolling(pr) {
  if (chatPollTimer) clearInterval(chatPollTimer);
  chatPollTimer = setInterval(async () => {
    try {
      const res = await fetch(
        `/api/agent/chat?repo=${encodeURIComponent(pr.repo)}&number=${encodeURIComponent(pr.number)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.activeStream) {
        state.chatActiveStream = data.activeStream;
        renderChatMessages();
      } else if (state.chatActiveStream) {
        state.chatActiveStream = null;
        state.chatMessages = data.messages || state.chatMessages;
        clearInterval(chatPollTimer);
        chatPollTimer = null;
        renderChatMessages();
      }
    } catch {
      // Ignore transient poll errors
    }
  }, 900);
}

function formatChatMessageBodyHtml(rawText) {
  const cleaned = stripEmojis(rawText || '');
  if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
    return `<div class="chat-markdown-body">${marked.parse(cleaned)}</div>`;
  }
  return `<div style="white-space:pre-wrap;">${escapeHtml(cleaned)}</div>`;
}

function renderChatMessages() {
  const container = document.getElementById('agentChatMessages');
  if (!container) return;
  const hasMessages = Array.isArray(state.chatMessages) && state.chatMessages.length > 0;
  const stream = state.chatActiveStream;

  if (!hasMessages && !stream) {
    container.innerHTML = `<div class="empty-state meta-text">Ask a technical question about the displayed file or the PR (Enter to send).</div>`;
    return;
  }

  const bubblesHtml = (state.chatMessages || [])
    .map((m) => {
      const reviewerLabel = state.config?.githubUser || 'Reviewer';
      const roleLabel = m.role === 'user' ? reviewerLabel : 'Agent my-review';
      const findingTag = m.findingId ? ` · ${m.findingId}` : '';
      const fileTag = !m.findingId && m.filePath ? ` · ${formatShortFilePath(m.filePath)}` : '';
      return `
        <div class="chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}">
          <div class="chat-bubble-meta">${escapeHtml(roleLabel + findingTag + fileTag)}</div>
          ${m.role === 'assistant' ? formatChatMessageBodyHtml(m.text) : `<div style="white-space:pre-wrap;">${escapeHtml(stripEmojis(m.text))}</div>`}
        </div>
      `;
    })
    .join('');

  let streamBubbleHtml = '';
  if (stream) {
    const elapsedSec = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(stream.startedAt || new Date().toISOString())) / 1000)
    );
    const phaseLabel = stream.phase || 'Thinking…';
    const fileNote = stream.activeFile ? ` · ${formatShortFilePath(stream.activeFile)}` : '';
    const partialHtml = stream.partialText
      ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-subtle);">${formatChatMessageBodyHtml(stream.partialText)}</div>`
      : '';
    streamBubbleHtml = `
      <div class="chat-bubble assistant chat-bubble-streaming">
        <div class="chat-bubble-meta" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span>Agent my-review${escapeHtml(fileNote)}</span>
          <span class="badge badge-mono">${elapsedSec}s</span>
        </div>
        <div class="chat-stream-status">
          <span class="spinner"></span>
          <span>${escapeHtml(phaseLabel)}</span>
        </div>
        ${partialHtml}
      </div>
    `;
  }

  container.innerHTML = bubblesHtml + streamBubbleHtml;
  container.scrollTop = container.scrollHeight;
}

document.getElementById('agentChatInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    const form = document.getElementById('agentChatForm');
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }
  }
});

document.getElementById('agentChatForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  const input = document.getElementById('agentChatInput');
  const sendBtn = document.getElementById('agentSendBtn');
  const debriefChecked = document.getElementById('agentDebriefModeCheckbox')?.checked;
  if (!pr || !input) return;

  const message = input.value.trim();
  if (!message) return;

  const currentFilePath = state.selectedDiffFile || state.selectedTreeFile || null;
  const currentLine = state.highlightedLine || state.selectedTreeLine || null;
  const currentDiffFileObj = (state.currentDiff?.files || []).find(
    (f) => f.filename === currentFilePath
  );
  const fileContext = currentFilePath
    ? {
        filePath: currentFilePath,
        line: currentLine,
        patch: currentDiffFileObj?.patch || '',
      }
    : null;

  input.value = '';
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  state.chatMessages.push({
    role: 'user',
    text: message,
    findingId: state.chatFindingContext?.id || null,
    filePath: currentFilePath,
  });
  state.chatActiveStream = {
    startedAt: new Date().toISOString(),
    phase: 'Starting Gemini and sending active diff…',
    partialText: '',
    activeFile: currentFilePath,
  };
  renderChatMessages();
  startChatStreamPolling(pr);

  try {
    const res = await fetch('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: pr.repo,
        number: pr.number,
        message,
        findingContext: state.chatFindingContext,
        fileContext,
        action: debriefChecked ? 'debrief' : 'ask',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Agent communication error');
    state.chatActiveStream = null;
    state.chatMessages = data.messages || [];
    renderChatMessages();
  } catch (err) {
    state.chatActiveStream = null;
    renderChatMessages();
    showToast(`Agent Error: ${err.message}`, 5000);
  } finally {
    if (chatPollTimer) {
      clearInterval(chatPollTimer);
      chatPollTimer = null;
    }
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
});

async function promptDismissFinding(finding) {
  const pr = state.prs.find((p) => p.key === state.selectedPrKey);
  if (!pr) return;

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = `Mark ${finding.id} as False Positive (Mode 2 Debrief)`;
  confirmBtn.textContent = 'Save to false-positives.md';

  bodyEl.innerHTML = `
    <div>
      <p style="margin:0 0 8px;">
        This finding will be struck through in the UI and added to <code>references/false-positives.md</code> so the agent will no longer flag it in future reviews.
      </p>
      <label style="display:block;font-weight:500;margin-bottom:6px;">Reason / Domain rule (optional):</label>
      <textarea id="modalDismissReasonInput" class="finding-textarea" style="min-height:90px;" placeholder="E.g.: Handled upstream by voter / Standard convention in this microservice..."></textarea>
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
      if (!res.ok) throw new Error(data.error || 'Error saving false positive');
      finding.dismissed = true;
      state.selectedCommentCids.delete(finding.cid);
      modal.classList.add('hidden');
      renderReportFindingsQuickBar();
      renderFindingsTab();
      renderDiffTree();
      loadRules();
      showToast(`${finding.id} added to false positives.`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
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

  titleEl.textContent = `Add Agent Rule from ${finding.id}`;
  confirmBtn.textContent = 'Add to reviewer-dna.md';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <p class="meta-text" style="margin:0;">
        Extracts this finding into a permanent rule (in English) in <code>references/reviewer-dna.md</code> for future reviews.
      </p>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">DNA Section:</label>
        <select id="modalRuleSectionSelect" class="search-input">
          ${defaultSections.map((sec) => `<option value="${escapeHtml(sec)}">${escapeHtml(sec)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Rule Title (English):</label>
        <input type="text" id="modalRuleTitleInput" class="search-input" value="${escapeHtml(cleanTitle)}" />
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Description / Instruction for Agent (English):</label>
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
      showToast('Title and description are required.');
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
      if (!res.ok) throw new Error(data.error || 'Error adding rule');
      modal.classList.add('hidden');
      await loadRules();
      showToast(`Rule "${title}" added to reviewer-dna.md.`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
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
      ? `Publish inline comment ${finding.id} (${pr.repo}#${pr.number})`
      : `Publish general comment (${pr.repo}#${pr.number})`;
  confirmBtn.textContent = 'Confirm';

  const targetLineRangeLabel =
    finding.startLine && finding.endLine && Number(finding.endLine) > Number(finding.startLine)
      ? `${finding.filePath}:${finding.startLine}-${finding.endLine}`
      : `${finding.filePath}:${finding.endLine || finding.startLine || 1}`;

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <p style="margin:0;">
        <strong>Target:</strong>
        <code>${escapeHtml(mode === 'inline' ? targetLineRangeLabel : 'General PR conversation')}</code>
      </p>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:6px;">Markdown Content:</label>
        <textarea id="modalCommentTextarea" class="finding-textarea" style="min-height:150px;">${escapeHtml(finding.customComment)}</textarea>
      </div>
      <label class="checkbox-label" style="margin-top:4px;">
        <input type="checkbox" id="modalSaveAsAgentRuleCb" />
        <span>Also save this item as a permanent rule in <code>reviewer-dna.md</code></span>
      </label>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const editedBody = document.getElementById('modalCommentTextarea').value.trim();
    const saveAsRule = document.getElementById('modalSaveAsAgentRuleCb')?.checked;
    if (!editedBody) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Sending...';

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
          startLine: finding.startLine || finding.endLine || 1,
          endLine: finding.endLine || finding.startLine || 1,
          mode,
          cid: finding.cid,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to publish to GitHub');

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
          ? `Comment ${finding.id} published and rule added to reviewer-dna.md.`
          : `Comment ${finding.id} published on GitHub.`
      );
    } catch (err) {
      showToast(`Error: ${err.message}`, 5000);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
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

  titleEl.textContent = `Submit Review — ${pr.repo}#${pr.number}`;
  confirmBtn.textContent = 'Confirm';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div>
        <label style="display:block;font-weight:500;margin-bottom:6px;">GitHub Review Action:</label>
        <select id="modalReviewEventSelect" class="search-input">
          <option value="PENDING" ${defaultEvent === 'PENDING' ? 'selected' : ''}>PENDING — Create a draft Pending Review on GitHub (not submitted yet)</option>
          <option value="APPROVE" ${defaultEvent === 'APPROVE' ? 'selected' : ''}>APPROVE — Approve the PR</option>
          <option value="COMMENT" ${defaultEvent === 'COMMENT' ? 'selected' : ''}>COMMENT — Publish comments without blocking</option>
          <option value="REQUEST_CHANGES" ${defaultEvent === 'REQUEST_CHANGES' ? 'selected' : ''}>REQUEST_CHANGES — Request changes</option>
        </select>
      </div>

      <div>
        <label style="display:block;font-weight:500;margin-bottom:6px;">General summary message (optional):</label>
        <textarea id="modalReviewSummaryInput" class="finding-textarea" style="min-height:80px;" placeholder="LGTM / A few notes below..."></textarea>
      </div>

      <div>
        <label class="checkbox-label">
          <input type="checkbox" id="modalIncludeSelectedComments" ${selectedFindings.length > 0 ? 'checked' : ''} />
          <span>Include <strong>${selectedFindings.length} selected comment(s)</strong></span>
        </label>
        ${
          selectedFindings.length > 0
            ? `<ul style="margin:6px 0 0;padding-left:20px;color:var(--text-secondary);font-size:11.5px;">
                ${selectedFindings.map((f) => `<li><strong>${escapeHtml(f.id)}</strong> — ${escapeHtml(stripEmojis(f.title))} (${escapeHtml(f.filePath || 'General')})</li>`).join('')}
              </ul>`
            : `<p class="meta-text" style="margin:4px 0 0;">No comments checked (only the review verdict/summary message will be sent).</p>`
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
          startLine: f.startLine || f.endLine || 1,
          endLine: f.endLine || f.startLine || 1,
          body: f.customComment,
        }))
      : [];

    if (event === 'PENDING' && inlineComments.length === 0 && !summaryBody) {
      showToast('Select at least one comment or enter a summary message.');
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Sending...';

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
      if (!res.ok) throw new Error(data.error || 'Failed to create GitHub review');

      for (const f of selectedFindings) {
        if (includeComments) f.posted = true;
      }
      modal.classList.add('hidden');
      renderFindingsTab();
      loadState(true);
      showToast(
        event === 'PENDING'
          ? 'Pending Review (draft) created on GitHub.'
          : `Review (${event}) published on GitHub.`
      );
    } catch (err) {
      showToast(`Error: ${err.message}`, 5000);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
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

document.getElementById('prSortOrderBtn')?.addEventListener('click', () => {
  state.prSortOrder = state.prSortOrder === 'asc' ? 'desc' : 'asc';
  try {
    localStorage.setItem('prHub.prSortOrder', state.prSortOrder);
  } catch {
    // Ignore storage errors
  }
  renderPrList();
});

document.querySelectorAll('.view-tab').forEach((tab) => {
  tab.addEventListener('click', (e) => {
    const targetTab = tab.dataset.tab;
    if (state.splitMode) {
      if (e.shiftKey) {
        switchTab(targetTab, { splitSide: 'right' });
      } else {
        switchTab(targetTab, { splitSide: 'left' });
      }
      return;
    }
    switchTab(targetTab);
  });
});

document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme') || 'dark';
  const currentIdx = THEME_ORDER.indexOf(current);
  const next = THEME_ORDER[(currentIdx + 1) % THEME_ORDER.length];
  applySavedTheme(next);
  showToast(`Theme: ${THEME_LABELS[next] || next}`, 1800);
});

async function runQueueSync() {
  const btn = document.getElementById('syncQueueBtn');
  const spinner = document.getElementById('syncSpinner');
  if (btn) btn.disabled = true;
  if (spinner) spinner.classList.remove('hidden');
  showToast('Syncing with GitHub...');

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error running sync-queue.sh');
    await loadState(true);
    const actionableCount = data.scanResult?.actionable?.length || 0;
    showToast(`Queue synced (${actionableCount} actionable PR(s)).`);
  } catch (err) {
    showToast(`Error: ${err.message}`, 4500);
  } finally {
    if (btn) btn.disabled = false;
    if (spinner) spinner.classList.add('hidden');
  }
}

document.getElementById('syncQueueBtn')?.addEventListener('click', runQueueSync);

async function checkAppUpdateAvailability() {
  const btn = document.getElementById('appUpdateBtn');
  if (!btn) return;
  try {
    const res = await fetch('/api/app-update');
    if (!res.ok) return;
    const data = await res.json();
    if (data.version) {
      const badge = document.getElementById('appVersionBadge');
      if (badge) badge.textContent = `v${data.version}`;
    }
    if (data.updateAvailable && data.behindCount > 0) {
      btn.textContent = `⬆ Update (${data.behindCount})`;
      btn.title = data.latestCommitSubject
        ? `Pull ${data.behindCount} new commit(s): ${data.latestCommitSubject}`
        : `Pull ${data.behindCount} new commit(s) from GitHub`;
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  } catch {
    // ignore offline/network errors
  }
}

document.getElementById('appUpdateBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('appUpdateBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const res = await fetch('/api/app-update', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error pulling update');
    showToast('Updated to latest version! Reloading…', 2000);
    setTimeout(() => window.location.reload(), 900);
  } catch (err) {
    showToast(`Update error: ${err.message}`, 4500);
    btn.disabled = false;
    btn.textContent = '⬆ Update Available';
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
    showToast('No comments selected.');
    return;
  }
  const combined = findings
    .map((f) => `### ${f.id} — ${stripEmojis(f.title)}${f.filePath ? ` (\`${f.filePath}\`)` : ''}\n\n${f.customComment}`)
    .join('\n\n---\n\n');
  await navigator.clipboard.writeText(combined);
  showToast(`${findings.length} comment(s) copied.`);
});

document.getElementById('createPendingReviewBtn')?.addEventListener('click', () => {
  openBatchReviewModal('PENDING');
});

document.getElementById('openBatchReviewModalBtn')?.addEventListener('click', () => {
  openBatchReviewModal('APPROVE');
});

async function openSettingsModal() {
  const cfg = state.config || {};
  if (!state.teamProfiles || state.teamProfiles.length === 0) {
    await loadRules();
  }
  const profiles = state.teamProfiles || [];
  const activeProfileId = cfg.teamProfile || state.activeTeamProfile?.id || 'popcorn-back';
  const activeAgentCli = cfg.agentCli || 'agy';

  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = 'PR Review Hub Settings (Multi-Team & Multi-Account)';
  confirmBtn.textContent = 'Save';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">GitHub User:</label>
          <input type="text" id="cfgGithubUser" class="search-input" value="${escapeHtml(cfg.githubUser || '')}" placeholder="Auto-detected via gh auth" />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">GitHub Organization:</label>
          <input type="text" id="cfgGithubOrg" class="search-input" value="${escapeHtml(cfg.githubOrg || 'ubitransports')}" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Active Team Profile (Agent &amp; Team DNA):</label>
          <select id="cfgTeamProfile" class="search-input">
            ${profiles
              .map(
                (p) =>
                  `<option value="${escapeHtml(p.id)}" ${p.id === activeProfileId ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`
              )
              .join('')}
          </select>
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">AI Agent CLI Runner:</label>
          <select id="cfgAgentCli" class="search-input">
            <option value="agy" ${activeAgentCli === 'agy' ? 'selected' : ''}>Antigravity CLI (agy)</option>
            <option value="gemini" ${activeAgentCli === 'gemini' ? 'selected' : ''}>Gemini CLI (gemini)</option>
            <option value="claude" ${activeAgentCli === 'claude' ? 'selected' : ''}>Claude Code CLI (claude)</option>
          </select>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <label style="font-weight:500;">Watched GitHub Teams:</label>
          <button type="button" id="cfgDiscoverTeamsBtn" class="btn btn-ghost btn-xs">Detect my GitHub teams</button>
        </div>
        <div id="cfgDiscoveredTeamsBox" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;"></div>
        <input type="text" id="cfgGithubTeams" class="search-input" value="${escapeHtml((cfg.githubTeams || []).join(', '))}" placeholder="E.g.: ubi-eng-team-popcorn, popcorn-back" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Local repositories workspace (projectsDir):</label>
          <input type="text" id="cfgProjectsDir" class="search-input" value="${escapeHtml(cfg.projectsDir || '')}" />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Local reviews folder (reviewsDir):</label>
          <input type="text" id="cfgReviewsDir" class="search-input" value="${escapeHtml(cfg.reviewsDir || '')}" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Jira Base URL:</label>
          <input type="text" id="cfgJiraBaseUrl" class="search-input" value="${escapeHtml(cfg.jiraBaseUrl || 'https://ubitransport.atlassian.net/browse')}" />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Jira Prefixes:</label>
          <input type="text" id="cfgJiraPrefixes" class="search-input" value="${escapeHtml((cfg.jiraPrefixes || ['PRD', 'HYB', 'WAN', 'POP', 'OPS', 'SEC']).join(', '))}" />
        </div>
      </div>
      <div style="border-top:1px solid var(--border-color);padding-top:10px;margin-top:4px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
          <strong style="font-size:0.84rem;">System Health Check (Environment Doctor)</strong>
          <div style="display:flex;gap:6px;align-items:center;">
            <a href="/api/export-zip" class="btn btn-secondary btn-xs" title="Download a clean shareable .zip without personal local config">Download Shareable .zip</a>
            <button type="button" id="cfgRefreshDoctorBtn" class="btn btn-ghost btn-xs">Re-check</button>
          </div>
        </div>
        <div id="cfgDoctorStatusBox" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:0.78rem;">
          <span class="meta-text">Running diagnostic checks…</span>
        </div>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  const loadDoctorStatus = async () => {
    const docBox = document.getElementById('cfgDoctorStatusBox');
    if (!docBox) return;
    docBox.innerHTML = `<span class="meta-text">Running diagnostic checks…</span>`;
    try {
      const res = await fetch('/api/doctor');
      if (!res.ok) throw new Error('Doctor check failed');
      const report = await res.json();
      docBox.innerHTML = (report.checks || [])
        .map(
          (chk) => `
          <div style="background:var(--bg-elevated);padding:6px 8px;border-radius:6px;border:1px solid var(--border-color);display:flex;flex-direction:column;gap:2px;">
            <div style="display:flex;align-items:center;gap:6px;font-weight:600;">
              <span>${chk.ok ? '🟢' : '🔴'}</span>
              <span>${escapeHtml(chk.label)}</span>
            </div>
            <div class="meta-text" style="font-size:0.72rem;word-break:break-word;">${escapeHtml(chk.detail || '')}</div>
            ${!chk.ok && chk.fixHint ? `<div style="font-size:0.71rem;color:var(--accent-warning,#f59e0b);">Fix: <code>${escapeHtml(chk.fixHint)}</code></div>` : ''}
          </div>
        `
        )
        .join('');
    } catch (err) {
      docBox.innerHTML = `<span class="meta-text">Could not run diagnostics: ${escapeHtml(err.message)}</span>`;
    }
  };
  document.getElementById('cfgRefreshDoctorBtn')?.addEventListener('click', loadDoctorStatus);
  loadDoctorStatus();

  const renderDiscoveredTeamPills = async () => {
    const box = document.getElementById('cfgDiscoveredTeamsBox');
    const orgVal = document.getElementById('cfgGithubOrg')?.value.trim() || cfg.githubOrg || '';
    const teamsInput = document.getElementById('cfgGithubTeams');
    if (!box || !teamsInput) return;
    box.innerHTML = `<span class="meta-text">Searching GitHub teams...</span>`;
    try {
      const res = await fetch(`/api/github/teams?org=${encodeURIComponent(orgVal)}`);
      if (!res.ok) throw new Error('Unavailable');
      const data = await res.json();
      if (data.githubUser && !document.getElementById('cfgGithubUser').value.trim()) {
        document.getElementById('cfgGithubUser').value = data.githubUser;
      }
      const teams = data.teams || [];
      if (teams.length === 0) {
        box.innerHTML = `<span class="meta-text">No teams auto-detected for this organization.</span>`;
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
    const teamProfile = document.getElementById('cfgTeamProfile')?.value || 'popcorn-back';
    const agentCli = document.getElementById('cfgAgentCli')?.value || 'agy';
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
          teamProfile,
          agentCli,
          githubTeams,
          projectsDir,
          reviewsDir,
          jiraBaseUrl,
          jiraPrefixes,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error saving settings');
      state.config = data.config;
      modal.classList.add('hidden');
      await loadState(true);
      await loadRules();
      showToast('Settings saved.');
    } catch (err) {
      showToast(`Error: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
    }
  };
}

document.getElementById('settingsBtn')?.addEventListener('click', openSettingsModal);

async function openRexFeedbackModal() {
  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');
  if (!modal || !titleEl || !bodyEl || !confirmBtn) return;

  titleEl.textContent = 'Colleague Feedback & REX (Return on Experience)';
  confirmBtn.textContent = 'Add Feedback Note';

  let currentItems = [];
  let currentMarkdown = '';

  const renderRexModalBody = () => {
    const activePr = state.selectedPrKey || '';
    const activeTab = state.prQueueFullPage ? 'queue' : state.activeTab || 'report';
    bodyEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div class="meta-text">
          Log any bug, UX friction, AI false positive, or team rule idea while testing PR Review Hub. Export your REX in 1 click to share on Slack/Teams or GitHub.
        </div>
        <div style="display:grid;grid-template-columns:1.3fr 0.7fr 1fr;gap:10px;">
          <div>
            <label style="display:block;font-weight:500;margin-bottom:4px;">Category:</label>
            <select id="rexCategory" class="search-input">
              <option value="ux">✨ UX / Shortcuts / Ergonomics</option>
              <option value="bug">🐛 Bug / Issue</option>
              <option value="agent-quality">🤖 AI Agent Quality / False Positive</option>
              <option value="team-rule">📏 Team DNA Rule Idea</option>
              <option value="feature-request">🚀 Feature Request</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-weight:500;margin-bottom:4px;">Experience (1–5):</label>
            <select id="rexRating" class="search-input">
              <option value="5">★★★★★ (5/5)</option>
              <option value="4">★★★★☆ (4/5)</option>
              <option value="3">★★★☆☆ (3/5)</option>
              <option value="2">★★☆☆☆ (2/5)</option>
              <option value="1">★☆☆☆☆ (1/5)</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-weight:500;margin-bottom:4px;">PR Context (optional):</label>
            <input type="text" id="rexPrKey" class="search-input" value="${escapeHtml(activePr)}" placeholder="E.g.: 2cloud-services#5677" />
          </div>
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Summary / Title:</label>
          <input type="text" id="rexTitle" class="search-input" placeholder="E.g.: Diff file tree could auto-scroll to active file..." />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Details / Steps / Suggestion:</label>
          <textarea id="rexDescription" class="finding-textarea" rows="3" placeholder="Describe what happened or what would make your daily code reviews faster..."></textarea>
        </div>
        <div style="border-top:1px solid var(--border-color);padding-top:10px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <strong style="font-size:0.84rem;">Saved REX Notes (${currentItems.length})</strong>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" id="copyRexMarkdownBtn" class="btn btn-secondary btn-xs">📋 Copy REX Markdown for Slack</button>
              <button type="button" id="openRexGithubIssueBtn" class="btn btn-ghost btn-xs">🐙 Open GitHub Issue &#8599;</button>
            </div>
          </div>
          <div style="max-height:170px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;">
            ${
              currentItems.length === 0
                ? `<div class="meta-text">No REX notes saved yet. Add your first note above!</div>`
                : currentItems
                    .map(
                      (item) => `
                  <div style="background:var(--bg-elevated);padding:8px 10px;border-radius:6px;border:1px solid var(--border-color);display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
                    <div style="min-width:0;flex:1;">
                      <div style="font-weight:600;font-size:0.8rem;">
                        <span class="badge badge-mono">${escapeHtml(item.category || 'ux')}</span>
                        ${item.prKey ? `<span class="badge badge-mono">${escapeHtml(item.prKey)}</span>` : ''}
                        <span>${escapeHtml(item.title)}</span>
                      </div>
                      ${item.description ? `<div class="meta-text" style="font-size:0.75rem;margin-top:3px;white-space:pre-wrap;">${escapeHtml(item.description)}</div>` : ''}
                    </div>
                    <button type="button" class="btn btn-ghost btn-xs rex-delete-btn" data-rex-id="${escapeHtml(item.id)}" title="Delete note">&#10005;</button>
                  </div>
                `
                    )
                    .join('')
            }
          </div>
        </div>
      </div>
    `;

    bodyEl.querySelector('#copyRexMarkdownBtn')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(currentMarkdown || '# No REX notes yet');
      showToast('REX Markdown report copied to clipboard! Ready to paste in Slack/Teams.');
    });

    bodyEl.querySelector('#openRexGithubIssueBtn')?.addEventListener('click', () => {
      const issueTitle = encodeURIComponent(
        `[REX] Feedback from @${state.config?.githubUser || 'colleague'} (${state.config?.teamProfile || 'popcorn-back'})`
      );
      const issueBody = encodeURIComponent(currentMarkdown || '');
      window.open(
        `https://github.com/fawr-ubi/pr-review-hub/issues/new?title=${issueTitle}&body=${issueBody}`,
        '_blank',
        'noopener'
      );
    });

    bodyEl.querySelectorAll('.rex-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.rexId;
        if (!id) return;
        const res = await fetch('/api/rex', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (res.ok) {
          currentItems = data.items || [];
          currentMarkdown = data.markdown || '';
          renderRexModalBody();
        }
      });
    });

    confirmBtn.onclick = async () => {
      const category = document.getElementById('rexCategory')?.value || 'ux';
      const rating = Number(document.getElementById('rexRating')?.value || 5);
      const prKey = document.getElementById('rexPrKey')?.value.trim() || '';
      const title = document.getElementById('rexTitle')?.value.trim() || '';
      const description = document.getElementById('rexDescription')?.value.trim() || '';
      if (!title && !description) {
        showToast('Please enter a summary or details for your feedback note.');
        return;
      }
      confirmBtn.disabled = true;
      try {
        const res = await fetch('/api/rex', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category,
            rating,
            prKey,
            activeTab,
            title,
            description,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error saving feedback');
        currentItems = data.items || [];
        currentMarkdown = data.markdown || '';
        renderRexModalBody();
        showToast('REX note saved!');
      } catch (err) {
        showToast(`Error: ${err.message}`, 4000);
      } finally {
        confirmBtn.disabled = false;
      }
    };
  };

  try {
    const res = await fetch('/api/rex');
    if (res.ok) {
      const data = await res.json();
      currentItems = data.items || [];
      currentMarkdown = data.markdown || '';
    }
  } catch {
    // ignore
  }

  renderRexModalBody();
  modal.classList.remove('hidden');
}

document.getElementById('rexFeedbackBtn')?.addEventListener('click', openRexFeedbackModal);
document.getElementById('prTopbarRexBtn')?.addEventListener('click', openRexFeedbackModal);

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
    state.teamProfiles = data.teamProfiles || [];
    state.activeTeamProfile = data.activeTeamProfile || null;
    state.rules = data.rules || [];
    state.candidateRules = data.candidates || [];
    state.commonSections = data.commonSections || [];
    state.teamSections = data.teamSections || [];
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

    const teamCountEl = document.getElementById('rulesTeamCount');
    if (teamCountEl) {
      teamCountEl.textContent = String(state.rules.filter((r) => r.target === 'team').length);
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
  const activeProfile = state.activeTeamProfile || {
    id: state.config?.teamProfile || 'popcorn-back',
    name: 'Popcorn & Backend PHP',
    description: '',
    techStack: [],
    agentSkills: [],
    agentInstructions: '',
  };
  const profiles = state.teamProfiles || [];

  const teamProfileBannerHtml = `
    <div class="rule-card" style="border-left:3px solid var(--status-pass);background:var(--bg-elevated);margin-bottom:10px;">
      <div class="rule-card-header" style="flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="badge badge-pass">ACTIVE TEAM AGENT</span>
          <select id="activeTeamProfileSelect" class="search-input" style="min-width:260px;font-weight:600;">
            ${profiles
              .map(
                (p) =>
                  `<option value="${escapeHtml(p.id)}" ${p.id === activeProfile.id ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`
              )
              .join('')}
          </select>
          ${(activeProfile.techStack || [])
            .map((t) => `<span class="badge badge-mono">${escapeHtml(t)}</span>`)
            .join('')}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <button type="button" id="editTeamProfileBtn" class="btn btn-secondary btn-xs">Configure Team Agent</button>
          <button type="button" id="createNewTeamProfileBtn" class="btn btn-primary btn-xs">+ New Team Profile</button>
        </div>
      </div>
      ${
        activeProfile.agentInstructions || activeProfile.description
          ? `<div class="rule-card-body" style="margin-top:6px;font-size:12px;">
              ${activeProfile.description ? `<div style="margin-bottom:4px;"><strong>Scope:</strong> ${escapeHtml(activeProfile.description)}</div>` : ''}
              ${activeProfile.agentInstructions ? `<div><strong>Agent Focus:</strong> ${escapeHtml(activeProfile.agentInstructions)}</div>` : ''}
            </div>`
          : ''
      }
    </div>
  `;

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
        ? `No candidate rules pending validation. Click "Scan Team PRs (1y)" to extract review conventions from the last 365 days.`
        : `No rules match the current filter.`;
    listEl.innerHTML =
      teamProfileBannerHtml +
      `<div class="empty-card" style="margin:24px auto;"><p>${escapeHtml(emptyHint)}</p></div>`;
    bindTeamProfileBannerEvents();
    return;
  }

  const candidateBannerHtml =
    candidateItems.length > 0 && (state.rulesFilter === 'candidate' || state.rulesFilter === 'all')
      ? `
      <div class="rule-card" style="border-left:3px solid var(--accent);background:var(--bg-elevated);margin-bottom:8px;">
        <div class="rule-card-header">
          <div class="rule-card-title-group">
            <span class="badge badge-severity-question">TEAM ONBOARDING (1 YEAR)</span>
            <span class="rule-card-title">${candidateItems.length} candidate rule(s) synthesized from GitHub history — Validation required before activation</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button id="approveAllCandidatesTeamBtn" class="btn btn-secondary btn-xs">Approve All (Team DNA)</button>
            <button id="approveAllCandidatesLocalBtn" class="btn btn-primary btn-xs">Approve All (Local DNA)</button>
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
            ? `<div class="meta-text" style="margin-top:6px;">Detected examples (${r.occurrences || r.samples.length} occurrences): ${r.samples
                .map((s) => `<code>${escapeHtml(s.pr)}</code> (@${escapeHtml(s.reviewer)})`)
                .join(' · ')}</div>`
            : '';
        return `
          <div class="rule-card" style="border-left:3px solid var(--accent);" data-idx="${idx}">
            <div class="rule-card-header">
              <div class="rule-card-title-group">
                <span class="badge badge-severity-question">CANDIDATE TO VALIDATE</span>
                <span class="rule-section-pill">${escapeHtml(r.section || '1. Architecture, Serialization & Clean Code')}</span>
                <span class="rule-card-title">${escapeHtml(r.title)}</span>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <button class="btn btn-primary btn-xs approve-candidate-dna-btn" data-idx="${idx}" title="Approve and add to personal references/reviewer-dna.local.md">Approve (Local)</button>
                <button class="btn btn-secondary btn-xs approve-candidate-team-btn" data-idx="${idx}" title="Approve and add to shared team profile references/teams/${escapeHtml(activeProfile.id)}/team-dna.md">Approve (Team)</button>
                <button class="btn btn-secondary btn-xs approve-candidate-common-btn" data-idx="${idx}" title="Approve and add to shared references/common-dna.md">Approve (Common)</button>
                <button class="btn btn-ghost btn-xs edit-candidate-btn" data-idx="${idx}">Edit</button>
                <button class="btn btn-ghost btn-xs reject-candidate-btn" data-idx="${idx}">Reject</button>
              </div>
            </div>
            <div class="rule-card-body">${escapeHtml(r.body)}${samplesHtml}</div>
          </div>
        `;
      }

      const badgeLabel =
        r.target === 'common'
          ? 'COMMON DNA'
          : r.target === 'team'
          ? `TEAM DNA (${activeProfile.id.toUpperCase()})`
          : r.target === 'dna'
          ? 'LOCAL DNA'
          : 'FALSE POSITIVE';
      const badgeClass =
        r.target === 'common'
          ? 'badge-severity-nit'
          : r.target === 'team'
          ? 'badge-peer'
          : r.target === 'dna'
          ? 'badge-severity-ok'
          : 'badge-severity-major';

      return `
        <div class="rule-card ${r.target === 'false-positive' ? 'rule-fp' : 'rule-dna'}" data-idx="${idx}">
          <div class="rule-card-header">
            <div class="rule-card-title-group">
              <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
              <span class="rule-section-pill">${escapeHtml(r.section)}</span>
              <span class="rule-card-title">${escapeHtml(r.title)}</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${r.startLine ? `<span class="meta-text">L${r.startLine}</span>` : ''}
              <button class="btn btn-ghost btn-xs edit-rule-btn" data-idx="${idx}">Edit</button>
              <button class="btn btn-ghost btn-xs delete-rule-btn" data-idx="${idx}">Remove</button>
            </div>
          </div>
          <div class="rule-card-body">${escapeHtml(r.body)}</div>
        </div>
      `;
    })
    .join('');

  listEl.innerHTML = teamProfileBannerHtml + candidateBannerHtml + cardsHtml;
  bindTeamProfileBannerEvents();

  document.getElementById('approveAllCandidatesLocalBtn')?.addEventListener('click', async () => {
    await decideCandidateRuleAction({ action: 'approve-all', target: 'dna' });
  });

  document.getElementById('approveAllCandidatesTeamBtn')?.addEventListener('click', async () => {
    await decideCandidateRuleAction({ action: 'approve-all', target: 'team' });
  });

  listEl.querySelectorAll('.approve-candidate-dna-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) await decideCandidateRuleAction({ id: rule.id, action: 'approve', target: 'dna' });
    });
  });

  listEl.querySelectorAll('.approve-candidate-team-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rule = filtered[Number(btn.dataset.idx)];
      if (rule) await decideCandidateRuleAction({ id: rule.id, action: 'approve', target: 'team' });
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

function bindTeamProfileBannerEvents() {
  document.getElementById('activeTeamProfileSelect')?.addEventListener('change', async (e) => {
    const newTeamProfile = e.target.value;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamProfile: newTeamProfile }),
      });
      if (res.ok) {
        const data = await res.json();
        state.config = data.config;
        await loadRules();
        showToast(`Switched active Team Profile to "${newTeamProfile}".`);
      }
    } catch (err) {
      showToast(`Error switching team profile: ${err.message}`, 4000);
    }
  });

  document.getElementById('editTeamProfileBtn')?.addEventListener('click', () => {
    openTeamProfileModal(state.activeTeamProfile);
  });

  document.getElementById('createNewTeamProfileBtn')?.addEventListener('click', () => {
    openTeamProfileModal(null);
  });
}

function openTeamProfileModal(existingProfile = null) {
  const isEdit = Boolean(existingProfile);
  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = isEdit
    ? `Configure Team Agent Profile — ${existingProfile.name}`
    : 'Create New Team Agent Profile';
  confirmBtn.textContent = isEdit ? 'Save Team Profile' : 'Create & Activate Profile';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <p class="meta-text" style="margin:0;">
        Team profiles are stored in <code>references/teams/&lt;team-id&gt;/</code> (` +
    '`profile.json`' +
    ` + ` +
    '`team-dna.md`' +
    `) so each team can version its own agent instructions and review rules in Git without conflicts.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Team ID (slug):</label>
          <input type="text" id="teamProfIdInput" class="search-input" value="${escapeHtml(existingProfile?.id || '')}" placeholder="e.g. moneris-back, mobile-ios" ${isEdit ? 'readonly' : ''} />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Display Name:</label>
          <input type="text" id="teamProfNameInput" class="search-input" value="${escapeHtml(existingProfile?.name || '')}" placeholder="e.g. Moneris Backend (PHP / Symfony)" />
        </div>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Description / Scope:</label>
        <input type="text" id="teamProfDescInput" class="search-input" value="${escapeHtml(existingProfile?.description || '')}" placeholder="Short summary of repositories and scope covered by this team..." />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">Tech Stack (comma-separated):</label>
          <input type="text" id="teamProfStackInput" class="search-input" value="${escapeHtml((existingProfile?.techStack || []).join(', '))}" placeholder="e.g. PHP 8.3+, Symfony, Doctrine" />
        </div>
        <div>
          <label style="display:block;font-weight:500;margin-bottom:4px;">GitHub Team Slugs (comma-separated):</label>
          <input type="text" id="teamProfGhTeamsInput" class="search-input" value="${escapeHtml((existingProfile?.githubTeams || []).join(', '))}" placeholder="e.g. ubi-eng-team-popcorn, popcorn-back" />
        </div>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Team Agent System Instructions (injected into AI Reviews &amp; Q&amp;A):</label>
        <textarea id="teamProfInstructionsInput" class="finding-textarea" style="min-height:95px;" placeholder="Specify architectural priorities, frameworks, testing expectations, and patterns the AI agent must focus on for this team...">${escapeHtml(existingProfile?.agentInstructions || '')}</textarea>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    const id = document.getElementById('teamProfIdInput')?.value.trim();
    const name = document.getElementById('teamProfNameInput')?.value.trim();
    const description = document.getElementById('teamProfDescInput')?.value.trim();
    const techStack = document.getElementById('teamProfStackInput')?.value.trim();
    const githubTeams = document.getElementById('teamProfGhTeamsInput')?.value.trim();
    const agentInstructions = document.getElementById('teamProfInstructionsInput')?.value.trim();

    if (!id && !name) {
      showToast('Team ID and Display Name are required.');
      return;
    }

    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/teams/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id || name,
          name: name || id,
          description,
          techStack,
          githubTeams,
          agentInstructions,
          activate: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error saving team profile');
      state.config = data.config || state.config;
      modal.classList.add('hidden');
      await loadRules();
      showToast(`Team Profile "${data.profile?.name || name}" saved and activated.`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
    }
  };
}

async function decideCandidateRuleAction(payload) {
  try {
    const res = await fetch('/api/rules/candidates/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error updating candidate rule');
    await loadRules();
    showToast(
      payload.action === 'reject'
        ? 'Candidate rule rejected.'
        : payload.action === 'approve-all'
        ? `All candidate rules approved into ${payload.target === 'team' ? 'Team DNA' : 'Local DNA'}.`
        : `Rule approved and added (${payload.target === 'common' ? 'Common DNA' : payload.target === 'team' ? 'Team DNA' : 'Local DNA'}).`
    );
  } catch (err) {
    showToast(`Error: ${err.message}`, 4500);
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
  const activeProfileId = state.activeTeamProfile?.id || state.config?.teamProfile || 'popcorn-back';

  titleEl.textContent = `Edit & Approve Candidate Rule`;
  confirmBtn.textContent = 'Approve Rule';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Target:</label>
        <select id="candidateTargetSelect" class="search-input">
          <option value="dna">Local Personal DNA (references/reviewer-dna.local.md)</option>
          <option value="team">Team DNA (references/teams/${escapeHtml(activeProfileId)}/team-dna.md)</option>
          <option value="common">Common Org DNA (references/common-dna.md)</option>
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Section:</label>
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
        <label style="display:block;font-weight:500;margin-bottom:4px;">Rule Title (English):</label>
        <input type="text" id="candidateTitleInput" class="search-input" value="${escapeHtml(candidateRule.title || '')}" />
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Description / Instruction (English):</label>
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
      showToast('Title and description are required.');
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
    ? `Edit Rule: ${existingRule.title}`
    : target === 'false-positive'
    ? 'Add False Positive (false-positives.local.md)'
    : 'Add Agent Rule';
  confirmBtn.textContent = isEdit ? 'Update' : 'Add Rule';

  const activeProfileId = state.activeTeamProfile?.id || state.config?.teamProfile || 'popcorn-back';

  bodyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Target File:</label>
        <select id="editorRuleTargetSelect" class="search-input" ${isEdit ? 'disabled' : ''}>
          <option value="dna" ${target === 'dna' ? 'selected' : ''}>Local Personal DNA (references/reviewer-dna.local.md)</option>
          <option value="team" ${target === 'team' ? 'selected' : ''}>Team DNA (references/teams/${escapeHtml(activeProfileId)}/team-dna.md)</option>
          <option value="common" ${target === 'common' ? 'selected' : ''}>Common Org DNA (references/common-dna.md)</option>
          <option value="false-positive" ${target === 'false-positive' ? 'selected' : ''}>False Positives (references/false-positives.local.md)</option>
        </select>
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Section:</label>
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
        <label style="display:block;font-weight:500;margin-bottom:4px;">Rule Title (English):</label>
        <input type="text" id="editorRuleTitleInput" class="search-input" value="${escapeHtml(existingRule?.title || '')}" placeholder="E.g.: Strict DateTimeImmutable Usage" />
      </div>
      <div>
        <label style="display:block;font-weight:500;margin-bottom:4px;">Description / Instruction (English):</label>
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
      showToast('Title and description are required.');
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
      if (!res.ok) throw new Error(data.error || 'Error saving rule');
      modal.classList.add('hidden');
      await loadRules();
      showToast(isEdit ? `Rule "${title}" updated.` : `Rule "${title}" added.`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
    }
  };
}

function promptDeleteRule(rule) {
  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');

  titleEl.textContent = `Remove Agent Rule`;
  confirmBtn.textContent = 'Delete permanently';

  const targetFileLabel =
    rule.target === 'common'
      ? 'references/common-dna.md'
      : rule.target === 'false-positive'
      ? 'references/false-positives.local.md'
      : 'references/reviewer-dna.local.md';

  bodyEl.innerHTML = `
    <div>
      <p style="margin:0 0 8px;">
        Confirm deletion of rule <strong>${escapeHtml(rule.title)}</strong> from
        <code>${escapeHtml(targetFileLabel)}</code>?
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
      if (!res.ok) throw new Error(data.error || 'Error deleting rule');
      modal.classList.add('hidden');
      await loadRules();
      showToast(`Rule "${rule.title}" removed from agent.`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 4500);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
    }
  };
}

document.getElementById('bootstrapTeamRulesBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('bootstrapTeamRulesBtn');
  if (btn) btn.disabled = true;
  showToast('Scanning team PRs and review comments over 1 year (365d)...');
  try {
    const res = await fetch('/api/rules/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 365 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error scanning 1-year PR history');
    await loadRules();
    // Switch filter tab to "candidate" so the user sees the proposed rules to validate/reject
    state.rulesFilter = 'candidate';
    document
      .getElementById('rulesTargetFilterTabs')
      ?.querySelectorAll('.filter-tab')
      .forEach((b) => b.classList.toggle('active', b.dataset.ruleTarget === 'candidate'));
    renderRulesTab();
    showToast(
      `${data.addedCandidatesCount || 0} new candidate rule(s) extracted from ${data.analyzedCommentsCount || 0} comments (${data.analyzedPrsCount || 0} PRs).`
    );
  } catch (err) {
    showToast(`Error: ${err.message}`, 5000);
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
  const fileBtn = document.getElementById('toggleFileTreeBtn');
  const inlineDiffBtn = document.getElementById('diffToggleFilesInlineBtn');
  const inlineFocusBtn = document.getElementById('diffToggleFocusInlineBtn');
  const returnActiveBtn = document.getElementById('returnToActivePrBtn');

  appShell?.classList.toggle('pr-queue-fullpage', Boolean(state.prQueueFullPage));
  appShell?.classList.toggle('sidebar-collapsed', !state.prQueueFullPage);
  appShell?.classList.toggle('focus-diff-mode', !state.prQueueFullPage && state.focusDiffMode);
  diffLayout?.classList.toggle('file-tree-collapsed', state.fileTreeCollapsed);
  treeLayout?.classList.toggle('file-tree-collapsed', state.fileTreeCollapsed);

  if (returnActiveBtn) {
    returnActiveBtn.classList.toggle('hidden', !state.prQueueFullPage || !state.selectedPrKey);
    const activePr = state.prs.find((p) => p.key === state.selectedPrKey);
    if (activePr) {
      returnActiveBtn.textContent = `Resume ${activePr.repo} #${activePr.number} →`;
    }
  }

  if (fileBtn) {
    const isDiffVisible = state.splitMode
      ? state.splitLeftTab === 'diff' || state.splitRightTab === 'diff'
      : state.activeTab === 'diff';
    fileBtn.classList.toggle('hidden', !isDiffVisible);
    fileBtn.classList.toggle('btn-primary', state.fileTreeCollapsed);
  }
  if (inlineDiffBtn) {
    inlineDiffBtn.classList.toggle('btn-primary', state.fileTreeCollapsed);
    inlineDiffBtn.classList.toggle('btn-secondary', !state.fileTreeCollapsed);
  }
  if (inlineFocusBtn) {
    inlineFocusBtn.classList.toggle('btn-primary', state.focusDiffMode);
    inlineFocusBtn.classList.toggle('btn-secondary', !state.focusDiffMode);
  }
  syncKeybindingLegends();
}

async function enterPrReviewWorkspace(prKey, targetTab = null) {
  if (!prKey) return;
  const shouldReloadPr = state.selectedPrKey !== prKey || !state.currentDiff;
  state.prQueueFullPage = false;
  state.prSidebarCollapsed = true;

  // Clicking a PR (targetTab === null or 'report') opens the Audit Report view (`1. Audit Report`)
  // Clicking "Open Diff" (targetTab === 'diff') opens the Git Diff view
  const effectiveTab = targetTab || 'report';
  if (effectiveTab === 'diff') {
    state.fileTreeCollapsed = false;
    state.focusDiffMode = false;
    switchTab('diff');
  } else {
    state.focusDiffMode = false;
    switchTab(effectiveTab);
  }
  renderCollapsibleLayoutState();

  if (shouldReloadPr) {
    await selectPr(prKey, true);
  }
}

function showFullPagePrQueue() {
  state.focusDiffMode = false;
  state.prQueueFullPage = true;
  renderCollapsibleLayoutState();
}

function toggleFileTree() {
  state.fileTreeCollapsed = !state.fileTreeCollapsed;
  renderCollapsibleLayoutState();
}

function setFocusDiffMode(enabled, { keepFileTree = false } = {}) {
  if (enabled) {
    state._prevFileTree = state.fileTreeCollapsed;
    if (state.splitMode) {
      toggleSplitMode();
    }
    state.focusDiffMode = true;
    state.prQueueFullPage = false;
    state.fileTreeCollapsed = keepFileTree ? false : state.fileTreeCollapsed;
    switchTab('diff', { keepFocusDiff: true });
    renderCollapsibleLayoutState();
    setTimeout(() => {
      document.getElementById('diffScrollArea')?.focus({ preventScroll: true });
    }, 0);
  } else {
    state.focusDiffMode = false;
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

let activeRecordingShortcutId = null;

function openKeyboardShortcutsModal() {
  const modal = document.getElementById('githubModal');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const confirmBtn = document.getElementById('confirmModalBtn');
  if (!modal || !titleEl || !bodyEl || !confirmBtn) return;

  activeRecordingShortcutId = null;
  titleEl.textContent = 'Keyboard Shortcuts — Click a key to customize';
  confirmBtn.textContent = 'Close';

  const renderShortcutsModalContent = () => {
    const entries = Object.entries(DEFAULT_KEYBINDINGS);
    bodyEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:4px;">
        <span class="meta-text">Click any key badge below and press your desired key. All UI legends update automatically.</span>
        <button type="button" id="resetAllShortcutsBtn" class="btn btn-secondary btn-xs">Reset to default</button>
      </div>
      <div class="shortcuts-grid">
        ${entries
          .map(([actionId, def]) => {
            const currentKey = getKeybind(actionId);
            const isRecording = activeRecordingShortcutId === actionId;
            const isModified = currentKey !== def.key;
            const displayLabel = isRecording
              ? 'Press a key…'
              : formatKeybindLabel(currentKey);
            return `
              <div class="shortcut-row">
                <span>${escapeHtml(def.label)}</span>
                <span class="shortcut-keys">
                  <button
                    type="button"
                    class="shortcut-recorder-btn ${isRecording ? 'recording' : ''}"
                    data-action-id="${escapeHtml(actionId)}"
                    title="Click to change this shortcut (default: ${escapeHtml(formatKeybindLabel(def.key))})"
                  >${escapeHtml(displayLabel)}</button>
                  ${
                    isModified
                      ? `<button type="button" class="btn btn-ghost btn-xs shortcut-reset-one-btn" data-action-id="${escapeHtml(actionId)}" title="Reset to default (${escapeHtml(formatKeybindLabel(def.key))})">&#8634;</button>`
                      : ''
                  }
                </span>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    bodyEl.querySelector('#resetAllShortcutsBtn')?.addEventListener('click', () => {
      activeRecordingShortcutId = null;
      resetAllKeybindings();
      renderShortcutsModalContent();
      showToast('All keyboard shortcuts reset to default.');
    });

    bodyEl.querySelectorAll('.shortcut-recorder-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const actionId = btn.dataset.actionId;
        activeRecordingShortcutId = activeRecordingShortcutId === actionId ? null : actionId;
        renderShortcutsModalContent();
      });
    });

    bodyEl.querySelectorAll('.shortcut-reset-one-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const actionId = btn.dataset.actionId;
        activeRecordingShortcutId = null;
        resetKeybind(actionId);
        renderShortcutsModalContent();
      });
    });
  };

  renderShortcutsModalContent();
  modal._refreshShortcutsModal = renderShortcutsModalContent;

  modal.classList.remove('hidden');
  confirmBtn.onclick = () => {
    activeRecordingShortcutId = null;
    modal.classList.add('hidden');
  };
}

document.getElementById('toggleFileTreeBtn')?.addEventListener('click', toggleFileTree);
document.getElementById('openShortcutsBtn')?.addEventListener('click', openKeyboardShortcutsModal);
document.getElementById('topbarShortcutsBtn')?.addEventListener('click', openKeyboardShortcutsModal);
document.getElementById('backToPrQueueBtn')?.addEventListener('click', showFullPagePrQueue);
document.getElementById('returnToActivePrBtn')?.addEventListener('click', () => {
  if (state.selectedPrKey) {
    enterPrReviewWorkspace(state.selectedPrKey, null);
  }
});

// =============================================================================
// Keyboard Shortcuts (100% Keyboard-Driven & Customizable Interface)
// =============================================================================
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('githubModal');
  const isModalOpen = modal && !modal.classList.contains('hidden');

  // If the user is currently recording a custom keybind inside the shortcuts modal
  if (isModalOpen && activeRecordingShortcutId) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
      return;
    }
    if (e.key === 'Escape') {
      activeRecordingShortcutId = null;
      modal._refreshShortcutsModal?.();
      return;
    }
    const targetAction = activeRecordingShortcutId;
    activeRecordingShortcutId = null;
    setKeybind(targetAction, e.key);
    modal._refreshShortcutsModal?.();
    showToast(
      `Shortcut updated: ${DEFAULT_KEYBINDINGS[targetAction]?.label} → ${formatKeybindLabel(e.key)}`,
      2200
    );
    return;
  }

  if (e.key === 'Escape') {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) {
      e.target.blur();
      if (e.target?.id === 'agentChatInput' && state.chatOpen) {
        toggleChatDrawer(false);
      }
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

  if (e.key === getKeybind('openPr') && state.prQueueFullPage) {
    e.preventDefault();
    if (state.selectedPrKey) {
      enterPrReviewWorkspace(state.selectedPrKey, null);
    }
    return;
  }

  if (e.key === getKeybind('prQueue') || e.key === '[') {
    e.preventDefault();
    if (state.prQueueFullPage && state.selectedPrKey) {
      enterPrReviewWorkspace(state.selectedPrKey, null);
    } else {
      showFullPagePrQueue();
    }
    return;
  }

  if (
    (e.key === getKeybind('prevFile') || (getKeybind('prevFile') === 'ArrowLeft' && e.key === 'h')) &&
    !state.prQueueFullPage &&
    (state.focusDiffMode || state.activeTab === 'diff' || state.splitMode)
  ) {
    e.preventDefault();
    selectRelativeDiffFile(-1);
  } else if (
    (e.key === getKeybind('nextFile') || (getKeybind('nextFile') === 'ArrowRight' && e.key === 'l')) &&
    !state.prQueueFullPage &&
    (state.focusDiffMode || state.activeTab === 'diff' || state.splitMode)
  ) {
    e.preventDefault();
    selectRelativeDiffFile(1);
  } else if (e.key === getKeybind('nextPr') || e.key === getKeybind('prevPr')) {
    e.preventDefault();
    const list = getFilteredPrs();
    if (list.length === 0) return;
    const idx = list.findIndex((p) => p.key === state.selectedPrKey);
    const nextIdx =
      e.key === getKeybind('nextPr')
        ? Math.min(list.length - 1, idx + 1)
        : Math.max(0, idx <= 0 ? 0 : idx - 1);
    selectPr(list[nextIdx].key, true);
    const neighborPr = list[nextIdx + 1] || list[nextIdx - 1];
    if (neighborPr) prefetchPrData(neighborPr);
  } else if (e.key === getKeybind('nextHunk') || e.key === getKeybind('prevHunk')) {
    e.preventDefault();
    const delta = e.key === getKeybind('nextHunk') ? 1 : -1;
    if (state.focusDiffMode || state.activeTab === 'diff') {
      jumpToRelativeHunk(delta);
    } else if (state.activeTab === 'report' || state.activeTab === 'comments') {
      jumpToRelativeFinding(delta);
    }
  } else if (e.key === getKeybind('openIde')) {
    e.preventDefault();
    openCurrentPrInIde(
      'phpstorm',
      state.selectedDiffFile || '',
      state.highlightedLine || 1
    );
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
  } else if (e.key === getKeybind('tab1')) {
    switchTab('report');
  } else if (e.key === getKeybind('tab2')) {
    switchTab('overview');
  } else if (e.key === getKeybind('tab3')) {
    switchTab('diff');
  } else if (e.key === getKeybind('tab4')) {
    switchTab('comments');
  } else if (e.key === getKeybind('tab5')) {
    switchTab('rules');
  } else if (e.key === getKeybind('toggleFiles') || e.key === ']') {
    const isDiffVisible = state.splitMode
      ? state.splitLeftTab === 'diff' || state.splitRightTab === 'diff'
      : state.activeTab === 'diff';
    if (!state.prQueueFullPage && isDiffVisible) {
      e.preventDefault();
      toggleFileTree();
    }
  } else if (e.key === getKeybind('focusDiff') || (getKeybind('focusDiff') === 'z' && e.key === 'f')) {
    e.preventDefault();
    toggleZenMode();
  } else if (e.key === getKeybind('splitMode')) {
    e.preventDefault();
    if (state.focusDiffMode) setFocusDiffMode(false);
    toggleSplitMode();
  } else if (e.key === getKeybind('popout')) {
    openPopoutWorkspace();
  } else if (e.key === getKeybind('agentChat')) {
    e.preventDefault();
    toggleChatDrawer();
  } else if (e.key === getKeybind('rerunReview')) {
    e.preventDefault();
    if (state.selectedPrKey) triggerManualReviewForKey(state.selectedPrKey);
  } else if (e.key === getKeybind('openGithub')) {
    e.preventDefault();
    const ghHref = document.getElementById('openGithubPrBtn')?.href;
    if (ghHref && ghHref !== '#' && !ghHref.endsWith('#')) {
      window.open(ghHref, '_blank', 'noopener');
    }
  } else if (e.key === getKeybind('publishModal')) {
    e.preventDefault();
    openBatchReviewModal('APPROVE');
  } else if (e.key === getKeybind('searchPr')) {
    e.preventDefault();
    showFullPagePrQueue();
    document.getElementById('searchInput')?.focus();
  } else if (e.key === getKeybind('zoomOut') || e.key === '_') {
    e.preventDefault();
    adjustDiffZoom(-1);
  } else if (e.key === getKeybind('zoomIn') || e.key === '=') {
    e.preventDefault();
    adjustDiffZoom(1);
  } else if (e.key === getKeybind('zoomReset')) {
    e.preventDefault();
    applyDiffZoomVariables(100);
  } else if (e.key === getKeybind('helpModal')) {
    e.preventDefault();
    openKeyboardShortcutsModal();
  }
});

// Initial load
loadState(false);
loadRules();
checkAppUpdateAvailability();
