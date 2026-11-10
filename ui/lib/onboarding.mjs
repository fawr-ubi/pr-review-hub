import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCandidateRules, saveCandidateRules } from './rules.mjs';
import { resolveAgentBinary } from './agent.mjs';

const execFileAsync = promisify(execFile);

let customOnboardingAnalyzer = null;

export function setCustomOnboardingAnalyzerForTests(fn) {
  customOnboardingAnalyzer = fn;
}

function makeCandidateId(title, section) {
  const h = crypto
    .createHash('sha1')
    .update(`${section}::${title}`)
    .digest('hex')
    .slice(0, 10);
  return `cand-${h}`;
}

/**
 * Fetches human review comments across the last `days` (default 365 days = 1 year)
 * for the configured GitHub user and teams via `gh api graphql`.
 */
export async function fetchTeamPrReviewCommentsLastYear({
  githubOrg = 'ubitransports',
  githubUser = '',
  githubTeams = [],
  days = 365,
  maxPrsPerQuery = 35,
} = {}) {
  const cutoffDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

  const prFragment = `
    number
    title
    url
    updatedAt
    author { login }
    repository { name }
    reviews(last: 15) {
      nodes {
        author { login }
        state
        body
        comments(last: 20) {
          nodes {
            author { login }
            path
            body
          }
        }
      }
    }
  `;

  const searchBlocks = [];
  if (githubUser) {
    searchBlocks.push(`
      reviewedByUser: search(query: "org:${githubOrg} is:pr updated:>=${cutoffDate} reviewed-by:${githubUser}", type: ISSUE, first: ${maxPrsPerQuery}) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
      authoredByUser: search(query: "org:${githubOrg} is:pr updated:>=${cutoffDate} author:${githubUser}", type: ISSUE, first: ${maxPrsPerQuery}) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
    `);
  }

  const cleanTeams = (Array.isArray(githubTeams) ? githubTeams : []).filter(Boolean);
  cleanTeams.forEach((teamSlug, idx) => {
    const clean = String(teamSlug).replace(new RegExp(`^${githubOrg}/`, 'i'), '');
    searchBlocks.push(`
      team_${idx}: search(query: "org:${githubOrg} is:pr updated:>=${cutoffDate} team-review-requested:${githubOrg}/${clean}", type: ISSUE, first: ${maxPrsPerQuery}) {
        nodes { ... on PullRequest { ${prFragment} } }
      }
    `);
  });

  if (searchBlocks.length === 0) {
    return { prCount: 0, commentCount: 0, comments: [] };
  }

  const query = `{ ${searchBlocks.join('\n')} }`;
  const { stdout } = await execFileAsync('gh', ['api', 'graphql', '-f', `query=${query}`], {
    maxBuffer: 30 * 1024 * 1024,
    timeout: 60000,
  });

  const parsed = JSON.parse(stdout || '{}');
  const dataObj = parsed.data || {};
  const prsByKey = new Map();

  for (const bucket of Object.values(dataObj)) {
    for (const pr of bucket?.nodes || []) {
      if (!pr || !pr.number || !pr.repository?.name) continue;
      const key = `${pr.repository.name}#${pr.number}`;
      if (!prsByKey.has(key)) {
        prsByKey.set(key, pr);
      }
    }
  }

  const botPattern = /^(ci-cd-matawan|dependabot|renovate|github-actions|sonarcloud|codecov)/i;
  const collectedComments = [];

  for (const [prKey, pr] of prsByKey.entries()) {
    for (const rev of pr.reviews?.nodes || []) {
      const revAuthor = rev?.author?.login || '';
      if (botPattern.test(revAuthor)) continue;
      const revBody = String(rev?.body || '').trim();
      if (revBody.length >= 25 && !/^lgtm!?$/i.test(revBody)) {
        collectedComments.push({
          prKey,
          author: revAuthor,
          path: null,
          body: revBody.slice(0, 600),
        });
      }
      for (const c of rev?.comments?.nodes || []) {
        const cAuthor = c?.author?.login || revAuthor;
        if (botPattern.test(cAuthor)) continue;
        const cBody = String(c?.body || '').trim();
        if (cBody.length >= 18) {
          collectedComments.push({
            prKey,
            author: cAuthor,
            path: c.path || null,
            body: cBody.slice(0, 600),
          });
        }
      }
    }
  }

  return {
    prCount: prsByKey.size,
    commentCount: collectedComments.length,
    comments: collectedComments,
  };
}

