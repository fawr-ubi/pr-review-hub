import fs from 'node:fs';
import path from 'node:path';
import { SKILL_ROOT } from './config.mjs';
import { detectSeverity } from './parser.mjs';

export const DOMAIN_IDS = ['security', 'product', 'quality', 'performance', 'testing'];

export const DEFAULT_DOMAIN_AGENTS = [
  {
    id: 'security',
    title: 'Security & Multi-Tenancy',
    shortLabel: 'Security',
    defaultWeight: 25,
    order: 1,
    keywords: [
      'security',
      'tenant',
      'isolation',
      'customer',
      'voter',
      'auth',
      'authenticator',
      'permission',
      'secret',
      'token',
      'credential',
      'injection',
      'xss',
      'csrf',
      'locked',
      '404',
      '403',
    ],
    summary:
      'Check multi-tenant isolation, authentication/authorization boundaries, Symfony Voters, secrets exposure, and locked organization security policies.',
    mission:
      'Audit endpoints, State Providers/Processors, Voters, Authenticators, queries, and config for zero cross-tenant leakage and strict permission checks.',
    applicability:
      'N/A only when the PR strictly touches Markdown documentation or static non-executable assets.',
    rubric:
      '- Multi-tenant scoping & ownership checks\n- Voter & Authenticator token DTO verification (404 anti-enumeration)\n- No hardcoded secrets or sensitive logs\n- SQL/XSS/command injection safety',
  },
  {
    id: 'product',
    title: 'Product & Scope',
    shortLabel: 'Product',
    defaultWeight: 20,
    order: 2,
    keywords: [
      'product',
      'business',
      'jira',
      'scope',
      'acceptance',
      'functional',
      'edge-case',
      'workflow',
      'contract',
      'backward-compatibility',
    ],
    summary:
      'Evaluate functional alignment against Jira acceptance criteria, business edge cases, API backward compatibility, and scope discipline.',
    mission:
      'Verify that the changes fulfill the expected business behavior without breaking functional contracts or introducing scope creep.',
    applicability:
      'N/A when the PR has no Jira functional specification and is purely technical (chore, ci, build, docs, deps).',
    rubric:
      '- Jira acceptance criteria alignment\n- Business & domain boundary cases\n- API & consumer backward compatibility\n- Scope discipline (no unrelated large refactors)',
  },
  {
    id: 'quality',
    title: 'Quality & Architecture',
    shortLabel: 'Quality',
    defaultWeight: 25,
    order: 3,
    keywords: [
      'quality',
      'architecture',
      'solid',
      'srp',
      'clean-code',
      'mapper',
      'automapper',
      'dto',
      'resource',
      'typing',
      'readonly',
      'enum',
      'constant',
      'getcustomuuid',
      'naming',
      'dead-code',
    ],
    summary:
      'Audit SOLID architecture, separation of concerns, framework idioms, strict typing, naming clarity, and maintainability.',
    mission:
      'Keep code clean, idiomatic, strongly typed, and modular with pragmatic SOLID engineering judgment.',
    applicability: 'N/A only when no source code or test code is modified.',
    rubric:
      '- SOLID & SRP (thin Providers/Processors, dedicated AutoMappers)\n- Modern stack idioms (readonly, Backed Enums, Response::HTTP_*, no empty())\n- Ban deprecated getCustomUuid()\n- Naming clarity & dead code removal',
  },
  {
    id: 'performance',
    title: 'Performance & Scalability',
    shortLabel: 'Performance',
    defaultWeight: 15,
    order: 4,
    keywords: [
      'performance',
      'scalability',
      'sql',
      'doctrine',
      'n+1',
      'query',
      'index',
      'migration',
      'flush',
      'postupdate',
      'async',
      'await',
      'batch',
      'memory',
      'pagination',
      'cache',
    ],
    summary:
      'Detect database bottlenecks, N+1 queries, missing indexes, Doctrine lifecycle traps, unbatched async loops, and memory/payload inefficiencies.',
    mission:
      'Protect production latency, DB load, and worker memory under realistic multi-tenant traffic.',
    applicability:
      'N/A when the diff touches only docs, static config, translations, or pure unit tests with no runtime DB/loop/I/O impact.',
    rubric:
      '- N+1 queries, unbounded queries & missing DB migration indexes\n- No $em->flush() inside postUpdate listeners\n- Keep $asyncManager->await() outside loops\n- Memory hydration, batching & payload size',
  },
  {
    id: 'testing',
    title: 'Testing & Reliability',
    shortLabel: 'Testing',
    defaultWeight: 15,
    order: 5,
    keywords: [
      'testing',
      'test',
      'phpunit',
      'behat',
      'vitest',
      'jest',
      'cypress',
      'mock',
      'stub',
      'assertion',
      'coverage',
      'negative-path',
      'constructor',
      'fixture',
      'over-testing',
      'redundant-test',
      'test-bloat',
      'data-provider',
      'pyramid',
    ],
    summary:
      'Assess right-sized automated test coverage (neither under-tested nor bloated), nominal + failure path verification, declarative test data construction, and assertion quality.',
    mission:
      'Ensure behavioral changes and fixes are backed by lean, high-signal automated tests without brittle mock mutation or redundant CI-slowing test bloat.',
    applicability:
      'N/A when the PR only deletes unreferenced dead code, edits documentation, or changes non-executable metadata.',
    rubric:
      '- Proportional nominal + error/404/exception test coverage\n- No over-testing or bloat (ban redundant permutations, trivial DTO/framework tests, or heavy E2E duplication of unit edge cases)\n- Declarative DTO/mock instantiation (named constructors or raw JSON payloads, zero line-by-line assignment)\n- Meaningful state/output assertions',
  },
];

