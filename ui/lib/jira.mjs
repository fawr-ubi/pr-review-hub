import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractJiraKey } from './metadata.mjs';

const execFileAsync = promisify(execFile);

const JIRA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function safeRepoKey(repo = '') {
  return String(repo || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getProductNoteFilePath(reviewsDir, repo, number) {
  return path.join(
    reviewsDir,
    'product-context',
    `${safeRepoKey(repo)}-${Number(number)}.json`
  );
}

function getJiraCacheFilePath(reviewsDir, jiraKey) {
  const cleanKey = String(jiraKey || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '');
  return path.join(reviewsDir, 'jira-cache', `${cleanKey}.json`);
}

export function getManualProductContextNote({ cfg, repo, number }) {
  if (!cfg?.reviewsDir || !repo || !number) return '';
  const filePath = getProductNoteFilePath(cfg.reviewsDir, repo, number);
  if (!fs.existsSync(filePath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return String(parsed?.note || '').trim();
  } catch {
    return '';
  }
}

export function saveManualProductContextNote({ cfg, repo, number, note = '' }) {
  if (!cfg?.reviewsDir || !repo || !number) {
    throw new Error('Missing reviewsDir, repo, or number');
  }
  const filePath = getProductNoteFilePath(cfg.reviewsDir, repo, number);
  const cleanNote = String(note || '').trim();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    repo,
    number: Number(number),
    note: cleanNote,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

/**
 * Flattens Atlassian Document Format (ADF) JSON nodes into clean readable Markdown/plain text.
 */
export function flattenAdfToMarkdown(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenAdfToMarkdown).join('');
  if (typeof node !== 'object') return '';

  switch (node.type) {
    case 'text':
      return node.text || '';
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return `${flattenAdfToMarkdown(node.content)}\n\n`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 3));
      return `${'#'.repeat(level)} ${flattenAdfToMarkdown(node.content).trim()}\n\n`;
    }
    case 'bulletList':
      return `${(node.content || [])
        .map((li) => `- ${flattenAdfToMarkdown(li).trim()}`)
        .join('\n')}\n\n`;
    case 'orderedList':
      return `${(node.content || [])
        .map((li, idx) => `${idx + 1}. ${flattenAdfToMarkdown(li).trim()}`)
        .join('\n')}\n\n`;
    case 'listItem':
      return flattenAdfToMarkdown(node.content);
    case 'codeBlock':
      return `\`\`\`\n${flattenAdfToMarkdown(node.content).trim()}\n\`\`\`\n\n`;
    default:
      return node.content ? flattenAdfToMarkdown(node.content) : '';
  }
}

/**
 * Determines whether a Pull Request is purely technical (`chore`, `ci`, `docs`, `build`, `N/A`)
 * without any Jira ticket, manual note, or functional specification in the PR body.
 */
export function isPureTechnicalNonProductPr(pr = {}, { jiraKey = '', prBody = '', manualNote = '' } = {}) {
  if (String(manualNote || '').trim()) return false;
  const normalizedKey = String(jiraKey || '').trim();
  if (normalizedKey && normalizedKey !== '—' && normalizedKey.toUpperCase() !== 'N/A') {
    return false;
  }
  const title = String(pr.title || '').trim();
  const branch = String(pr.headRefName || '').trim();
  const body = String(prBody || pr.body || '').trim();

  const isTechTitle =
    /^(?:chore|ci|build|docs|style|test)(?:\([^)]*\))?\s*:/i.test(title) ||
    /\bN\/A\b/i.test(title) ||
    /^(?:chore|ci|build|docs)\//i.test(branch);

  const hasFunctionalBodySpec =
    body.length > 160 &&
    /\b(acceptance|user story|expected behavior|functional|business|customer|when .* then)\b/i.test(
      body
    );

  return isTechTitle && !hasFunctionalBodySpec;
}

