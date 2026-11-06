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

export function resolveAuthorDisplayName({ login = '', name = '' } = {}) {
  const cleanName = String(name || '').trim();
  if (cleanName) return cleanName;
  return String(login || '').trim() || 'Unknown';
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