function parseSimpleFrontmatter(raw = '') {
  const text = String(raw || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === 'true') meta[key] = true;
    else if (val === 'false') meta[key] = false;
    else if (/^-?\d+$/.test(val)) meta[key] = Number(val);
    else meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

function extractSection(markdownBody = '', heading = '') {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'im');
  const lines = String(markdownBody || '').split(/\r?\n/);
  let capture = false;
  const buf = [];
  const headerRe = new RegExp(`^##\\s+${escaped}\\s*$`, 'i');
  for (const line of lines) {
    if (headerRe.test(line.trim())) {
      capture = true;
      continue;
    }
    if (capture && /^##\s+/.test(line.trim())) {
      break;
    }
    if (capture) buf.push(line);
  }
  if (buf.length > 0) return buf.join('\n').trim();
  const m = re.exec(markdownBody);
  return m ? m[1].trim() : '';
}

export function getAgentsDefinitionsDir() {
  return process.env.REVIEW_HUB_AGENTS_DIR || path.join(SKILL_ROOT, 'references', 'agents');
}

export function loadDomainAgentCatalog() {
  const dir = getAgentsDefinitionsDir();
  const byId = new Map(DEFAULT_DOMAIN_AGENTS.map((d) => [d.id, { ...d }]));

  if (fs.existsSync(dir)) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const raw = fs.readFileSync(fullPath, 'utf8');
        const { meta, body } = parseSimpleFrontmatter(raw);
        const id = normalizeDomainId(meta.id || path.basename(file, '.md'));
        if (!id) continue;
        const base = byId.get(id) || {
          id,
          title: meta.title || id,
          shortLabel: meta.shortLabel || meta.title || id,
          defaultWeight: Number(meta.defaultWeight) || 15,
          order: Number(meta.order) || 99,
          keywords: [],
        };
        const firstParagraph = body.split(/^##\s+/m)[0]?.trim() || base.summary || '';
        const keywords =
          typeof meta.keywords === 'string'
            ? meta.keywords
                .split(',')
                .map((k) => k.trim().toLowerCase())
                .filter(Boolean)
            : base.keywords || [];
        byId.set(id, {
          ...base,
          id,
          title: meta.title || base.title,
          shortLabel: meta.shortLabel || base.shortLabel,
          defaultWeight:
            typeof meta.defaultWeight === 'number' ? meta.defaultWeight : base.defaultWeight,
          order: typeof meta.order === 'number' ? meta.order : base.order,
          keywords,
          summary: firstParagraph || base.summary,
          mission: extractSection(body, 'Mission') || base.mission,
          applicability: extractSection(body, 'Applicability (When N/A)') || base.applicability,
          rubric: extractSection(body, 'Audit Rubric') || base.rubric,
          manifestPath: fullPath,
        });
      }
    } catch {
      // fallback to built-in catalog
    }
  }

  return [...byId.values()].sort((a, b) => (a.order || 99) - (b.order || 99));
}