function findJiraWrapperScript() {
  const candidate = path.join(
    os.homedir(),
    '.gemini',
    'config',
    'plugins',
    'matawan-agents',
    'skills',
    'jira-to-markdown',
    'scripts',
    'jira-wrapper.sh'
  );
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Fetches Jira ticket context via `jira-wrapper.sh` or `acli` (cached per Jira key for 1h),
 * gracefully falling back to PR description + commits when `acli` is unavailable or unauthenticated.
 */
export async function resolveProductContextForPr({
  cfg,
  pr = {},
  prBody = '',
  commitsSummary = '',
  forceRefresh = false,
  execFn = null,
} = {}) {
  const reviewsDir = cfg?.reviewsDir || os.tmpdir();
  const jiraKey = extractJiraKey(pr, cfg?.jiraPrefixes) || '';
  const manualNote = getManualProductContextNote({
    cfg,
    repo: pr.repo,
    number: pr.number,
  });
  const effectiveBody = String(prBody || pr.body || '').trim();

  if (isPureTechnicalNonProductPr(pr, { jiraKey, prBody: effectiveBody, manualNote })) {
    return {
      applicableHint: false,
      source: 'technical_na',
      jiraKey: null,
      jiraAvailable: false,
      ticketSummary: '',
      ticketDescription: '',
      manualNote: '',
      prDescription: effectiveBody,
      fallbackReason: 'Technical PR (chore/ci/docs/N/A) without Jira specification.',
      formattedPromptBlock: [
        'Product Context Status: NOT APPLICABLE (purely technical chore/CI/docs PR with no Jira ticket or functional spec).',
        'Set `"applicable": false` and `"score": null` for the `product` domain unless you detect an unintended breaking functional/API change in the diff.',
      ].join('\n'),
    };
  }

  let jiraData = null;
  let fallbackReason = null;

  if (jiraKey) {
    const cacheFile = getJiraCacheFilePath(reviewsDir, jiraKey);
    if (!forceRefresh && fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (
          cached?.fetchedAt &&
          Date.now() - new Date(cached.fetchedAt).getTime() < JIRA_CACHE_TTL_MS &&
          (cached.summary || cached.description)
        ) {
          jiraData = { ...cached, fromCache: true };
        }
      } catch {
        // ignore corrupt cache
      }
    }

    if (!jiraData) {
      const runner =
        execFn ||
        ((cmd, args, opts) => execFileAsync(cmd, args, { timeout: 8000, maxBuffer: 2 * 1024 * 1024, ...opts }));

      // Strategy 1: official `acli jira workitem view <KEY> --json`
      try {
        const { stdout } = await runner('acli', ['jira', 'workitem', 'view', jiraKey, '--json'], {});
        const parsed = JSON.parse(String(stdout || '{}'));
        const fields = parsed?.fields || parsed || {};
        const summary = String(fields.summary || parsed.summary || '').trim();
        const status = String(fields.status?.name || parsed.status || '').trim();
        const issueType = String(fields.issuetype?.name || parsed.issueType || '').trim();
        const rawDesc = fields.description ?? parsed.description ?? '';
        const description =
          typeof rawDesc === 'string'
            ? rawDesc.trim()
            : flattenAdfToMarkdown(rawDesc).trim();

        if (summary || description) {
          jiraData = {
            jiraKey,
            summary,
            status,
            issueType,
            description: description.slice(0, 8000),
            fetchedAt: new Date().toISOString(),
          };
        }
      } catch (errAcli) {
        // Strategy 2: fallback to jira-wrapper.sh if installed and no custom test runner failed explicitly
        const wrapper = !execFn ? findJiraWrapperScript() : null;
        if (wrapper) {
          try {
            const { stdout } = await runner('bash', [wrapper, '--metadata', jiraKey], {});
            const md = String(stdout || '').trim();
            if (md) {
              jiraData = {
                jiraKey,
                summary: jiraKey,
                status: '',
                issueType: '',
                description: md.slice(0, 8000),
                fetchedAt: new Date().toISOString(),
              };
            }
          } catch (errWrapper) {
            fallbackReason = errWrapper.message || 'Jira CLI unavailable';
          }
        } else {
          fallbackReason = errAcli.message || 'acli unavailable or unauthenticated';
        }
      }

      if (jiraData) {
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(jiraData, null, 2) + '\n', 'utf8');
        } catch {
          // ignore cache write issues
        }
      }
    }
  } else {
    fallbackReason = 'No Jira ticket key detected in PR title or branch';
  }

  const source = jiraData
    ? manualNote
      ? `jira+manual (${jiraKey})`
      : `jira (${jiraKey})`
    : manualNote
    ? 'manual+pr_description'
    : 'pr_description';

  const blockParts = [
    `Product Context Source: ${source}`,
    jiraKey ? `Detected Jira Ticket: ${jiraKey}` : 'Detected Jira Ticket: None',
  ];

  if (jiraData) {
    blockParts.push(
      `Jira Summary: ${jiraData.summary || jiraKey}${jiraData.issueType ? ` [${jiraData.issueType}]` : ''}${jiraData.status ? ` (${jiraData.status})` : ''}`
    );
    if (jiraData.description) {
      blockParts.push(`Jira Acceptance Criteria & Description:\n${jiraData.description}`);
    }
  } else if (fallbackReason) {
    blockParts.push(
      `Jira CLI Note: Could not fetch live Jira ticket (${String(fallbackReason).slice(0, 140)}). Ground Product & Scope evaluation strictly on the PR title, PR description, commit history, and any manual product note below (do NOT invent unstated requirements).`
    );
  }

  if (manualNote) {
    blockParts.push(`Manual Reviewer Product Context Note:\n${manualNote}`);
  }
  if (effectiveBody) {
    blockParts.push(`PR Description:\n${effectiveBody.slice(0, 4000)}`);
  }
  if (commitsSummary) {
    blockParts.push(`PR Commits:\n${String(commitsSummary).slice(0, 2000)}`);
  }

  return {
    applicableHint: Boolean(jiraData || manualNote || effectiveBody || jiraKey),
    source,
    jiraKey: jiraKey || null,
    jiraAvailable: Boolean(jiraData),
    ticketSummary: jiraData?.summary || '',
    ticketStatus: jiraData?.status || '',
    ticketIssueType: jiraData?.issueType || '',
    ticketDescription: jiraData?.description || '',
    manualNote,
    prDescription: effectiveBody,
    fallbackReason,
    formattedPromptBlock: blockParts.join('\n\n'),
  };
}
