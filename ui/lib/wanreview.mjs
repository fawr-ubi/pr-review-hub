import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { inferDomainForRule } from './scoring.mjs';
import { parseCodeOwners } from './metadata.mjs';

const execFileAsync = promisify(execFile);

/**
 * Exact schema constants matching `ubitransports/wanreview/tools/resolve.py`
 * (`RULE_KEYS`, `SEVERITIES`, `STATUSES`, `ACTIVE_STATUSES`, `STATUS_RANK`).
 */
export const WANREVIEW_REPO_SLUG = 'ubitransports/wanreview';
export const WANREVIEW_BLOB_BASE_URL = 'https://github.com/ubitransports/wanreview/blob/master';
export const WANREVIEW_RULE_KEYS = new Set(['id', 'title', 'severity', 'status', 'locked']);
export const WANREVIEW_LAYER_KEYS = new Set(['overrides', 'disable']);
export const WANREVIEW_TEAM_LAYER_KEYS = new Set(['overrides', 'disable', 'vertical']);
export const WANREVIEW_REPO_LAYER_KEYS = new Set(['overrides', 'disable', 'exclude_paths', 'rereview']);
export const WANREVIEW_SEVERITIES = ['low', 'medium', 'high'];
export const WANREVIEW_STATUSES = ['proposed', 'advisory', 'enforced', 'deprecated'];
export const WANREVIEW_ACTIVE_STATUSES = new Set(['advisory', 'enforced']);
export const WANREVIEW_STATUS_RANK = {
  proposed: 0,
  advisory: 1,
  enforced: 2,
  deprecated: -1,
};

export function getDefaultManagedWanreviewDir() {
  return path.join(os.homedir(), '.config', 'pr-review-hub', 'wanreview');
}

export function slugifyWanreviewRuleId(raw = '') {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\(\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'custom-rule';
  if (cleaned.length <= 76) return cleaned;
  const sliced = cleaned.slice(0, 76);
  const lastDash = sliced.lastIndexOf('-');
  return (lastDash > 24 ? sliced.slice(0, lastDash) : sliced).replace(/-+$/g, '');
}

/**
 * Normalizes a GitHub team slug or Hub squad profile ID into the canonical `wanreview`
 * `rules/teams/<team>` directory name and default vertical.
 */
export function normalizeWanreviewTeamSlug(rawTeam = '') {
  const s = String(rawTeam || '')
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, '');
  if (!s) return '';
  if (s === 'popcorn-back' || s === 'ubi-eng-popcorn' || s === 'ubi-eng-team-popcorn' || s === 'moneris-back') {
    return 'popcorn-back';
  }
  if (s === 'pili-back' || s === 'ubi-eng-pili' || s === 'ubi-eng-team-pili') {
    return 'pili-back';
  }
  if (s === 'banana-back' || s === 'ubi-eng-banana' || s === 'ubi-eng-team-banana') {
    return 'banana-back';
  }
  if (s === 'papaya-back' || s === 'ubi-eng-papaya' || s === 'ubi-eng-team-papaya') {
    return 'papaya-back';
  }
  return s;
}

export function mapHubTeamToWanreview(teamProfileId = '') {
  const canonicalTeam = normalizeWanreviewTeamSlug(teamProfileId);
  if (
    canonicalTeam === 'popcorn-back' ||
    canonicalTeam === 'pili-back' ||
    canonicalTeam === 'banana-back' ||
    canonicalTeam === 'papaya-back'
  ) {
    return { vertical: 'wfwp-backend', team: canonicalTeam };
  }
  if (canonicalTeam === 'frontend-web') {
    return { vertical: 'frontend-web', team: 'frontend-web' };
  }
  if (canonicalTeam === 'mobile-kotlin') {
    return { vertical: 'mobile-kotlin', team: 'mobile-kotlin' };
  }
  if (canonicalTeam === 'qa-automation') {
    return { vertical: 'qa-automation', team: 'qa-automation' };
  }
  return { vertical: 'wfwp-backend', team: canonicalTeam || 'popcorn-back' };
}

export function inferWanreviewSeverityFromRule(rule = {}) {
  const explicit = String(rule.severity || '').trim().toLowerCase();
  if (WANREVIEW_SEVERITIES.includes(explicit)) return explicit;
  const text = `${rule.section || ''} ${rule.title || ''} ${rule.body || ''}`;
  if (
    /🔴|\b(critical|blocker|blocking|security|tenant|voter|secret|injection|ban|never call \$em->flush)\b/i.test(
      text
    )
  ) {
    return 'high';
  }
  if (/🔵|\b(nitpick|nit|style|formatting|typo)\b/i.test(text)) {
    return 'low';
  }
  return 'medium';
}

export function inferWanreviewStatusFromRule(rule = {}) {
  const explicit = String(rule.status || '').trim().toLowerCase();
  if (WANREVIEW_STATUSES.includes(explicit)) return explicit;
  if (rule.source === 'candidate' || rule.target === 'candidate') return 'proposed';
  return 'enforced';
}