export function normalizeDomainId(raw = '') {
  const clean = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '');
  if (!clean) return null;
  if (DOMAIN_IDS.includes(clean)) return clean;
  if (['sec', 'auth', 'tenancy', 'multitenancy', 'multitenant'].includes(clean)) return 'security';
  if (['prod', 'scope', 'business', 'functional', 'jira'].includes(clean)) return 'product';
  if (['qual', 'arch', 'architecture', 'cleancode', 'solid', 'style'].includes(clean)) {
    return 'quality';
  }
  if (['perf', 'scalability', 'db', 'database', 'sql'].includes(clean)) return 'performance';
  if (['test', 'tests', 'qa', 'reliability', 'coverage'].includes(clean)) return 'testing';
  return null;
}

export function getDefaultDomainAgentsConfig() {
  const catalog = loadDomainAgentCatalog();
  const out = {};
  for (const agent of catalog) {
    out[agent.id] = {
      enabled: true,
      weight: agent.defaultWeight,
    };
  }
  return out;
}

export function normalizeDomainAgentsConfig(rawConfig = null) {
  const defaults = getDefaultDomainAgentsConfig();
  if (!rawConfig || typeof rawConfig !== 'object') return defaults;
  const normalized = {};
  for (const [id, def] of Object.entries(defaults)) {
    const incoming = rawConfig[id];
    if (incoming && typeof incoming === 'object') {
      const parsedWeight = Number(incoming.weight);
      normalized[id] = {
        enabled: incoming.enabled !== undefined ? Boolean(incoming.enabled) : def.enabled,
        weight:
          Number.isFinite(parsedWeight) && parsedWeight >= 0 && parsedWeight <= 100
            ? Math.round(parsedWeight)
            : def.weight,
      };
    } else {
      normalized[id] = { ...def };
    }
  }
  return normalized;
}

export function inferDomainFromText(haystack = '', filePath = '') {
  const text = String(haystack || '').toLowerCase();
  const file = String(filePath || '').toLowerCase();

  // Strong path & domain signals
  if (
    /\b(tenants?|multi-tenant|cross-tenant|voters?|authenticators?|secrets?|api[_ -]?keys?|credentials?|passwords?|tokens?|sql injections?|injections?|xss|csrf|404 not found|resource enumeration|permissions?|authz)\b/i.test(
      text
    ) ||
    /voter\.php|authenticator\.php|security\.yaml/i.test(file)
  ) {
    return 'security';
  }

  if (
    /(?:^|\/)(?:tests?|spec|features)\//i.test(file) ||
    /(?:test\.php|\.spec\.[jt]sx?|\.test\.[jt]sx?|\.feature)$/i.test(file) ||
    /\b(phpunit|behat|unit tests?|functional tests?|over-testing|test bloat|redundant tests?|dataprovider|test pyramid|mocks?|stubs?|assertions?|negative path|declarative dto instantiation|line-by-line property)\b/i.test(
      text
    )
  ) {
    return 'testing';
  }

  if (
    /\b(n\+1|postupdate|flush\(\)|await\(\)\s+inside|async.*loop|missing index|create index|pagination|unbounded query|findall\(\)|memory leak|batching|querybuilder.*loop|re-render)\b/i.test(
      text
    ) ||
    /migrations\/version/i.test(file)
  ) {
    return 'performance';
  }

  if (
    /\b(acceptance criteria|jira|prd-\d+|scope creep|out of scope|business rule|backward[- ]compatib|functional requirement|missing requirement)\b/i.test(
      text
    )
  ) {
    return 'product';
  }

  return 'quality';
}

export function inferDomainForRule(rule = {}) {
  const explicit = normalizeDomainId(rule.domain);
  if (explicit) return explicit;
  const combined = `${rule.section || ''} ${rule.title || ''} ${rule.id || ''} ${rule.body || ''}`;
  return inferDomainFromText(combined, '');
}

