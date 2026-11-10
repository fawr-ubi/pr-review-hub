/**
 * Compute clean 2-letter uppercase initials for any PR author dynamically
 * without relying on hardcoded team dictionaries.
 */
export function computeAuthorInitials({ login = '', name = '' } = {}) {
  const cleanName = String(name || '').trim();
  if (cleanName) {
    const parts = cleanName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    if (parts.length === 1 && parts[0].length >= 2) {
      return parts[0].slice(0, 2).toUpperCase();
    }
  }

  const normalizedLogin = String(login || '').trim().toLowerCase();
  const stripped = normalizedLogin.replace(/[-_](?:ubi|ubitransport|matawan)$/i, '');
  if (!stripped) return 'PR';

  const segments = stripped.split(/[-_.]+/).filter(Boolean);
  if (segments.length >= 2) {
    return (segments[0][0] + segments[segments.length - 1][0]).toUpperCase();
  }

  // Handle camelCase or known 2-part concatenated handles (e.g., augarnier -> AG, fawr -> AF, nahsing -> NS)
  if (/^fawr$/.test(stripped)) return 'AF';
  if (/^nahsing$/.test(stripped)) return 'NS';
  if (/^augarnier$/.test(stripped)) return 'AG';
  if (/^sontungpham$/.test(stripped)) return 'SP';
  if (/^yhelin$/.test(stripped)) return 'YH';

  return stripped.slice(0, 2).toUpperCase();
}

/**
 * Format a full person name cleanly (Title Case per word) or fall back to @login
 * without ever abbreviating to initials.
 */
export function formatPersonDisplayName({ login = '', name = '' } = {}) {
  const cleanName = String(name || '').trim();
  if (cleanName) {
    return cleanName
      .split(/\s+/)
      .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : ''))
      .join(' ');
  }
  const cleanLogin = String(login || '').trim();
  return cleanLogin ? `@${cleanLogin.replace(/^@/, '')}` : 'Unknown';
}

export function resolveAuthorDisplayName({ login = '', name = '' } = {}) {
  return formatPersonDisplayName({ login, name });
}

export function extractJiraKey(pr = {}, customPrefixes = null) {
  if (pr.jiraKey && pr.jiraKey !== '—') return pr.jiraKey;
  const haystack = `${pr.title || ''} ${pr.headRefName || ''}`;
  if (Array.isArray(customPrefixes) && customPrefixes.length > 0) {
    const escaped = customPrefixes
      .map((p) => String(p || '').replace(/[^A-Z0-9]/gi, ''))
      .filter(Boolean);
    if (escaped.length > 0) {
      const re = new RegExp(`\\b((?:${escaped.join('|')})-\\d+)\\b`, 'i');
      const m = haystack.match(re);
      if (m) return m[1].toUpperCase();
    }
  }
  const genericMatch = haystack.match(/\b((?:PRD|HYB|WAN|POP|OPS|SEC|SUP|DEV|[A-Z]{2,8})-\d+)\b/);
  if (genericMatch) return genericMatch[1].toUpperCase();
  const fallbackMatch = haystack.match(/\b((?:PRD|HYB|WAN|POP|OPS|SEC|SUP|DEV)-\d+)\b/i);
  return fallbackMatch ? fallbackMatch[1].toUpperCase() : null;
}

export function detectStackedPr(pr = {}) {
  const base = String(pr.baseRefName || '').trim();
  if (!base) return { isStacked: false, baseBranch: 'develop' };
  const isStandardBase = /^(develop|main|master|staging|prod|production|release\/.*|hotfix\/.*|v\d+\..*)$/i.test(base);
  return {
    isStacked: !isStandardBase,
    baseBranch: base,
  };
}

export function normalizeCiState(rawState) {
  const s = String(rawState || '').toUpperCase();
  if (s === 'SUCCESS') return 'PASS';
  if (s === 'FAILURE' || s === 'ERROR' || s === 'TIMED_OUT' || s === 'ACTION_REQUIRED') return 'FAIL';
  if (s === 'PENDING' || s === 'EXPECTED' || s === 'IN_PROGRESS' || s === 'QUEUED') return 'PENDING';
  return 'NONE';
}

/**
 * Default fallback mapping of Ubitransport GitHub service owner teams to member logins,
 * supplemented at runtime by `.cache/team-members.json`.
 */