function yamlScalarSafe(value = '') {
  const str = String(value || '').replace(/\r?\n/g, ' ').trim();
  if (/[:#[\]{}&*!|>'"%@`]/.test(str) || str.startsWith('-') || str.startsWith('?')) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return str;
}

function parseScalarYamlValue(rawVal = '') {
  const val = String(rawVal || '').trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === '[]') return [];
  if (val === '{}') return {};
  return val;
}

/**
 * Parses YAML frontmatter + Markdown body mirroring `wanreview/tools/resolve.py`
 * (supports top-level scalars, string lists like `disable:`, and 2-level maps like `overrides:`).
 */
export function parseWanreviewMarkdown(raw = '') {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) {
    return {
      valid: false,
      error: 'Missing leading YAML frontmatter delimiter (---)',
      meta: {},
      body: text,
    };
  }
  const match = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/);
  if (!match) {
    return {
      valid: false,
      error: 'Unclosed YAML frontmatter delimiter (---)',
      meta: {},
      body: text,
    };
  }

  const meta = {};
  const lines = match[1].split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const topKv = line.match(/^([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/);
    if (!topKv) {
      return {
        valid: false,
        error: `Unsupported or malformed YAML line: "${line}"`,
        meta,
        body: (match[2] || '').trim(),
      };
    }

    const key = topKv[1].trim();
    const rest = topKv[2].trim();
    i++;

    if (rest !== '') {
      meta[key] = parseScalarYamlValue(rest);
      continue;
    }

    // Collect indented block for lists (`disable:`) or nested maps (`overrides:`)
    const childLines = [];
    while (i < lines.length) {
      const nextLine = lines[i];
      if (!nextLine.trim() || nextLine.trim().startsWith('#')) {
        i++;
        continue;
      }
      if (/^\s+/.test(nextLine)) {
        childLines.push(nextLine);
        i++;
      } else {
        break;
      }
    }

    if (childLines.length === 0) {
      meta[key] = null;
      continue;
    }

    if (/^\s*-\s+/.test(childLines[0])) {
      meta[key] = childLines
        .map((cl) => {
          const m = cl.match(/^\s*-\s+(.+)$/);
          return m ? parseScalarYamlValue(m[1]) : null;
        })
        .filter((v) => v !== null);
    } else {
      // Nested mapping (e.g. `overrides:\n  wfwp-backend.rule-id:\n    severity: high`)
      const nestedObj = {};
      let currentSubKey = null;
      for (const cl of childLines) {
        const subMatch = cl.match(/^ {2}([a-zA-Z0-9_.-]+)\s*:\s*(.*)$/);
        if (subMatch) {
          currentSubKey = subMatch[1].trim();
          const subVal = subMatch[2].trim();
          nestedObj[currentSubKey] = subVal ? parseScalarYamlValue(subVal) : {};
          continue;
        }
        const leafMatch = cl.match(/^\s{4,}([a-zA-Z0-9_.-]+)\s*:\s*(.+)$/);
        if (leafMatch && currentSubKey && typeof nestedObj[currentSubKey] === 'object') {
          nestedObj[currentSubKey][leafMatch[1].trim()] = parseScalarYamlValue(leafMatch[2]);
        }
      }
      meta[key] = nestedObj;
    }
  }

  return { valid: true, error: null, meta, body: (match[2] || '').trim() };
}

/**
 * Validates a rule Markdown file against `wanreview/tools/resolve.py`.
 * - `resolve.py` allows namespaced IDs (`wfwp-backend.tenant-isolation` inside `tenant-isolation.md`),
 *   optional `status` (defaults to `'enforced'`), and any non-empty Markdown body.
 * - When `strictAuthoring = true` (exporting/proposing new rules), we also enforce `## Flag` & `## Accept`
 *   sections for crisp, uniform rule quality.
 */