export function inferDomainForFinding(finding = {}) {
  const explicit = normalizeDomainId(finding.domain || finding.category);
  if (explicit) return explicit;
  // Support bracket prefix like "security: Voter check" or "performance" inside category
  if (finding.category) {
    const prefix = String(finding.category).split(/[:/·|-]/)[0]?.trim();
    const fromPrefix = normalizeDomainId(prefix);
    if (fromPrefix) return fromPrefix;
  }
  const combined = `${finding.category || ''} ${finding.title || ''} ${finding.explanation || finding.rationale || ''} ${finding.comment || ''}`;
  return inferDomainFromText(combined, finding.filePath || finding.file || '');
}

export function scoreToTier(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return 'na';
  }
  const n = Number(score);
  if (n >= 90) return 'excellent';
  if (n >= 80) return 'good';
  if (n >= 65) return 'fair';
  if (n >= 50) return 'warning';
  return 'critical';
}

function basePenaltyForSeverityEmoji(sev = '🟡') {
  const detected = detectSeverity(sev, '🟡');
  if (detected === '🔴') return 35;
  if (detected === '🟠') return 15;
  if (detected === '🟡') return 5;
  if (detected === '🔵') return 1;
  return 0;
}

function statusMultiplier(ruleStatus = 'enforced') {
  const s = String(ruleStatus || 'enforced').toLowerCase();
  if (s === 'proposed' || s === 'candidate' || s === 'deprecated') return 0;
  if (s === 'advisory') return 0.35;
  return 1.0;
}

/**
 * Computes the bounded hybrid PR Scorecard across all 5 domain agents.
 * Guarantees deterministic guardrails:
 * - `proposed` rules inflict 0 penalty
 * - `advisory` rules inflict 35% penalty
 * - `enforced` rules inflict 100% penalty
 * - Active Blocker (`🔴`) or `locked: true` rule violation caps domain at 45/100 and global PR score at 59/100
 * - Dismissed findings automatically lift their penalty & caps without requiring an AI re-run
 * - `N/A` (`applicable: false`) or disabled agents are excluded from the weighted denominator
 */