/**
 * Deterministic fallback/fast pattern synthesizer that extracts recurring review themes
 * from raw PR review comments when the LLM CLI is unavailable or times out.
 */
export function synthesizeCandidateRulesFromComments(comments = []) {
  const buckets = [
    {
      section: '1. Architecture, Serialization & Clean Code',
      title: 'Strict SRP & Dedicated Service Extraction',
      regex: /\b(srp|single responsibility|duplicate|duplication|extract|helper|resolver|trait)\b/i,
      body: 'Avoid duplicating private helper methods across processors or controllers; extract shared business or mapping logic into a dedicated service or trait.',
    },
    {
      section: '2. Multi-Tenant, Security & Voter Isolation (Critical)',
      title: 'Strict Authenticator & Voter Permission Checks',
      regex: /\b(security|voter|authenticator|serviceaccount|permission|tenant|customer|access)\b/i,
      body: 'Always verify the exact authenticated user/service-account DTO type and tenant scope on endpoints and voters.',
    },
    {
      section: '3. Database, Migrations & Performance',
      title: 'Database Query & Migration Hygiene',
      regex: /\b(migration|index|query|n\+1|transaction|flush|repository|doctrine)\b/i,
      body: 'Avoid N+1 queries inside loops and ensure Doctrine migrations and repository queries are properly indexed and scoped.',
    },
    {
      section: '4. PHP 8.2+ & Symfony Idioms',
      title: 'Readonly Classes, Strong Typing & Constructor Promotion',
      regex: /\b(readonly|non-nullable|nullable|strict_types|type-hint)\b/i,
      body: 'Prefer readonly classes, promoted constructor properties, and strict non-nullable types on DTOs and services.',
    },
    {
      section: '4. PHP 8.2+ & Symfony Idioms',
      title: 'Zero Magic Strings & Backed Enum Constants',
      regex: /\b(magic string|magic number|backed enum|enum case|http constant|response::http_)\b/i,
      body: 'Replace magic strings and status integers with backed Enum cases, typed class constants, or Symfony Response HTTP constants.',
    },
    {
      section: '5. Testing Standards (PHPUnit & Behat)',
      title: 'Comprehensive Unit & Functional Test Coverage',
      regex: /\b(phpunit|behat|test|mock|assertion|scenario|dataproviders?)\b/i,
      body: 'Cover both nominal and error paths in PHPUnit and Behat scenarios using declarative DTO initialization.',
    },
    {
      section: '6. Naming, Typos & Boy Scout Hygiene',
      title: 'Naming Consistency & Dead Code Removal',
      regex: /\b(typo|naming|rename|unused|dead code|whitespace|nit)\b/i,
      body: 'Keep method, variable, and class names domain-accurate in English and remove unused imports or dead code.',
    },
  ];

  const results = [];
  for (const b of buckets) {
    const matching = comments.filter((c) => b.regex.test(`${c.path || ''} ${c.body || ''}`));
    if (matching.length > 0) {
      const sourcePrs = [...new Set(matching.map((m) => m.prKey))].slice(0, 6);
      const reviewers = [...new Set(matching.map((m) => m.author).filter(Boolean))].slice(0, 5);
      results.push({
        id: makeCandidateId(b.title, b.section),
        section: b.section,
        title: b.title,
        body: b.body,
        sourcePrs,
        reviewers,
        frequency: matching.length,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return results;
}

/**
 * Runs the 1-year team & user PR review history analysis and stores the synthesized rules
 * in `candidate-rules.local.json` so the user/team can validate or reject each rule in the UI.
 */
export async function bootstrapTeamCandidateRules({ cfg, days = 365 } = {}) {
  if (customOnboardingAnalyzer) {
    const customCandidates = await customOnboardingAnalyzer({ cfg, days });
    const existing = loadCandidateRules();
    const mergedMap = new Map(existing.map((c) => [c.id, c]));
    for (const item of customCandidates || []) {
      const id = item.id || makeCandidateId(item.title, item.section);
      mergedMap.set(id, {
        ...item,
        id,
        createdAt: item.createdAt || new Date().toISOString(),
      });
    }
    const saved = saveCandidateRules([...mergedMap.values()]);
    return {
      prCount: customCandidates.prCount || saved.length,
      commentCount: customCandidates.commentCount || saved.length,
      candidates: saved,
    };
  }

  const stats = await fetchTeamPrReviewCommentsLastYear({
    githubOrg: cfg.githubOrg,
    githubUser: cfg.githubUser,
    githubTeams: cfg.githubTeams,
    days,
  });

  let synthesized = synthesizeCandidateRulesFromComments(stats.comments);

  // If we have comments and Gemini CLI is available, enrich candidate rules with LLM synthesis
  if (stats.comments.length > 0) {
    try {
      const sampleComments = stats.comments
        .slice(0, 80)
        .map((c) => `[${c.prKey} by @${c.author}${c.path ? ` on ${c.path}` : ''}]: ${c.body.replace(/\s+/g, ' ')}`)
        .join('\n');

      const prompt = [
        `Analyze the following real GitHub PR review comments from the last 12 months for team [${(cfg.githubTeams || []).join(', ')}] and user @${cfg.githubUser}.`,
        `Extract between 4 and 10 high-value, recurring engineering review rules in 100% English.`,
        `Return ONLY a valid JSON array of objects with keys: "section", "title", "body", "sourcePrs" (array of PR keys like "repo#123"), "frequency" (integer).`,
        `Allowed sections: "1. Architecture, Serialization & Clean Code", "2. Multi-Tenant, Security & Voter Isolation (Critical)", "3. Database, Migrations & Performance", "4. PHP 8.2+ & Symfony Idioms", "5. Testing Standards (PHPUnit & Behat)", "6. Naming, Typos & Boy Scout Hygiene".`,
        `Comments sample:\n${sampleComments}`,
      ].join('\n\n');

      const { cli, bin } = resolveAgentBinary(cfg?.agentCli || 'agy');
      const cliArgs =
        cli === 'agy'
          ? ['--dangerously-skip-permissions', '--disable-slash-commands', '-p', prompt]
          : ['-p', prompt];
      const { stdout } = await execFileAsync(bin, cliArgs, {
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const jsonMatch = stdout.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsedLlm = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsedLlm) && parsedLlm.length > 0) {
          synthesized = parsedLlm
            .filter((item) => item && item.title && item.body)
            .map((item) => ({
              id: makeCandidateId(item.title, item.section || 'General'),
              section: item.section || '1. Architecture, Serialization & Clean Code',
              title: String(item.title).trim(),
              body: String(item.body).trim(),
              sourcePrs: Array.isArray(item.sourcePrs) ? item.sourcePrs : [],
              frequency: Number(item.frequency) || 1,
              createdAt: new Date().toISOString(),
            }));
        }
      }
    } catch {
      // Keep deterministic synthesized rules if CLI times out
    }
  }

  const existing = loadCandidateRules();
  const mergedMap = new Map(existing.map((c) => [c.id, c]));
  for (const c of synthesized) {
    mergedMap.set(c.id, c);
  }
  const saved = saveCandidateRules([...mergedMap.values()]);

  return {
    prCount: stats.prCount,
    commentCount: stats.commentCount,
    analyzedPrsCount: stats.prCount,
    analyzedCommentsCount: stats.commentCount,
    addedCandidatesCount: synthesized.length,
    candidates: saved,
  };
}