export function validateWanreviewRuleMarkdown(
  markdown = '',
  expectedStem = '',
  { strictAuthoring = false } = {}
) {
  const parsed = parseWanreviewMarkdown(markdown);
  if (!parsed.valid) {
    return { valid: false, errors: [parsed.error], meta: parsed.meta, body: parsed.body };
  }

  const errors = [];
  const meta = { ...parsed.meta };
  const { body } = parsed;

  const unknownKeys = Object.keys(meta).filter((k) => !WANREVIEW_RULE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown frontmatter keys rejected by resolve.py: ${unknownKeys.join(', ')}`);
  }

  for (const reqKey of ['id', 'title', 'severity']) {
    if (!meta[reqKey] || typeof meta[reqKey] !== 'string') {
      errors.push(`Missing required string frontmatter field: "${reqKey}"`);
    }
  }

  if (meta.status === undefined || meta.status === null || meta.status === '') {
    if (strictAuthoring) {
      errors.push('Missing required string frontmatter field: "status"');
    } else {
      meta.status = 'enforced';
    }
  }

  if (expectedStem && strictAuthoring && meta.id) {
    const idTail = String(meta.id).split('.').pop();
    if (meta.id !== expectedStem && idTail !== expectedStem) {
      errors.push(`Rule id "${meta.id}" does not match filename stem "${expectedStem}"`);
    }
  }

  if (meta.severity && !WANREVIEW_SEVERITIES.includes(meta.severity)) {
    errors.push(
      `Invalid severity "${meta.severity}" (expected one of: ${WANREVIEW_SEVERITIES.join(', ')})`
    );
  }

  if (meta.status && !WANREVIEW_STATUSES.includes(meta.status)) {
    errors.push(
      `Invalid status "${meta.status}" (expected one of: ${WANREVIEW_STATUSES.join(', ')})`
    );
  }

  if (meta.locked !== undefined && typeof meta.locked !== 'boolean') {
    errors.push('Field "locked" must be a boolean if present');
  }

  if (!body || !body.trim()) {
    errors.push('Rule body cannot be empty');
  } else if (strictAuthoring) {
    if (!/^##\s+Flag\b/m.test(body)) {
      errors.push('Missing "## Flag" section in rule body');
    }
    if (!/^##\s+Accept\b/m.test(body)) {
      errors.push('Missing "## Accept" section in rule body');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    meta,
    body,
  };
}

function splitRuleBodyIntoDescriptionFlagAccept(title = '', rawBody = '') {
  const body = String(rawBody || '').trim();
  if (/^##\s+Flag\b/m.test(body) && /^##\s+Accept\b/m.test(body)) {
    return body;
  }

  const cleanedLines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean);

  const summaryLine =
    cleanedLines[0] || `Enforce ${title} consistently across reviewed Pull Requests.`;

  const flagLines = [];
  const acceptLines = [];

  for (const line of cleanedLines) {
    if (
      /\b(never|do not|don't|avoid|ban|forbid|missing|without|instead of|line-by-line|untyped)\b/i.test(
        line
      )
    ) {
      flagLines.push(`- ${line}`);
    } else if (
      /\b(use|prefer|delegate|verify|return|instantiate|keep|explicitly|allow|except)\b/i.test(
        line
      )
    ) {
      acceptLines.push(`- ${line}`);
    }
  }

  if (flagLines.length === 0) {
    flagLines.push(`- Code changes that violate "${title}": ${summaryLine}`);
  }
  if (acceptLines.length === 0) {
    acceptLines.push(
      `- Compliant implementations following "${title}" idioms and explicit project conventions.`
    );
  }

  return [summaryLine, '', '## Flag', ...flagLines, '', '## Accept', ...acceptLines].join('\n');
}

/**
 * Converts a Hub rule/finding into a 100% `wanreview`-compliant atomic `.md` file
 * matching `ubitransports/wanreview` conventions:
 * - `rules/org/<slug>.md` (`id: org.<slug>`)
 * - `rules/verticals/<vertical>/<slug>.md` (`id: <vertical>.<slug>`)
 * - `rules/teams/<team>/<slug>.md` (`id: <team>.<slug>`)
 */
export function convertHubRuleToWanreview(rule = {}, options = {}) {
  const {
    layer = '',
    vertical = 'wfwp-backend',
    team = 'popcorn-back',
    statusOverride = '',
    severityOverride = '',
    locked = false,
    namespacedId = true,
  } = options;

  const resolvedLayer =
    layer ||
    (rule.source === 'org' || rule.source === 'wanreview-org'
      ? 'org'
      : rule.source === 'common' || rule.source === 'common-dna' || rule.layer === 'vertical'
      ? 'vertical'
      : 'team');

  const cleanTitle = String(rule.title || 'Untitled Rule')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const rawSlugSource = options.customId || rule.wanreviewId || cleanTitle;
  const stemSlug = slugifyWanreviewRuleId(String(rawSlugSource).split('.').pop() || cleanTitle);
  const cleanVertical = slugifyWanreviewRuleId(vertical || 'wfwp-backend');
  const cleanTeam = slugifyWanreviewRuleId(normalizeWanreviewTeamSlug(team) || 'popcorn-back');

  const prefix =
    resolvedLayer === 'org' ? 'org' : resolvedLayer === 'vertical' ? cleanVertical : cleanTeam;
  const fullRuleId =
    options.customId && String(options.customId).includes('.')
      ? String(options.customId).trim()
      : namespacedId
      ? `${prefix}.${stemSlug}`
      : stemSlug;

  const severity = WANREVIEW_SEVERITIES.includes(severityOverride)
    ? severityOverride
    : inferWanreviewSeverityFromRule(rule);
  const status = WANREVIEW_STATUSES.includes(statusOverride)
    ? statusOverride
    : inferWanreviewStatusFromRule(rule);

  const fmLines = [
    '---',
    `id: ${fullRuleId}`,
    `title: ${yamlScalarSafe(cleanTitle)}`,
    `severity: ${severity}`,
    `status: ${status}`,
  ];
  if (Boolean(locked) && resolvedLayer === 'org') {
    fmLines.push('locked: true');
  }
  fmLines.push('---');

  const structuredBody = splitRuleBodyIntoDescriptionFlagAccept(cleanTitle, rule.body || '');
  const markdown = `${fmLines.join('\n')}\n\n${structuredBody}\n`;

  let relativePath = '';
  if (resolvedLayer === 'org') {
    relativePath = path.posix.join('rules', 'org', `${stemSlug}.md`);
  } else if (resolvedLayer === 'vertical') {
    relativePath = path.posix.join('rules', 'verticals', cleanVertical, `${stemSlug}.md`);
  } else {
    relativePath = path.posix.join('rules', 'teams', cleanTeam, `${stemSlug}.md`);
  }

  const validation = validateWanreviewRuleMarkdown(markdown, stemSlug, {
    strictAuthoring: true,
  });

  return {
    id: fullRuleId,
    stem: stemSlug,
    title: cleanTitle,
    severity,
    status,
    locked: Boolean(locked) && resolvedLayer === 'org',
    layer: resolvedLayer,
    domain: inferDomainForRule(rule),
    isPersonalSource:
      rule.source === 'dna' || rule.source === 'false-positive' || rule.source === 'fp',
    relativePath,
    markdown,
    valid: validation.valid,
    errors: validation.errors,
  };
}

/**
 * Exports selected rules as surgical, `resolve.py`-validated `.md` files into a target directory.
 */
export function exportRulesToWanreviewDirectory({
  rules = [],
  targetRootDir = '',
  layer = '',
  vertical = 'wfwp-backend',
  team = 'popcorn-back',
  statusOverride = '',
  allowPersonalPromotion = false,
  writeToDisk = false,
} = {}) {
  const exported = [];
  const skippedPersonal = [];

  for (const rule of rules) {
    if (!rule) continue;
    const isPersonal =
      rule.source === 'dna' || rule.source === 'false-positive' || rule.source === 'fp';
    if (isPersonal && !allowPersonalPromotion) {
      skippedPersonal.push({
        id: rule.id,
        title: rule.title,
        reason: 'Personal (.local.md) rules are excluded by default from shared wanreview exports.',
      });
      continue;
    }

    const item = convertHubRuleToWanreview(rule, {
      layer: layer || rule.exportLayer || '',
      vertical,
      team,
      statusOverride: statusOverride || rule.exportStatus || '',
      severityOverride: rule.exportSeverity || '',
      locked: Boolean(rule.locked),
      customId: rule.exportId || '',
    });

    if (!item.valid) {
      throw new Error(
        `Invalid wanreview rule generated for "${item.id}": ${item.errors.join('; ')}`
      );
    }

    let absolutePath = null;
    if (writeToDisk) {
      if (!targetRootDir) {
        throw new Error('targetRootDir is required when writeToDisk is true');
      }
      const resolvedRoot = path.resolve(targetRootDir);
      const dest = path.resolve(resolvedRoot, item.relativePath);
      if (!dest.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Unsafe export path rejected: ${item.relativePath}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, item.markdown, 'utf8');
      absolutePath = dest;
    }

    exported.push({
      ...item,
      absolutePath,
    });
  }

  return {
    files: exported,
    skippedPersonal,
  };
}

function codeOwnerPatternMatchesPath(pattern, filePath) {
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
 * Extracts the owning `@org/<team>` team from `CODEOWNERS` content:
 * - When `changedFiles` is provided (e.g. monorepos like `2cloud-services` with per-service paths),
 *   evaluates GitHub's last-matching-rule-wins semantics across the PR's changed files and picks the
 *   squad owning the most modified files (tie-breaking with `fallbackTeam`). If zero changed files
 *   match any `CODEOWNERS` rule, returns `''` so `teamProfile` fallback wins instead of an unrelated path!
 * - When `changedFiles` is omitted (repo-level resolution), prioritizes `*` catch-all rules (`resolve.py`),
 *   and only falls back to path-specific rules when all rules in `CODEOWNERS` point to a single squad.
 */
export function parseTeamFromCodeownersContent(
  codeownersContent = '',
  availableTeams = null,
  { changedFiles = null, fallbackTeam = '' } = {}
) {
  const raw = String(codeownersContent || '');
  if (!raw.trim()) return '';

  const isKnownTeam = (t) =>
    !availableTeams || availableTeams.size === 0 || availableTeams.has(t);

  // 1. Path-aware resolution when the PR's changed files are known
  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    const parsedRules = parseCodeOwners(raw);
    if (parsedRules.length === 0) return '';

    const counts = new Map();
    for (const file of changedFiles) {
      let lastMatchingOwners = null;
      for (const rule of parsedRules) {
        if (codeOwnerPatternMatchesPath(rule.pattern, file)) {
          lastMatchingOwners = rule.owners;
        }
      }
      if (!lastMatchingOwners) continue;
      for (const rawOwner of lastMatchingOwners) {
        const norm = normalizeWanreviewTeamSlug(rawOwner);
        if (norm && isKnownTeam(norm)) {
          counts.set(norm, (counts.get(norm) || 0) + 1);
        }
      }
    }

    if (counts.size === 0) {
      return '';
    }

    const normFallback = normalizeWanreviewTeamSlug(fallbackTeam);
    const sorted = [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      if (normFallback && a[0] === normFallback) return -1;
      if (normFallback && b[0] === normFallback) return 1;
      return a[0].localeCompare(b[0]);
    });
    return sorted[0][0];
  }

  // 2. Repo-level resolution (mirroring `resolve.py` while guarding multi-squad monorepos without `*`)
  const teamRegex = /@[\w.-]+\/([\w-]+)/g;
  const distinctKnownTeams = new Set();
  let firstAnyMatch = '';

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const ownersText = parts.slice(1).join(' ');
    if (!ownersText) continue;

    const matches = [...ownersText.matchAll(teamRegex)].map((m) =>
      normalizeWanreviewTeamSlug(m[1])
    );
    if (matches.length === 0) continue;

    const knownOnLine = matches.find((t) => isKnownTeam(t)) || '';

    if (pattern === '*') {
      if (knownOnLine) return knownOnLine;
      return matches[0];
    }

    for (const t of matches) {
      if (isKnownTeam(t)) distinctKnownTeams.add(t);
    }
    if (!firstAnyMatch) {
      firstAnyMatch = matches[0];
    }
  }

  if (distinctKnownTeams.size === 1) {
    return [...distinctKnownTeams][0];
  }
  if (distinctKnownTeams.size > 1) {
    // Multi-team monorepo CODEOWNERS without `*` catch-all and without changedFiles -> let teamProfile decide
    return '';
  }

  return firstAnyMatch || '';
}

function parseLayerMetadataContent(raw = '') {
  const parsed = parseWanreviewMarkdown(raw);
  if (!parsed.valid) {
    return { vertical: '', disable: [], overrides: {}, context: '' };
  }
  const meta = parsed.meta || {};
  return {
    vertical: typeof meta.vertical === 'string' ? meta.vertical.trim() : '',
    disable: Array.isArray(meta.disable) ? meta.disable.map((s) => String(s).trim()).filter(Boolean) : [],
    overrides: meta.overrides && typeof meta.overrides === 'object' ? meta.overrides : {},
    excludePaths: Array.isArray(meta.exclude_paths) ? meta.exclude_paths : [],
    context: parsed.body || '',
  };
}

function parseLayerMetadataFile(layerFilePath) {
  if (!layerFilePath || !fs.existsSync(layerFilePath)) {
    return { vertical: '', disable: [], overrides: {}, excludePaths: [], context: '' };
  }
  return parseLayerMetadataContent(fs.readFileSync(layerFilePath, 'utf8'));
}

function readLayerRulesDir(dirPath, layerKey, layerDisplay, rulesRoot, blobBaseUrl) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md') && f !== '_layer.md');
  const loaded = [];
  for (const file of entries.sort()) {
    const fullPath = path.join(dirPath, file);
    const stem = path.basename(file, '.md');
    const raw = fs.readFileSync(fullPath, 'utf8');
    const check = validateWanreviewRuleMarkdown(raw, stem, { strictAuthoring: false });
    if (!check.valid) continue;

    let url = null;
    if (rulesRoot) {
      const relToRules = path.relative(rulesRoot, fullPath).split(path.sep).join('/');
      if (relToRules && !relToRules.startsWith('..')) {
        url = `${blobBaseUrl}/rules/${relToRules}`;
      }
    }

    const ruleObj = {
      id: `wanreview-${layerKey}-${check.meta.id}`,
      wanreviewId: check.meta.id,
      source: `wanreview-${layerKey}`,
      target: 'wanreview',
      layer: layerKey,
      layerSpec: layerDisplay,
      section: `wanreview · ${layerDisplay}`,
      title: check.meta.title,
      severity: check.meta.severity,
      status: check.meta.status || 'enforced',
      locked: Boolean(check.meta.locked),
      body: check.body,
      filePath: fullPath,
      url,
      readOnly: true,
    };
    ruleObj.domain = inferDomainForRule(ruleObj);
    loaded.push(ruleObj);
  }
  return loaded;
}

function applyLayerOverridesAndDisables(rulesById, layerMeta) {
  const overrides = layerMeta?.overrides || {};
  for (const [rid, patch] of Object.entries(overrides)) {
    if (!patch || typeof patch !== 'object') continue;
    const target = rulesById.get(rid);
    if (!target) continue;
    if (target.locked) {
      if (
        patch.severity &&
        WANREVIEW_SEVERITIES.includes(patch.severity) &&
        WANREVIEW_SEVERITIES.indexOf(patch.severity) < WANREVIEW_SEVERITIES.indexOf(target.severity)
      ) {
        continue;
      }
      if (
        patch.status &&
        WANREVIEW_STATUS_RANK[patch.status] !== undefined &&
        WANREVIEW_STATUS_RANK[patch.status] < WANREVIEW_STATUS_RANK[target.status]
      ) {
        continue;
      }
    }
    if (patch.severity && WANREVIEW_SEVERITIES.includes(patch.severity)) {
      target.severity = patch.severity;
    }
    if (patch.status && WANREVIEW_STATUSES.includes(patch.status)) {
      target.status = patch.status;
    }
    if (typeof patch.title === 'string' && patch.title.trim()) {
      target.title = patch.title.trim();
    }
  }

  for (const disabledId of layerMeta?.disable || []) {
    const target = rulesById.get(disabledId);
    if (target && !target.locked) {
      target.status = 'deprecated';
    }
  }
}

function detectRepoHeadInfo(repoPath) {
  try {
    if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) {
      return { commitSha: null, branch: 'master' };
    }
    const sha = execFileSync('git', ['-C', repoPath, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    }).trim();
    const branch = execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    }).trim();
    return { commitSha: sha || null, branch: branch && branch !== 'HEAD' ? branch : 'master' };
  } catch {
    return { commitSha: null, branch: 'master' };
  }
}

/**
 * Loads and resolves rules from a local clone of `ubitransports/wanreview`
 * with 100% parity with `wanreview/tools/resolve.py`:
 * - Resolves team from `codeownersContent` (if provided) with fallback to `teamProfileId`
 * - Resolves vertical from `rules/teams/<team>/_layer.md`
 * - Merges 4 layers in order: `org -> vertical -> team -> repo (.agent-review)`
 * - Enforces `overrides`, `disable`, and `locked: true` immutability
 */
export function loadWanreviewRulesFromRepo(
  wanreviewRepoPath = '',
  teamProfileId = '',
  options = {}
) {
  if (!wanreviewRepoPath || !fs.existsSync(wanreviewRepoPath)) {
    return {
      available: false,
      repoPath: wanreviewRepoPath || '',
      rules: [],
      allRules: [],
    };
  }

  const rulesRoot = path.join(wanreviewRepoPath, 'rules');
  if (!fs.existsSync(rulesRoot)) {
    return {
      available: false,
      repoPath: wanreviewRepoPath,
      rules: [],
      allRules: [],
    };
  }

  const teamsRoot = path.join(rulesRoot, 'teams');
  const availableTeams = new Set(
    fs.existsSync(teamsRoot)
      ? fs
          .readdirSync(teamsRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : []
  );

  const headInfo = detectRepoHeadInfo(wanreviewRepoPath);
  const blobBranch = headInfo.branch === 'main' ? 'main' : 'master';
  const blobBaseUrl = `https://github.com/ubitransports/wanreview/blob/${blobBranch}`;

  const mappedFallback = mapHubTeamToWanreview(teamProfileId);
  const codeownersTeam = options.codeownersContent
    ? parseTeamFromCodeownersContent(options.codeownersContent, availableTeams, {
        changedFiles: options.changedFiles || null,
        fallbackTeam: mappedFallback.team || teamProfileId,
      })
    : '';
  const legacyUbiSlug = mappedFallback.team?.endsWith('-back')
    ? `ubi-eng-${mappedFallback.team.replace(/-back$/, '')}`
    : '';
  const candidateTeams = [
    codeownersTeam,
    mappedFallback.team,
    normalizeWanreviewTeamSlug(teamProfileId),
    String(teamProfileId || '').trim().toLowerCase(),
    legacyUbiSlug,
  ].filter(Boolean);

  const resolvedTeam =
    candidateTeams.find((t) => availableTeams.has(t)) ||
    candidateTeams[0] ||
    mappedFallback.team ||
    'popcorn-back';

  const resolutionSource =
    codeownersTeam && availableTeams.has(codeownersTeam) ? 'codeowners' : 'teamProfile';

  const teamDir = path.join(teamsRoot, resolvedTeam);
  const orgDir = path.join(rulesRoot, 'org');
  const orgMeta = parseLayerMetadataFile(path.join(orgDir, '_layer.md'));
  const teamMeta = parseLayerMetadataFile(path.join(teamDir, '_layer.md'));
  const effectiveVertical = teamMeta.vertical || mappedFallback.vertical || 'wfwp-backend';
  const verticalDir = effectiveVertical
    ? path.join(rulesRoot, 'verticals', effectiveVertical)
    : '';
  const verticalMeta = verticalDir
    ? parseLayerMetadataFile(path.join(verticalDir, '_layer.md'))
    : { overrides: {}, disable: [] };

  const rulesById = new Map();

  // Layer 1: org
  for (const r of readLayerRulesDir(orgDir, 'org', 'org', rulesRoot, blobBaseUrl)) {
    rulesById.set(r.wanreviewId, r);
  }
  applyLayerOverridesAndDisables(rulesById, orgMeta);

  // Layer 2: vertical
  for (const r of readLayerRulesDir(
    verticalDir,
    'vertical',
    `vertical:${effectiveVertical}`,
    rulesRoot,
    blobBaseUrl
  )) {
    const existing = rulesById.get(r.wanreviewId);
    if (existing?.locked) continue;
    rulesById.set(r.wanreviewId, r);
  }
  applyLayerOverridesAndDisables(rulesById, verticalMeta);

  // Layer 3: team
  for (const r of readLayerRulesDir(
    teamDir,
    'team',
    `team:${resolvedTeam}`,
    rulesRoot,
    blobBaseUrl
  )) {
    const existing = rulesById.get(r.wanreviewId);
    if (existing?.locked) continue;
    rulesById.set(r.wanreviewId, r);
  }
  applyLayerOverridesAndDisables(rulesById, teamMeta);

  // Layer 4: optional target repo `.agent-review/` directory or virtual files map
  if (options.repoAgentReviewDir && fs.existsSync(options.repoAgentReviewDir)) {
    const repoMeta = parseLayerMetadataFile(path.join(options.repoAgentReviewDir, '_layer.md'));
    for (const r of readLayerRulesDir(options.repoAgentReviewDir, 'repo', 'repo', null, blobBaseUrl)) {
      const existing = rulesById.get(r.wanreviewId);
      if (existing?.locked) continue;
      rulesById.set(r.wanreviewId, r);
    }
    applyLayerOverridesAndDisables(rulesById, repoMeta);
  } else if (options.repoLayerMarkdown) {
    const repoMeta = parseLayerMetadataContent(options.repoLayerMarkdown);
    applyLayerOverridesAndDisables(rulesById, repoMeta);
  }

  const nonDeprecated = [...rulesById.values()].filter((r) => r.status !== 'deprecated');
  const activeRules = nonDeprecated.filter((r) => WANREVIEW_ACTIVE_STATUSES.has(r.status));

  return {
    available: true,
    repoPath: wanreviewRepoPath,
    commitSha: headInfo.commitSha,
    branch: headInfo.branch,
    vertical: effectiveVertical,
    team: resolvedTeam,
    resolutionSource,
    availableTeams: [...availableTeams].sort(),
    rules: options.includeProposed ? nonDeprecated : activeRules,
    activeRules,
    allRules: nonDeprecated,
  };
}

/**
 * Ensures a local clone of `ubitransports/wanreview` exists on disk and optionally pulls
 * latest fast-forward updates when the working tree is clean on `master`/`main`.
 * Never modifies a dirty developer working tree.
 */
export async function ensureWanreviewRepoSynced(cfg = {}, options = {}) {
  const { pull = false, allowAutoClone = true, execFn = execFileAsync } = options;

  const projectsDir = cfg.projectsDir ? String(cfg.projectsDir).trim() : '';
  const workspaceClone = projectsDir ? path.join(projectsDir, 'wanreview') : '';
  const managedClone = getDefaultManagedWanreviewDir();

  let targetDir = String(cfg.wanreviewRepoPath || '').trim();
  if (!targetDir) {
    if (workspaceClone && fs.existsSync(path.join(workspaceClone, 'rules'))) {
      targetDir = workspaceClone;
    } else {
      targetDir = managedClone;
    }
  }

  const rulesExist = fs.existsSync(path.join(targetDir, 'rules'));

  if (!rulesExist) {
    if (
      !allowAutoClone ||
      process.env.REVIEW_HUB_DISABLE_WANREVIEW_AUTOCLONE === '1'
    ) {
      return {
        ok: false,
        available: false,
        action: 'skipped',
        repoPath: targetDir,
        reason: 'Local wanreview clone not found and auto-clone is disabled.',
      };
    }

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    try {
      await execFn('gh', ['repo', 'clone', WANREVIEW_REPO_SLUG, targetDir, '--', '--depth', '1'], {
        timeout: 25000,
      });
    } catch (ghErr) {
      try {
        await execFn(
          'git',
          ['clone', '--depth', '1', `https://github.com/${WANREVIEW_REPO_SLUG}.git`, targetDir],
          { timeout: 25000 }
        );
      } catch (gitErr) {
        return {
          ok: false,
          available: false,
          action: 'clone-failed',
          repoPath: targetDir,
          error: ghErr?.message || gitErr?.message || 'Failed to clone ubitransports/wanreview',
        };
      }
    }

    const head = detectRepoHeadInfo(targetDir);
    return {
      ok: true,
      available: fs.existsSync(path.join(targetDir, 'rules')),
      action: 'cloned',
      repoPath: targetDir,
      commitSha: head.commitSha,
      branch: head.branch,
    };
  }

  if (!pull || !fs.existsSync(path.join(targetDir, '.git'))) {
    const head = detectRepoHeadInfo(targetDir);
    return {
      ok: true,
      available: true,
      action: 'present',
      repoPath: targetDir,
      commitSha: head.commitSha,
      branch: head.branch,
    };
  }

  // Safe fast-forward pull ONLY if working tree is clean and on master/main
  try {
    const { stdout: statusOut } = await execFn('git', ['-C', targetDir, 'status', '--porcelain'], {
      timeout: 5000,
    });
    if (String(statusOut || '').trim() !== '') {
      const head = detectRepoHeadInfo(targetDir);
      return {
        ok: true,
        available: true,
        action: 'skipped-dirty',
        repoPath: targetDir,
        commitSha: head.commitSha,
        branch: head.branch,
        reason: 'Local wanreview clone has uncommitted changes; skipped git pull to preserve work.',
      };
    }

    const { stdout: branchOut } = await execFn(
      'git',
      ['-C', targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 4000 }
    );
    const branch = String(branchOut || '').trim();
    if (branch !== 'master' && branch !== 'main') {
      const head = detectRepoHeadInfo(targetDir);
      return {
        ok: true,
        available: true,
        action: 'skipped-branch',
        repoPath: targetDir,
        commitSha: head.commitSha,
        branch,
        reason: `Local wanreview clone is on feature branch "${branch}"; skipped git pull.`,
      };
    }

    await execFn('git', ['-C', targetDir, 'pull', '--ff-only', '--quiet'], { timeout: 15000 });
    const head = detectRepoHeadInfo(targetDir);
    return {
      ok: true,
      available: true,
      action: 'pulled',
      repoPath: targetDir,
      commitSha: head.commitSha,
      branch: head.branch,
    };
  } catch (pullErr) {
    const head = detectRepoHeadInfo(targetDir);
    return {
      ok: true,
      available: true,
      action: 'pull-warning',
      repoPath: targetDir,
      commitSha: head.commitSha,
      branch: head.branch,
      reason: pullErr?.message || 'Offline or unable to fast-forward wanreview; using cached rules.',
    };
  }
}

/**
 * Proposes a new atomic rule directly to `ubitransports/wanreview` via an isolated temporary
 * `git worktree` (leaving the developer's main checkout untouched), validates 100% `resolve.py`
 * compliance with `status: proposed`, pushes the branch, and opens a GitHub Pull Request.
 */
function findExistingWanreviewRuleConflict(wanreviewRepoPath = '', item = {}) {
  if (!wanreviewRepoPath || !fs.existsSync(wanreviewRepoPath)) return null;
  const rulesRoot = path.join(wanreviewRepoPath, 'rules');
  if (!fs.existsSync(rulesRoot)) return null;

  const targetFullPath = path.join(wanreviewRepoPath, item.relativePath || '');
  if (item.relativePath && fs.existsSync(targetFullPath)) {
    return {
      reason: 'file',
      message: `Rule file "${item.relativePath}" already exists in ubitransports/wanreview. Choose a more specific title or custom ID.`,
    };
  }

  const walkDirs = [path.join(rulesRoot, 'org')];
  for (const sub of ['verticals', 'teams']) {
    const parent = path.join(rulesRoot, sub);
    if (fs.existsSync(parent)) {
      for (const d of fs.readdirSync(parent, { withFileTypes: true })) {
        if (d.isDirectory()) walkDirs.push(path.join(parent, d.name));
      }
    }
  }

  for (const dir of walkDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === '_layer.md') continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const parsed = parseWanreviewMarkdown(fs.readFileSync(fullPath, 'utf8'));
        if (parsed.valid && parsed.meta?.id === item.id) {
          const rel = path.relative(wanreviewRepoPath, fullPath).split(path.sep).join('/');
          return {
            reason: 'id',
            message: `Rule ID "${item.id}" already exists in ubitransports/wanreview at "${rel}". Choose a distinct title or custom ID.`,
          };
        }
      } catch {
        // ignore unreadable file
      }
    }
  }
  return null;
}