export function computeBoundedScorecard({
  rawDomains = {},
  findings = [],
  agentsConfig = null,
  rulesById = null,
  previousScorecard = null,
} = {}) {
  const catalog = loadDomainAgentCatalog();
  const normalizedCfg = normalizeDomainAgentsConfig(agentsConfig);
  const rulesLookup =
    rulesById instanceof Map
      ? rulesById
      : rulesById && typeof rulesById === 'object'
      ? new Map(Object.entries(rulesById))
      : new Map();

  // Enrich findings with resolved domain & rule status
  const enrichedFindings = (Array.isArray(findings) ? findings : [])
    .filter((f) => f && !f.isManual)
    .map((f) => {
      const domain = inferDomainForFinding(f);
      const matchedRule = f.ruleId ? rulesLookup.get(f.ruleId) : null;
      const ruleStatus = String(
        f.ruleStatus || matchedRule?.status || 'enforced'
      ).toLowerCase();
      const locked = Boolean(f.locked ?? matchedRule?.locked ?? false);
      const severityEmoji = detectSeverity(f.severity || '', '🟡');
      return {
        ...f,
        domain,
        ruleStatus,
        locked,
        severityEmoji,
      };
    });

  const domainsOutput = {};
  let weightedSum = 0;
  let activeWeightTotal = 0;
  const globalCapReasons = [];

  for (const agent of catalog) {
    const id = agent.id;
    const cfgEntry = normalizedCfg[id] || { enabled: true, weight: agent.defaultWeight };
    const rawEntry =
      rawDomains?.[id] ||
      previousScorecard?.domains?.[id] ||
      {};

    const domainFindingsAll = enrichedFindings.filter((f) => f.domain === id);
    const activeDomainFindings = domainFindingsAll.filter((f) => !f.dismissed);
    const dismissedDomainFindings = domainFindingsAll.filter((f) => Boolean(f.dismissed));

    if (!cfgEntry.enabled) {
      domainsOutput[id] = {
        id,
        title: agent.title,
        shortLabel: agent.shortLabel,
        enabled: false,
        weight: cfgEntry.weight,
        applicable: false,
        score: null,
        rawScore: rawEntry.rawScore ?? rawEntry.score ?? null,
        tier: 'na',
        capped: false,
        capReason: null,
        summary: 'Agent disabled in settings.',
        findingsCount: activeDomainFindings.length,
        blockerCount: 0,
        majorCount: 0,
        source: rawEntry.source || null,
        lastRunMode: rawEntry.lastRunMode || 'orchestrated',
        updatedAt: rawEntry.updatedAt || null,
      };
      continue;
    }

    const applicable =
      rawEntry.applicable !== undefined
        ? Boolean(rawEntry.applicable)
        : rawEntry.score === 'N/A'
        ? false
        : true;

    // If marked N/A AND has zero active findings, exclude from average
    if (!applicable && activeDomainFindings.length === 0) {
      domainsOutput[id] = {
        id,
        title: agent.title,
        shortLabel: agent.shortLabel,
        enabled: true,
        weight: cfgEntry.weight,
        applicable: false,
        score: null,
        rawScore: null,
        tier: 'na',
        capped: false,
        capReason: null,
        summary: rawEntry.summary || 'Not applicable to this Pull Request.',
        findingsCount: 0,
        blockerCount: 0,
        majorCount: 0,
        source: rawEntry.source || null,
        lastRunMode: rawEntry.lastRunMode || 'orchestrated',
        updatedAt: rawEntry.updatedAt || null,
      };
      continue;
    }

    // Compute active penalties & dismissed credit
    let activePenalty = 0;
    let dismissedCredit = 0;
    let activeEnforcedBlockers = 0;
    let activeLockedViolations = 0;
    let activeEnforcedMajors = 0;

    for (const f of activeDomainFindings) {
      const mult = statusMultiplier(f.ruleStatus);
      const base = basePenaltyForSeverityEmoji(f.severityEmoji);
      activePenalty += base * mult;

      if (f.locked && mult > 0) {
        activeLockedViolations += 1;
      }
      if (f.severityEmoji === '🔴' && f.ruleStatus !== 'proposed') {
        activeEnforcedBlockers += 1;
      } else if (f.severityEmoji === '🟠' && f.ruleStatus === 'enforced') {
        activeEnforcedMajors += 1;
      }
    }

    for (const f of dismissedDomainFindings) {
      const mult = statusMultiplier(f.ruleStatus);
      const base = basePenaltyForSeverityEmoji(f.severityEmoji);
      dismissedCredit += base * mult;
    }

    const roundedPenalty = Math.round(activePenalty);
    const deterministicCeiling = Math.max(0, 100 - roundedPenalty);

    const hasRawScore =
      rawEntry.rawScore !== undefined &&
      rawEntry.rawScore !== null &&
      Number.isFinite(Number(rawEntry.rawScore))
        ? true
        : rawEntry.score !== undefined &&
          rawEntry.score !== null &&
          Number.isFinite(Number(rawEntry.score));

    const llmRawScore = hasRawScore
      ? Math.max(0, Math.min(100, Math.round(Number(rawEntry.rawScore ?? rawEntry.score))))
      : deterministicCeiling;

    // Restore credit when findings that dragged llmRawScore down were dismissed as False Positives
    const restoredRawScore =
      dismissedDomainFindings.length > 0
        ? Math.min(100, Math.round(llmRawScore + dismissedCredit))
        : llmRawScore;

    let boundedScore = Math.min(restoredRawScore, deterministicCeiling);
    let domainCapped = false;
    let domainCapReason = null;

    if (activeLockedViolations > 0) {
      if (boundedScore > 45) boundedScore = 45;
      domainCapped = true;
      domainCapReason = `Locked rule violation in ${agent.shortLabel}`;
      globalCapReasons.push(domainCapReason);
    } else if (activeEnforcedBlockers > 0) {
      if (boundedScore > 45) boundedScore = 45;
      domainCapped = true;
      domainCapReason = `Blocker in ${agent.shortLabel}`;
      globalCapReasons.push(domainCapReason);
    } else if (activeEnforcedMajors > 0 && boundedScore > 82) {
      boundedScore = 82;
    }

    boundedScore = Math.max(0, Math.min(100, Math.round(boundedScore)));

    domainsOutput[id] = {
      id,
      title: agent.title,
      shortLabel: agent.shortLabel,
      enabled: true,
      weight: cfgEntry.weight,
      applicable: true,
      score: boundedScore,
      rawScore: llmRawScore,
      tier: scoreToTier(boundedScore),
      capped: domainCapped,
      capReason: domainCapReason,
      summary:
        rawEntry.summary ||
        (activeDomainFindings.length === 0
          ? `No ${agent.shortLabel.toLowerCase()} issues detected.`
          : `${activeDomainFindings.length} finding${activeDomainFindings.length > 1 ? 's' : ''} impacting ${agent.shortLabel.toLowerCase()}.`),
      findingsCount: activeDomainFindings.length,
      blockerCount: activeEnforcedBlockers,
      majorCount: activeEnforcedMajors,
      source: rawEntry.source || null,
      lastRunMode: rawEntry.lastRunMode || 'orchestrated',
      updatedAt: rawEntry.updatedAt || null,
    };

    if (cfgEntry.weight > 0) {
      weightedSum += boundedScore * cfgEntry.weight;
      activeWeightTotal += cfgEntry.weight;
    }
  }

  let globalScore =
    activeWeightTotal > 0 ? Math.round(weightedSum / activeWeightTotal) : null;
  let capped = false;
  let capReason = null;

  if (globalScore !== null && globalCapReasons.length > 0) {
    if (globalScore > 59) {
      globalScore = 59;
    }
    capped = true;
    capReason = globalCapReasons.join(' · ');
  }

  // Compute effective normalized weight share (%) for transparency in UI
  for (const dom of Object.values(domainsOutput)) {
    dom.effectiveWeightPct =
      dom.enabled && dom.applicable && activeWeightTotal > 0 && dom.weight > 0
        ? Math.round((dom.weight / activeWeightTotal) * 100)
        : 0;
  }

  return {
    version: 1,
    globalScore,
    tier: scoreToTier(globalScore),
    capped,
    capReason,
    activeDomainsCount: Object.values(domainsOutput).filter((d) => d.enabled && d.applicable)
      .length,
    domains: domainsOutput,
  };
}

