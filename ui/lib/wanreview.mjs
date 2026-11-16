import fs from 'node:fs';
import path from 'node:path';
import { inferDomainForRule } from './scoring.mjs';

/**
 * Exact schema constants matching `ubitransports/wanreview/tools/resolve.py`
 * (`RULE_KEYS`, `SEVERITIES`, `STATUSES`, `ACTIVE_STATUSES`).
 * Keeping strict 100% compatibility ensures exported rules pass `resolve.py` and CI immediately.
 */
export const WANREVIEW_RULE_KEYS = new Set(['id', 'title', 'severity', 'status', 'locked']);
export const WANREVIEW_SEVERITIES = ['low', 'medium', 'high'];
export const WANREVIEW_STATUSES = ['proposed', 'advisory', 'enforced', 'deprecated'];
export const WANREVIEW_ACTIVE_STATUSES = new Set(['advisory', 'enforced']);

export function slugifyWanreviewRuleId(raw = '') {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\(\)`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'custom-rule').slice(0, 64).replace(/-+$/g, '');
}

export function mapHubTeamToWanreview(teamProfileId = '') {
  const id = String(teamProfileId || '').trim().toLowerCase();
  if (id === 'popcorn-back' || id === 'ubi-eng-popcorn') {
    return { vertical: 'wfwp-backend', team: 'ubi-eng-popcorn' };
  }
  if (id === 'pili-back' || id === 'ubi-eng-pili') {
    return { vertical: 'wfwp-backend', team: 'ubi-eng-pili' };
  }
  if (id === 'banana-back' || id === 'ubi-eng-banana') {
    return { vertical: 'wfwp-backend', team: 'ubi-eng-banana' };
  }
  if (id === 'papaya-back' || id === 'ubi-eng-papaya') {
    return { vertical: 'wfwp-backend', team: 'ubi-eng-papaya' };
  }
  if (id === 'moneris-back') {
    return { vertical: 'wfwp-backend', team: 'ubi-eng-popcorn' };
  }
  if (id === 'frontend-web') {
    return { vertical: 'frontend-web', team: '' };
  }
  if (id === 'mobile-kotlin') {
    return { vertical: 'mobile-kotlin', team: '' };
  }
  if (id === 'qa-automation') {
    return { vertical: 'qa-automation', team: '' };
  }
  return { vertical: 'wfwp-backend', team: id.startsWith('ubi-eng-') ? id : '' };
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

/**
 * Parses YAML frontmatter + Markdown body strictly mirroring `wanreview/tools/resolve.py`.
 */
export function parseWanreviewMarkdown(raw = '') {
  const text = String(raw || '');
  if (!text.startsWith('---')) {
    return { valid: false, error: 'Missing leading YAML frontmatter delimiter (---)', meta: {}, body: text };
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { valid: false, error: 'Unclosed YAML frontmatter delimiter (---)', meta: {}, body: text };
  }

  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) {
      return { valid: false, error: `Unsupported or malformed YAML line: "${line}"`, meta, body: match[2] };
    }
    const key = kv[1].trim();
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (val === 'true') {
      val = true;
    } else if (val === 'false') {
      val = false;
    }
    meta[key] = val;
  }

  return { valid: true, error: null, meta, body: match[2].trim() };
}

/**
 * Strictly validates a generated or imported rule Markdown file against `wanreview/tools/resolve.py`
 * so any exported file is guaranteed to pass `python3 tools/resolve.py` on the first run.
 */
export function validateWanreviewRuleMarkdown(markdown = '', expectedId = '') {
  const parsed = parseWanreviewMarkdown(markdown);
  if (!parsed.valid) {
    return { valid: false, errors: [parsed.error], meta: parsed.meta, body: parsed.body };
  }

  const errors = [];
  const { meta, body } = parsed;
  const keys = Object.keys(meta);
  const unknownKeys = keys.filter((k) => !WANREVIEW_RULE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown frontmatter keys rejected by resolve.py: ${unknownKeys.join(', ')}`);
  }

  for (const reqKey of ['id', 'title', 'severity', 'status']) {
    if (!meta[reqKey] || typeof meta[reqKey] !== 'string') {
      errors.push(`Missing required string frontmatter field: "${reqKey}"`);
    }
  }

  if (expectedId && meta.id && meta.id !== expectedId) {
    errors.push(`Rule id "${meta.id}" does not match filename stem "${expectedId}"`);
  }

  if (meta.severity && !WANREVIEW_SEVERITIES.includes(meta.severity)) {
    errors.push(`Invalid severity "${meta.severity}" (expected one of: ${WANREVIEW_SEVERITIES.join(', ')})`);
  }

  if (meta.status && !WANREVIEW_STATUSES.includes(meta.status)) {
    errors.push(`Invalid status "${meta.status}" (expected one of: ${WANREVIEW_STATUSES.join(', ')})`);
  }

  if (meta.locked !== undefined && typeof meta.locked !== 'boolean') {
    errors.push(`Field "locked" must be a boolean if present`);
  }

  if (!/^##\s+Flag\b/m.test(body)) {
    errors.push('Missing "## Flag" section in rule body');
  }
  if (!/^##\s+Accept\b/m.test(body)) {
    errors.push('Missing "## Accept" section in rule body');
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
    if (/\b(never|do not|don't|avoid|ban|forbid|missing|without|instead of|line-by-line|untyped)\b/i.test(line)) {
      flagLines.push(`- ${line}`);
    } else if (/\b(use|prefer|delegate|verify|return|instantiate|keep|explicitly|allow|except)\b/i.test(line)) {
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

  return [
    summaryLine,
    '',
    '## Flag',
    ...flagLines,
    '',
    '## Accept',
    ...acceptLines,
  ].join('\n');
}

/**
 * Converts a PR Review Hub rule object into a 100% `wanreview`-compliant atomic `.md` file
 * with relative destination path (`rules/org/<id>.md`, `rules/verticals/<vertical>/<id>.md`, or `rules/teams/<team>/<id>.md`).
 */
export function convertHubRuleToWanreview(rule = {}, options = {}) {
  const {
    layer = '',
    vertical = 'wfwp-backend',
    team = 'ubi-eng-popcorn',
    statusOverride = '',
    severityOverride = '',
    locked = false,
  } = options;

  const resolvedLayer =
    layer ||
    (rule.source === 'common' || rule.source === 'common-dna'
      ? 'vertical'
      : rule.source === 'org' || rule.source === 'wanreview-org'
      ? 'org'
      : 'team');

  const cleanTitle = String(rule.title || 'Untitled Rule')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const ruleId = slugifyWanreviewRuleId(options.customId || rule.wanreviewId || cleanTitle);
  const severity = WANREVIEW_SEVERITIES.includes(severityOverride)
    ? severityOverride
    : inferWanreviewSeverityFromRule(rule);
  const status = WANREVIEW_STATUSES.includes(statusOverride)
    ? statusOverride
    : inferWanreviewStatusFromRule(rule);

  const fmLines = [
    '---',
    `id: ${ruleId}`,
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
    relativePath = path.posix.join('rules', 'org', `${ruleId}.md`);
  } else if (resolvedLayer === 'vertical') {
    const cleanVertical = slugifyWanreviewRuleId(vertical || 'wfwp-backend');
    relativePath = path.posix.join('rules', 'verticals', cleanVertical, `${ruleId}.md`);
  } else {
    const cleanTeam = slugifyWanreviewRuleId(team || 'ubi-eng-popcorn');
    relativePath = path.posix.join('rules', 'teams', cleanTeam, `${ruleId}.md`);
  }

  const validation = validateWanreviewRuleMarkdown(markdown, ruleId);

  return {
    id: ruleId,
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
 * Exports selected rules as surgical, `resolve.py`-validated `.md` files into a target directory
 * (e.g. a local clone of `ubitransports/wanreview`).
 * Strictly blocks personal `.local.md` rules unless `allowPersonalPromotion` is explicitly set.
 */
export function exportRulesToWanreviewDirectory({
  rules = [],
  targetRootDir = '',
  layer = '',
  vertical = 'wfwp-backend',
  team = 'ubi-eng-popcorn',
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

function parseLayerMetadataFile(layerFilePath) {
  if (!fs.existsSync(layerFilePath)) return { vertical: '', disable: [] };
  const raw = fs.readFileSync(layerFilePath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { vertical: '', disable: [] };
  const fm = match[1];
  const vertMatch = fm.match(/^vertical\s*:\s*([^\r\n#]+)/m);
  const vertical = vertMatch ? vertMatch[1].trim().replace(/^['"]|['"]$/g, '') : '';
  const disable = [];
  let inDisable = false;
  for (const line of fm.split(/\r?\n/)) {
    if (/^disable\s*:/.test(line.trim())) {
      inDisable = true;
      continue;
    }
    if (inDisable) {
      const itemMatch = line.match(/^\s*-\s*([a-zA-Z0-9_-]+)/);
      if (itemMatch) disable.push(itemMatch[1].trim());
      else if (/^[a-zA-Z0-9_-]+\s*:/.test(line.trim())) inDisable = false;
    }
  }
  return { vertical, disable };
}

function readLayerRulesDir(dirPath, layerName) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md') && f !== '_layer.md');
  const loaded = [];
  for (const file of entries.sort()) {
    const fullPath = path.join(dirPath, file);
    const stem = path.basename(file, '.md');
    const raw = fs.readFileSync(fullPath, 'utf8');
    const check = validateWanreviewRuleMarkdown(raw, stem);
    if (!check.valid) continue;
    const ruleObj = {
      id: `wanreview-${layerName}-${check.meta.id}`,
      wanreviewId: check.meta.id,
      source: `wanreview-${layerName}`,
      target: 'wanreview',
      layer: layerName,
      section: `wanreview · ${layerName}`,
      title: check.meta.title,
      severity: check.meta.severity,
      status: check.meta.status,
      locked: Boolean(check.meta.locked),
      body: check.body,
      filePath: fullPath,
      readOnly: true,
    };
    ruleObj.domain = inferDomainForRule(ruleObj);
    loaded.push(ruleObj);
  }
  return loaded;
}

/**
 * Loads and resolves rules from a local clone of `ubitransports/wanreview`
 * following the exact 4-layer precedence (`org -> vertical -> team`) and `locked: true` immutability.
 */
export function loadWanreviewRulesFromRepo(wanreviewRepoPath = '', teamProfileId = '') {
  if (!wanreviewRepoPath || !fs.existsSync(wanreviewRepoPath)) {
    return { available: false, repoPath: wanreviewRepoPath || '', rules: [] };
  }

  const rulesRoot = path.join(wanreviewRepoPath, 'rules');
  if (!fs.existsSync(rulesRoot)) {
    return { available: false, repoPath: wanreviewRepoPath, rules: [] };
  }

  const mapped = mapHubTeamToWanreview(teamProfileId);
  const teamDir = mapped.team ? path.join(rulesRoot, 'teams', mapped.team) : '';
  const teamLayerMeta = teamDir ? parseLayerMetadataFile(path.join(teamDir, '_layer.md')) : { vertical: '', disable: [] };
  const effectiveVertical = teamLayerMeta.vertical || mapped.vertical;
  const verticalDir = effectiveVertical ? path.join(rulesRoot, 'verticals', effectiveVertical) : '';
  const orgDir = path.join(rulesRoot, 'org');

  const resolvedMap = new Map();

  for (const r of readLayerRulesDir(orgDir, 'org')) {
    resolvedMap.set(r.wanreviewId, r);
  }
  for (const r of readLayerRulesDir(verticalDir, 'vertical')) {
    const existing = resolvedMap.get(r.wanreviewId);
    if (existing?.locked) continue;
    resolvedMap.set(r.wanreviewId, r);
  }
  for (const r of readLayerRulesDir(teamDir, 'team')) {
    const existing = resolvedMap.get(r.wanreviewId);
    if (existing?.locked) continue;
    resolvedMap.set(r.wanreviewId, r);
  }

  for (const disabledId of teamLayerMeta.disable || []) {
    const existing = resolvedMap.get(disabledId);
    if (existing && !existing.locked) {
      resolvedMap.delete(disabledId);
    }
  }

  const activeRules = [...resolvedMap.values()].filter((r) => r.status !== 'deprecated');

  return {
    available: true,
    repoPath: wanreviewRepoPath,
    vertical: effectiveVertical,
    team: mapped.team,
    rules: activeRules,
  };
}