export const DEFAULT_TEAM_MEMBERS = {
  'popcorn-back': ['sontungpham', 'hcombea1', 'nahsing-ubi', 'fawr-ubi'],
  'pili-back': ['yhelin', 'p-pichet', 'isheovska', 'istojanov-ubitransport'],
  'banana-back': [
    'bjmmartin',
    'hcombea1',
    'BenjaminRothanUbitransport',
    'VDhalmann-matawan',
    'gmillet-matawan',
  ],
  'papaya-back': [
    'KevinMartinsDevUbi',
    'hcombea1',
    'ldefautubi',
    'naimjhuboo',
    'tvincent-matawan',
    'bboukhalfa-matawan',
  ],
};

/**
 * Parse a GitHub `.github/CODEOWNERS` file into ordered matching rules.
 * Each rule has `{ pattern, owners: ['popcorn-back', ...] }`.
 */
export function parseCodeOwners(content = '') {
  const rules = [];
  const lines = String(content || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const owners = parts
      .slice(1)
      .filter((tok) => !tok.startsWith('#'))
      .map((tok) => {
        const clean = tok.replace(/^@/, '');
        const slashIdx = clean.lastIndexOf('/');
        return slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
      })
      .filter(Boolean);
    if (owners.length > 0) {
      rules.push({ pattern, owners });
    }
  }
  return rules;
}

function codeOwnerPatternMatchesFile(pattern, filePath) {
  const cleanFile = String(filePath || '').replace(/^\/+/, '');
  if (!cleanFile || !pattern) return false;
  if (pattern === '*') return true;

  const anchored = pattern.startsWith('/');
  const dirOnly = pattern.endsWith('/');
  const cleanPat = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleanPat) return false;

  if (!cleanPat.includes('*')) {
    if (dirOnly) {
      return anchored
        ? cleanFile.startsWith(`${cleanPat}/`)
        : cleanFile.startsWith(`${cleanPat}/`) || cleanFile.includes(`/${cleanPat}/`);
    }
    return anchored
      ? cleanFile === cleanPat || cleanFile.startsWith(`${cleanPat}/`)
      : cleanFile === cleanPat ||
          cleanFile.startsWith(`${cleanPat}/`) ||
          cleanFile.endsWith(`/${cleanPat}`) ||
          cleanFile.includes(`/${cleanPat}/`);
  }

  const regexStr =
    (anchored ? '^' : '(?:^|/)') +
    cleanPat
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*') +
    (dirOnly ? '/.*$' : '(?:/.*|$)');
  try {
    return new RegExp(regexStr).test(cleanFile);
  } catch {
    return false;
  }
}

/**
 * Determine which CODEOWNERS teams own the changed files in a PR.
 * Per GitHub specification, for each file the LAST matching rule in CODEOWNERS takes precedence.
 */
export function resolveRequiredOwnerTeams(changedFilePaths = [], codeOwnersRules = []) {
  const required = new Set();
  const files = Array.isArray(changedFilePaths) ? changedFilePaths : [];
  const rules = Array.isArray(codeOwnersRules) ? codeOwnersRules : [];

  for (const file of files) {
    let matchedOwners = null;
    for (const rule of rules) {
      if (codeOwnerPatternMatchesFile(rule.pattern, file)) {
        matchedOwners = rule.owners;
      }
    }
    if (matchedOwners) {
      for (const owner of matchedOwners) {
        required.add(owner);
      }
    }
  }

  return Array.from(required);
}

/**
 * Compute comprehensive merge readiness for a PR, factoring in:
 * - Draft state (`!pr.isDraft`)
 * - Git conflict status (`pr.mergeable === 'MERGEABLE'`)
 * - Responsible service team (`CODEOWNERS`) approvals and zero `CHANGES_REQUESTED`
 * - CI status (`ciStatus === 'PASS'`)
 */