/**
 * Extracts embedded scorecard JSON from review Markdown if present:
 * Supports `<!-- SCORECARD_JSON ... -->` or ```json scorecard ... ``` fenced blocks.
 */
export function parseScorecardBlockFromMarkdown(markdown = '') {
  if (!markdown || typeof markdown !== 'string') return null;

  const htmlCommentMatch = markdown.match(/<!--\s*SCORECARD_JSON\s*([\s\S]*?)\s*-->/i);
  if (htmlCommentMatch) {
    try {
      const parsed = JSON.parse(htmlCommentMatch[1].trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // fall through
    }
  }

  const fencedMatch = markdown.match(/```(?:json\s+scorecard|scorecard-json|scorecard)\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (fencedMatch) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignore malformed block
    }
  }

  return null;
}

export function serializeScorecardCommentBlock(scorecard) {
  if (!scorecard || typeof scorecard !== 'object') return '';
  const compact = {
    version: 1,
    globalScore: scorecard.globalScore ?? null,
    capped: Boolean(scorecard.capped),
    capReason: scorecard.capReason || null,
    domains: Object.fromEntries(
      Object.entries(scorecard.domains || {}).map(([id, d]) => [
        id,
        {
          applicable: Boolean(d.applicable),
          rawScore: d.rawScore ?? d.score ?? null,
          score: d.score ?? null,
          summary: d.summary || '',
          source: d.source || null,
          lastRunMode: d.lastRunMode || 'orchestrated',
          updatedAt: d.updatedAt || null,
        },
      ])
    ),
  };
  return `<!-- SCORECARD_JSON\n${JSON.stringify(compact, null, 2)}\n-->`;
}

export function upsertScorecardInMarkdown(markdown = '', scorecard = null) {
  const cleanMd = String(markdown || '')
    .replace(/<!--\s*SCORECARD_JSON\s*[\s\S]*?\s*-->\r?\n?/gi, '')
    .replace(/```(?:json\s+scorecard|scorecard-json|scorecard)\s*\r?\n[\s\S]*?\r?\n```\r?\n?/gi, '')
    .trim();
  if (!scorecard) return `${cleanMd}\n`;
  const block = serializeScorecardCommentBlock(scorecard);
  return `${cleanMd}\n\n${block}\n`;
}