export async function proposeRulePrToWanreview({
  rule = {},
  layer = 'vertical',
  vertical = 'wfwp-backend',
  team = 'popcorn-back',
  severity = '',
  status = 'proposed',
  locked = false,
  customId = '',
  allowOverwrite = false,
  wanreviewRepoPath = '',
  sourcePrKey = '',
  dryRun = false,
  execFn = execFileAsync,
} = {}) {
  const item = convertHubRuleToWanreview(rule, {
    layer,
    vertical,
    team,
    statusOverride: status || 'proposed',
    severityOverride: severity,
    locked,
    customId,
  });

  if (!item.valid) {
    throw new Error(`Rule validation failed for "${item.id}": ${item.errors.join('; ')}`);
  }

  if (!allowOverwrite && wanreviewRepoPath) {
    const conflict = findExistingWanreviewRuleConflict(wanreviewRepoPath, item);
    if (conflict) {
      throw new Error(conflict.message);
    }
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      ruleId: item.id,
      relativePath: item.relativePath,
      markdown: item.markdown,
      item,
    };
  }

  if (!wanreviewRepoPath || !fs.existsSync(path.join(wanreviewRepoPath, '.git'))) {
    throw new Error(
      'Local ubitransports/wanreview git clone is missing. Click Sync to initialize wanreview first.'
    );
  }

  let baseRef = 'HEAD';
  let baseBranch = 'master';
  try {
    await execFn('git', ['-C', wanreviewRepoPath, 'fetch', 'origin', '--quiet'], {
      timeout: 15000,
    });
    try {
      await execFn('git', ['-C', wanreviewRepoPath, 'rev-parse', '--verify', 'origin/master'], {
        timeout: 3000,
      });
      baseRef = 'origin/master';
      baseBranch = 'master';
    } catch {
      await execFn('git', ['-C', wanreviewRepoPath, 'rev-parse', '--verify', 'origin/main'], {
        timeout: 3000,
      });
      baseRef = 'origin/main';
      baseBranch = 'main';
    }
  } catch {
    const head = detectRepoHeadInfo(wanreviewRepoPath);
    baseBranch = head.branch === 'main' ? 'main' : 'master';
    baseRef = 'HEAD';
  }

  const shortSuffix = Date.now().toString(36).slice(-5);
  const branchName = `feat/rule-${item.stem}-${shortSuffix}`;
  const tmpWorktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanreview-propose-'));

  try {
    await execFn(
      'git',
      ['-C', wanreviewRepoPath, 'worktree', 'add', '-b', branchName, tmpWorktreeDir, baseRef],
      { timeout: 10000 }
    );

    const destFile = path.resolve(tmpWorktreeDir, item.relativePath);
    if (!destFile.startsWith(path.resolve(tmpWorktreeDir) + path.sep)) {
      throw new Error(`Unsafe rule destination path: ${item.relativePath}`);
    }
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, item.markdown, 'utf8');

    await execFn('git', ['-C', tmpWorktreeDir, 'add', item.relativePath], { timeout: 5000 });
    const commitMsg = `feat(rules): propose ${item.id} (${item.layer})`;
    await execFn('git', ['-C', tmpWorktreeDir, 'commit', '-m', commitMsg], { timeout: 8000 });
    await execFn('git', ['-C', tmpWorktreeDir, 'push', '-u', 'origin', branchName], {
      timeout: 25000,
    });

    const prTitle = `feat(rules): Propose ${item.id} — ${item.title}`;
    const prBody = [
      `### Proposed Review Rule (\`${item.id}\`)`,
      '',
      `- **Layer:** \`${item.layer}\` (\`${item.relativePath}\`)`,
      `- **Domain:** \`${item.domain}\``,
      `- **Severity:** \`${item.severity}\``,
      `- **Initial Status:** \`${item.status}\` *(zero score deduction until promoted to \`advisory\` / \`enforced\`)*`,
      sourcePrKey ? `- **Originated from PR Review:** \`${sourcePrKey}\`` : '',
      '',
      '#### Rule Content',
      '````markdown',
      item.markdown.trim(),
      '````',
    ]
      .filter((l) => l !== null && l !== undefined)
      .join('\n');

    const { stdout: prOut } = await execFn(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        WANREVIEW_REPO_SLUG,
        '--base',
        baseBranch,
        '--head',
        branchName,
        '--title',
        prTitle,
        '--body',
        prBody,
      ],
      { timeout: 20000 }
    );

    const prUrl =
      String(prOut || '')
        .trim()
        .split(/\r?\n/)
        .find((l) => /^https?:\/\//.test(l.trim())) || String(prOut || '').trim();

    return {
      ok: true,
      prUrl,
      branch: branchName,
      branchName,
      baseBranch,
      commitMessage: commitMsg,
      item,
    };
  } finally {
    try {
      await execFn('git', ['-C', wanreviewRepoPath, 'worktree', 'remove', '--force', tmpWorktreeDir], {
        timeout: 6000,
      });
    } catch {
      fs.rmSync(tmpWorktreeDir, { recursive: true, force: true });
    }
    try {
      await execFn('git', ['-C', wanreviewRepoPath, 'worktree', 'prune'], { timeout: 4000 });
    } catch {
      // ignore prune error
    }
  }
}