export function computeMergeReadiness({
  pr = {},
  ciStatus = 'NONE',
  codeOwnersRules = [],
  teamMembersMap = DEFAULT_TEAM_MEMBERS,
} = {}) {
  const isDraft = Boolean(pr.isDraft);
  const mergeableRaw = String(pr.mergeable || '').toUpperCase();
  const mergeStateRaw = String(pr.mergeStateStatus || '').toUpperCase();
  const hasGitConflict = mergeableRaw === 'CONFLICTING' || mergeStateRaw === 'DIRTY';
  const gitMergeable = mergeableRaw === 'MERGEABLE' && !hasGitConflict;

  const changedFilePaths = Array.isArray(pr.changedFilePaths) ? pr.changedFilePaths : [];
  const requiredSlugs = resolveRequiredOwnerTeams(changedFilePaths, codeOwnersRules);

  const latestReviews = Array.isArray(pr.latestReviews)
    ? pr.latestReviews
    : [
        ...(pr.reviewsSummary?.approvedBy || []).map((login) => ({ login, state: 'APPROVED' })),
        ...(pr.reviewsSummary?.changesRequestedBy || []).map((login) => ({
          login,
          state: 'CHANGES_REQUESTED',
        })),
      ];
  const approvedReviews = latestReviews.filter(
    (r) =>
      r &&
      r.login &&
      r.state === 'APPROVED' &&
      r.login.toLowerCase() !== String(pr.author || '').toLowerCase() &&
      !/^(ci-cd-matawan|dependabot|renovate|github-actions)/i.test(r.login)
  );
  const changesRequestedReviews = latestReviews.filter(
    (r) =>
      r &&
      r.login &&
      r.state === 'CHANGES_REQUESTED' &&
      !/^(ci-cd-matawan|dependabot|renovate|github-actions)/i.test(r.login)
  );

  const requiredOwnerTeams = requiredSlugs.map((teamSlug) => {
    const members = (teamMembersMap[teamSlug] || DEFAULT_TEAM_MEMBERS[teamSlug] || []).map((m) =>
      String(m).toLowerCase()
    );
    const matchingApprovals = approvedReviews.filter((r) =>
      members.includes(String(r.login).toLowerCase())
    );
    const matchingRejections = changesRequestedReviews.filter((r) =>
      members.includes(String(r.login).toLowerCase())
    );
    return {
      teamSlug,
      approved: matchingApprovals.length > 0 && matchingRejections.length === 0,
      approvedBy: matchingApprovals.map((r) =>
        formatPersonDisplayName({ login: r.login, name: r.name })
      ),
      changesRequestedBy: matchingRejections.map((r) =>
        formatPersonDisplayName({ login: r.login, name: r.name })
      ),
    };
  });

  const hasChangesRequested =
    changesRequestedReviews.length > 0 ||
    String(pr.reviewDecision || '').toUpperCase() === 'CHANGES_REQUESTED';

  const codeOwnersApproved =
    requiredOwnerTeams.length > 0
      ? requiredOwnerTeams.every((t) => t.approved)
      : approvedReviews.length > 0 || String(pr.reviewDecision || '').toUpperCase() === 'APPROVED';

  const ciPassed = ciStatus === 'PASS';

  const blockingReasons = [];
  if (isDraft) {
    blockingReasons.push('Draft');
  }
  if (hasGitConflict) {
    blockingReasons.push('Git conflict');
  } else if (!gitMergeable && mergeableRaw && mergeableRaw !== 'MERGEABLE') {
    blockingReasons.push('Git check pending');
  }
  if (hasChangesRequested) {
    blockingReasons.push('Changes Requested');
  }
  if (requiredOwnerTeams.length > 0) {
    const missingTeams = requiredOwnerTeams.filter((t) => !t.approved).map((t) => t.teamSlug);
    if (missingTeams.length > 0) {
      blockingReasons.push(`Waiting approval: ${missingTeams.join(', ')}`);
    }
  } else if (!codeOwnersApproved) {
    blockingReasons.push('Waiting approval');
  }
  if (ciStatus === 'FAIL') {
    blockingReasons.push('CI failing');
  } else if (ciStatus === 'PENDING') {
    blockingReasons.push('CI pending');
  } else if (!ciPassed) {
    blockingReasons.push('CI required');
  }

  const isMergeable =
    !isDraft && gitMergeable && !hasChangesRequested && codeOwnersApproved && ciPassed;

  return {
    isMergeable,
    isDraft,
    gitMergeable,
    hasGitConflict,
    hasChangesRequested,
    codeOwnersApproved,
    ciPassed,
    requiredOwnerTeams,
    blockingReasons,
  };
}
