import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseRepoRelativePath,
  detectSeverity,
  parseFindingsFromMarkdown,
  parsePatchRightLines,
  parsePatchLeftLines,
  analyzeSuggestionBlockRange,
  computeIntraLineDiffRanges,
  resolveFindingAgainstDiff
} from '../lib/parser.mjs';

import {
  loadConfig,
  saveConfig,
  ensureConfigBootstrapped,
  inferTeamProfileFromGithubTeams,
} from '../lib/config.mjs';
import { recordPrReview, generateIndexMarkdown } from '../lib/sync.mjs';
import {
  computeAuthorInitials,
  resolveAuthorDisplayName,
  extractJiraKey,
  detectStackedPr,
  normalizeCiState,
  parseCodeOwners,
  resolveRequiredOwnerTeams,
  computeMergeReadiness,
} from '../lib/metadata.mjs';
import {
  setCustomAgentRunnerForTests,
  runCliPrompt,
  runPrReviewJob,
  dismissFindingAsFalsePositive,
  isAgentAuthError,
} from '../lib/agent.mjs';
import { AutoReviewScheduler, shouldSkipAutoReview } from '../lib/scheduler.mjs';
import {
  resolveApiTransportConfig,
  buildVertexGenerateUrl,
  buildGeminiApiUrl,
  runGeminiApiPrompt,
  fetchRepoFileFromGithub,
} from '../lib/api-transport.mjs';
import {
  loadDomainAgentCatalog,
  computeBoundedScorecard,
  parseScorecardBlockFromMarkdown,
} from '../lib/scoring.mjs';
import {
  validateWanreviewRuleMarkdown,
  convertHubRuleToWanreview,
  exportRulesToWanreviewDirectory,
  loadWanreviewRulesFromRepo,
  parseTeamFromCodeownersContent,
  proposeRulePrToWanreview,
  ensureWanreviewRepoSynced,
} from '../lib/wanreview.mjs';
import {
  resolveProductContextForPr,
  saveManualProductContextNote,
  isPureTechnicalNonProductPr,
} from '../lib/jira.mjs';
import {
  hasReviewArtifact,
  saveReviewArtifact,
  pullSharedStore,
  pushSharedStore,
  assertSharedStoreNotPublicGithub,
  recordSharedFindingAction,
  readSharedFindingsState,
} from '../lib/store.mjs';
import { synthesizeCandidateRulesFromComments } from '../lib/onboarding.mjs';
import { saveCandidateRules } from '../lib/rules.mjs';
import {
  createHubServer,
  setCustomOverviewHandlerForTests,
  setCustomGithubPublishHandlerForTests,
  reconcileFindingsWithOverviewData,
} from '../server.mjs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsyncTest = promisify(execFile);

// Isolate unit tests from any real ~/.config/pr-review-hub/wanreview clone or network auto-clone
process.env.REVIEW_HUB_DISABLE_WANREVIEW_AUTOCLONE = '1';
process.env.REVIEW_HUB_WANREVIEW_DIR = '';

// =============================================================================
// 1. Unit Tests: parseRepoRelativePath
// =============================================================================
describe('parseRepoRelativePath', () => {
  test('extracts repo-relative path and line numbers from local file:// URL with #L range', () => {
    const raw = '[SendMailEventHandler.php](file:///Users/antoinefawer/Ubitransport/projects/2cloud-services/projects/services/mobility-account/src/Application/EventHandler/SendMailEventHandler.php#L42-L58)';
    const res = parseRepoRelativePath(raw, '2cloud-services');
    assert.equal(res.path, 'projects/services/mobility-account/src/Application/EventHandler/SendMailEventHandler.php');
    assert.equal(res.startLine, 42);
    assert.equal(res.endLine, 58);
  });

  test('extracts repo-relative path from worktree suffix directory (e.g. 2cloud-services-moneris)', () => {
    const raw = 'file:///Users/colleague/workspace/2cloud-services-moneris/projects/common/src/Helper/UuidHelper.php#L15';
    const res = parseRepoRelativePath(raw, '2cloud-services');
    assert.equal(res.path, 'projects/common/src/Helper/UuidHelper.php');
    assert.equal(res.startLine, 15);
    assert.equal(res.endLine, 15);
  });

  test('extracts relative path with colon line range (:10-20)', () => {
    const raw = '`src/Domain/Model/Contract.php:10-20`';
    const res = parseRepoRelativePath(raw, '2cloud');
    assert.equal(res.path, 'src/Domain/Model/Contract.php');
    assert.equal(res.startLine, 10);
    assert.equal(res.endLine, 20);
  });

  test('handles bare relative path without line numbers', () => {
    const raw = '`projects/services/subscription/src/Entity/Subscription.php`';
    const res = parseRepoRelativePath(raw, '2cloud-services');
    assert.equal(res.path, 'projects/services/subscription/src/Entity/Subscription.php');
    assert.equal(res.startLine, null);
    assert.equal(res.endLine, null);
  });

  test('handles empty or null input gracefully', () => {
    const res = parseRepoRelativePath('', '2cloud-services');
    assert.equal(res, null);
  });
});

// =============================================================================
// 2. Unit Tests: detectSeverity
// =============================================================================
describe('detectSeverity', () => {
  test('detects explicit emojis accurately', () => {
    assert.equal(detectSeverity('🔴 Blocker: SQL Injection'), '🔴');
    assert.equal(detectSeverity('🟠 Major: Missing transaction boundary'), '🟠');
    assert.equal(detectSeverity('🟡 Suggestion: Extract DTO mapper'), '🟡');
    assert.equal(detectSeverity('🔵 Nitpick: Typo in variable name'), '🔵');
  });

  test('does NOT misclassify "unit tests" as 🔵 Nitpick (word-boundary regression check)', () => {
    assert.equal(detectSeverity('🔴 Broken unit tests on CI pipeline'), '🔴');
    assert.equal(detectSeverity('Missing unit test coverage for edge case', '🟠'), '🟠');
    assert.equal(detectSeverity('Initialisation logic in constructor', '🟡'), '🟡');
  });

  test('detects text-based severity keywords with word boundaries', () => {
    assert.equal(detectSeverity('Blocker — Security vulnerability'), '🔴');
    assert.equal(detectSeverity('Major: N+1 query in loop'), '🟠');
    assert.equal(detectSeverity('Nitpick: remove unused import'), '🔵');
    assert.equal(detectSeverity('Minor nit on naming'), '🔵');
    assert.equal(detectSeverity('Clean code suggestion'), '🟡');
  });
});

// =============================================================================
// 3. Unit Tests: parseFindingsFromMarkdown
// =============================================================================
describe('parseFindingsFromMarkdown', () => {
  test('parses 4-backtick nested suggestion fences without truncating early', () => {
    const md = `
## 3. Detailed Findings

### 🟡 Clean Code, Naming & Symfony Best Practices

#### #1 — [UserCreator.php](file:///Users/dev/projects/2cloud-services/src/Service/UserCreator.php#L30-L35)
- **Category:** Clean Code
- **Why it matters:** Constructor property promotion simplifies the class.
- **Ready-to-paste GitHub comment:**
\`\`\`\`markdown
Consider using constructor property promotion here:

\`\`\`suggestion
public function __construct(
    private readonly UserRepositoryInterface $userRepository,
) {}
\`\`\`
\`\`\`\`
`;
    const findings = parseFindingsFromMarkdown(md, '2cloud-services');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, '#1');
    assert.equal(findings[0].severity, '🟡');
    assert.equal(findings[0].filePath, 'src/Service/UserCreator.php');
    assert.equal(findings[0].startLine, 30);
    assert.equal(findings[0].endLine, 35);
    assert.ok(findings[0].comment.includes('```suggestion'));
    assert.ok(findings[0].comment.includes('private readonly UserRepositoryInterface $userRepository'));
  });

  test('parses 3-backtick fences and multiple findings across severity sections', () => {
    const md = `
## 3. Detailed Findings

### 🔴 Blockers & Bugs (Must Fix)

#### #1 — \`src/Security/Voter.php:12\`
- **Category:** Security
- **Why it matters:** Missing tenant check.
- **Ready-to-paste GitHub comment:**
\`\`\`markdown
🔴 **Blocker:** Please verify that the user belongs to the current tenant before granting access.
\`\`\`

### 🔵 Nitpicks & Polish

#### #2 — \`src/Security/Voter.php:45-48\`
- **Category:** Style
- **Why it matters:** Redundant else branch.
- **Ready-to-paste GitHub comment:**
\`\`\`markdown
Nit: Early return makes this easier to read.
\`\`\`
`;
    const findings = parseFindingsFromMarkdown(md, '2cloud');
    assert.equal(findings.length, 2);
    assert.equal(findings[0].severity, '🔴');
    assert.equal(findings[0].filePath, 'src/Security/Voter.php');
    assert.equal(findings[0].startLine, 12);
    assert.equal(findings[0].endLine, 12);
    assert.equal(findings[1].severity, '🔵');
    assert.equal(findings[1].startLine, 45);
    assert.equal(findings[1].endLine, 48);
  });

  test('parses standalone Section 4 Ready-to-Paste GitHub Comments format', () => {
    const md = `
## 3. Detailed Findings
No inline findings in section 3.

## 4. Ready-to-Paste GitHub Comments

### Comment #1 — \`projects/services/ma/src/Controller/ExportController.php:88\` (🟠 Major)
\`\`\`markdown
Avoid loading all entities into memory at once; use an iterable cursor instead.
\`\`\`
`;
    const findings = parseFindingsFromMarkdown(md, '2cloud-services');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, '🟠');
    assert.equal(findings[0].filePath, 'projects/services/ma/src/Controller/ExportController.php');
    assert.equal(findings[0].startLine, 88);
    assert.ok(findings[0].comment.includes('iterable cursor'));
  });
});

// =============================================================================
// 4. Unit Tests: parsePatchRightLines & resolveFindingAgainstDiff
// =============================================================================
describe('Diff Hunk Parser & Line Resolver', () => {
  const samplePatch = [
    '@@ -10,6 +10,8 @@ namespace App\\Service;',
    ' class ExampleService',
    ' {',
    '-    private string $oldProp;',
    '+    private readonly string $newProp;',
    '+    private readonly int $count;',
    '     public function execute(): void',
    '     {',
    '         return;'
  ].join('\n');

  test('parsePatchRightLines tracks context and added lines on RIGHT side and skips deleted lines', () => {
    const rightLines = parsePatchRightLines(samplePatch);
    assert.deepEqual([...rightLines], [10, 11, 12, 13, 14, 15, 16]);
  });

  test('resolveFindingAgainstDiff resolves exact line inside diff hunk', () => {
    const diffFiles = [
      { filename: 'src/Service/ExampleService.php', patch: samplePatch }
    ];
    const finding = {
      filePath: 'src/Service/ExampleService.php',
      startLine: 12,
      endLine: 13
    };
    const res = resolveFindingAgainstDiff(finding, diffFiles);
    assert.equal(res.inDiff, true);
    assert.equal(res.resolvedPath, 'src/Service/ExampleService.php');
    assert.equal(res.resolvedLine, 13);
  });

  test('resolveFindingAgainstDiff snaps to nearest hunk line when target line is outside hunk', () => {
    const diffFiles = [
      { filename: 'src/Service/ExampleService.php', patch: samplePatch }
    ];
    const finding = {
      filePath: 'src/Service/ExampleService.php',
      startLine: 50,
      endLine: 55
    };
    const res = resolveFindingAgainstDiff(finding, diffFiles);
    assert.equal(res.inDiff, true);
    assert.equal(res.resolvedPath, 'src/Service/ExampleService.php');
    assert.equal(res.resolvedLine, 16); // closest line in hunk [10..16] to 55 is 16
    assert.equal(res.snappedFrom, 55);
  });

  test('resolveFindingAgainstDiff matches by suffix when worktree prefix differs', () => {
    const diffFiles = [
      { filename: 'projects/services/mobility-account/src/Service/ExampleService.php', patch: samplePatch }
    ];
    const finding = {
      filePath: 'src/Service/ExampleService.php',
      startLine: 12,
      endLine: 12
    };
    const res = resolveFindingAgainstDiff(finding, diffFiles);
    assert.equal(res.inDiff, true);
    assert.equal(res.resolvedPath, 'projects/services/mobility-account/src/Service/ExampleService.php');
  });
});

// =============================================================================
// 5. Integration Tests: Real Review Markdown Files in Workspace
// =============================================================================
describe('Real Review Markdown Reports Integration', () => {
  const realReviewsDir =
    process.env.REVIEWS_DIR || path.join(os.homedir(), 'Ubitransport/projects/artifacts/reviews');

  test('successfully parses all real review-*.md files without throwing', () => {
    if (!fs.existsSync(realReviewsDir)) return;
    const files = fs.readdirSync(realReviewsDir).filter(f => f.startsWith('review-') && f.endsWith('.md'));
    assert.ok(files.length > 0, 'Expected at least one review-*.md file in reviews directory');

    for (const file of files) {
      const content = fs.readFileSync(path.join(realReviewsDir, file), 'utf8');
      const findings = parseFindingsFromMarkdown(content, '2cloud-services');
      assert.ok(Array.isArray(findings), `Findings for ${file} should be an array`);
      for (const f of findings) {
        assert.ok(f.id, `Finding in ${file} must have an id`);
        assert.ok(['🔴', '🟠', '🟡', '🟢', '🔵', '💬', '❓'].includes(f.severity), `Valid severity in ${file}: got ${f.severity}`);
        assert.ok(typeof f.comment === 'string' && f.comment.length > 0, `Non-empty comment in ${file}`);
      }
    }
  });
});

// =============================================================================
// 6. End-to-End HTTP Server & Portable Config Tests
// =============================================================================
describe('HTTP Server & Portable Config E2E', () => {
  let tmpDir;
  let configPath;
  let reviewsDir;
  let server;
  let baseUrl;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-hub-test-'));
    configPath = path.join(tmpDir, 'config.json');
    reviewsDir = path.join(tmpDir, 'reviews');
    fs.mkdirSync(path.join(reviewsDir, 'archive'), { recursive: true });

    process.env.REVIEW_HUB_CONFIG = configPath;

    // Seed initial config & mock state
    saveConfig({
      reviewsDir,
      githubUser: 'test-colleague',
      githubTeams: ['ubitransports/team-alpha'],
      githubOrg: 'ubitransports',
      jiraBaseUrl: 'https://ubitransport.atlassian.net/browse/',
      port: 0
    });

    const sampleState = {
      lastSyncAt: '2026-11-04T15:00:00Z',
      prs: {
        '2cloud-services#9999': {
          number: 9999,
          title: 'feat(MA): PRD-9999 - Add portable review hub test',
          url: 'https://github.com/ubitransports/2cloud-services/pull/9999',
          repo: '2cloud-services',
          author: 'alice-dev',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          headRefName: 'feat/PRD-9999-portable',
          baseRefName: 'main',
          headSha: 'abcdef1234567890abcdef1234567890abcdef12',
          lastReviewedSha: 'abcdef1234567890abcdef1234567890abcdef12',
          status: 'UP_TO_DATE',
          reviewFile: 'review-2cloud-services-9999.md',
          verdict: '🟢 Ready to Approve',
          findingsSummary: '0 🔴, 0 🟠, 1 🟡, 0 🔵'
        }
      }
    };
    fs.writeFileSync(path.join(reviewsDir, '.state.json'), JSON.stringify(sampleState, null, 2));

    const sampleReviewMd = `# Code Review: 2cloud-services #9999

## 1. Executive Summary & Verdict
- **Verdict:** 🟢 **Ready to Approve**

## 3. Detailed Findings

### 🟡 Clean Code, Naming & Symfony Best Practices

#### #1 — \`src/Service/PortableService.php:15-18\`
- **Category:** Clean Code
- **Why it matters:** Keep config portable.
- **Ready-to-paste GitHub comment:**
\`\`\`markdown
Consider injecting the configuration object via constructor.
\`\`\`
`;
    fs.writeFileSync(path.join(reviewsDir, 'review-2cloud-services-9999.md'), sampleReviewMd);

    server = createHubServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('GET / serves index.html dashboard', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('PR Review Hub'));
  });

  test('GET /api/config returns portable user configuration', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.config.githubUser, 'test-colleague');
    assert.deepEqual(data.config.githubTeams, ['ubitransports/team-alpha']);
  });

  test('POST /api/config updates configuration persistently', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubUser: 'bob-reviewer',
        githubTeams: 'ubitransports/popcorn-back, ubitransports/ubi-eng-team-popcorn'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.config.githubUser, 'bob-reviewer');
    assert.equal(data.config.githubTeams.length, 2);

    const reloaded = loadConfig();
    assert.equal(reloaded.githubUser, 'bob-reviewer');
  });

  test('GET /api/state returns enriched PR list', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.prs.length, 1);
    assert.equal(data.prs[0].number, 9999);
    assert.equal(data.prs[0].isArchived, false);
    assert.equal(data.prs[0].findingsCount, 1);
  });

  test('GET /api/review parses markdown and returns structured findings', async () => {
    const res = await fetch(`${baseUrl}/api/review?file=review-2cloud-services-9999.md&key=${encodeURIComponent('2cloud-services#9999')}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.findings.length, 1);
    assert.equal(data.findings[0].filePath, 'src/Service/PortableService.php');
    assert.equal(data.findings[0].startLine, 15);
    assert.equal(data.findings[0].endLine, 18);
  });

  test('GET /api/review rejects directory traversal attempts with 400', async () => {
    const res = await fetch(`${baseUrl}/api/review?file=${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(res.status, 400);
  });

  test('POST /api/ui-state persists edited comment and posted checkbox state', async () => {
    const cid = '2cloud-services#9999::#1';
    const res = await fetch(`${baseUrl}/api/ui-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cid,
        posted: true,
        customComment: 'Updated custom comment before posting.'
      })
    });
    assert.equal(res.status, 200);

    const reviewRes = await fetch(`${baseUrl}/api/review?file=review-2cloud-services-9999.md&key=${encodeURIComponent('2cloud-services#9999')}`);
    const reviewData = await reviewRes.json();
    assert.equal(reviewData.findings[0].posted, true);
    assert.equal(reviewData.findings[0].customComment, 'Updated custom comment before posting.');
  });
});

// =============================================================================
// 7. Unit & E2E Tests: Author Initials, Stacked PRs, Working Tree & Agent Q&A
// =============================================================================
describe('Metadata, Working Tree Explorer, Worktrees & Agent Q&A', () => {
  let tmpRoot;
  let projectsDir;
  let repoDir;
  let reviewsDir;
  let fpFile;
  let configPath;
  let headSha;
  let server;
  let baseUrl;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-hub-wt-test-'));
    projectsDir = path.join(tmpRoot, 'projects');
    repoDir = path.join(projectsDir, 'demo-service');
    reviewsDir = path.join(tmpRoot, 'reviews');
    fpFile = path.join(tmpRoot, 'false-positives.md');
    configPath = path.join(tmpRoot, 'config.json');

    fs.mkdirSync(path.join(repoDir, 'src', 'Service'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'vendor', 'autoload'), { recursive: true });
    fs.mkdirSync(path.join(reviewsDir, 'archive'), { recursive: true });
    fs.writeFileSync(fpFile, '# False Positives\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'vendor', 'autoload.php'), '<?php // vendor autoload\n', 'utf8');
    fs.writeFileSync(
      path.join(repoDir, 'src', 'Service', 'OrderProcessor.php'),
      '<?php\nnamespace App\\Service;\nclass OrderProcessor {\n  public function processOrder(): bool {\n    return true;\n  }\n}\n',
      'utf8'
    );

    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@ubitransport.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    execFileSync('git', ['add', 'src/Service/OrderProcessor.php'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'feat(MA): PRD-4242 - Add OrderProcessor'], { cwd: repoDir });
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    process.env.REVIEW_HUB_CONFIG = configPath;
    process.env.REVIEW_HUB_PROJECTS_DIR = projectsDir;
    process.env.REVIEW_HUB_FP_FILE = fpFile;

    saveConfig({
      reviewsDir,
      projectsDir,
      githubUser: 'fawr-ubi',
      githubOrg: 'ubitransports',
    });

    const stateData = {
      prs: {
        'demo-service#42': {
          repo: 'demo-service',
          number: 42,
          title: 'feat(MA): PRD-4242 - Add OrderProcessor',
          state: 'OPEN',
          author: 'fawr-ubi',
          authorName: 'Antoine Fawer',
          baseRefName: 'feat/PRD-4200-parent-branch',
          headRefName: 'feat/PRD-4242-order-processor',
          headRefOid: headSha,
          ciState: 'SUCCESS',
          syncStatus: 'NEEDS_REVIEW',
          reviewFile: 'review-demo-service-42.md',
        },
      },
    };
    fs.writeFileSync(path.join(reviewsDir, '.state.json'), JSON.stringify(stateData, null, 2));

    setCustomAgentRunnerForTests(async ({ prompt }) => {
      if (prompt.includes('Execute a Mode 1 code review')) {
        return `# Code Review: demo-service #42\n\n## 1. Executive Summary & Verdict\n- **Verdict:** 🟢 **Ready to Approve**\n`;
      }
      return `In answer to your question: OrderProcessor::processOrder() returns a strict boolean.`;
    });

    server = createHubServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    setCustomAgentRunnerForTests(null);
    delete process.env.REVIEW_HUB_PROJECTS_DIR;
    delete process.env.REVIEW_HUB_FP_FILE;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('computeAuthorInitials and resolveAuthorDisplayName format full names and @handles cleanly', () => {
    assert.equal(computeAuthorInitials({ login: 'fawr-ubi', name: 'Antoine Fawer' }), 'AF');
    assert.equal(computeAuthorInitials({ login: 'fawr-ubi' }), 'AF');
    assert.equal(computeAuthorInitials({ login: 'p-pichet' }), 'PP');
    assert.equal(computeAuthorInitials({ login: 'sontungpham', name: 'Son Tung PHAM' }), 'SP');
    assert.equal(computeAuthorInitials({ login: 'jdoe-ubi' }), 'JD');

    assert.equal(resolveAuthorDisplayName({ login: 'fawr-ubi', name: 'Antoine fawer' }), 'Antoine Fawer');
    assert.equal(resolveAuthorDisplayName({ login: 'sontungpham', name: '' }), '@sontungpham');
  });

  test('extractJiraKey, detectStackedPr, and normalizeCiState work accurately', () => {
    assert.equal(extractJiraKey({ title: 'feat: PRD-17900 something' }), 'PRD-17900');
    assert.equal(detectStackedPr({ baseRefName: 'develop' }).isStacked, false);
    assert.equal(detectStackedPr({ baseRefName: 'release/v2.195.0' }).isStacked, false);
    assert.equal(detectStackedPr({ baseRefName: 'feat/HYB-2391-parent' }).isStacked, true);
    assert.equal(normalizeCiState('SUCCESS'), 'PASS');
    assert.equal(normalizeCiState('FAILURE'), 'FAIL');
    assert.equal(normalizeCiState('PENDING'), 'PENDING');
  });

  test('GET /api/tree, /api/blob, and /api/grep explore the working tree at commit SHA without mounting a worktree', async () => {
    const treeRes = await fetch(`${baseUrl}/api/tree?repo=demo-service&number=42&sha=${headSha}&path=src/Service`);
    assert.equal(treeRes.status, 200);
    const treeData = await treeRes.json();
    assert.equal(treeData.entries.length, 1);
    assert.equal(treeData.entries[0].name, 'OrderProcessor.php');
    assert.equal(treeData.worktree.mounted, false);

    const blobRes = await fetch(`${baseUrl}/api/blob?repo=demo-service&number=42&sha=${headSha}&path=src/Service/OrderProcessor.php`);
    assert.equal(blobRes.status, 200);
    const blobData = await blobRes.json();
    assert.ok(blobData.content.includes('public function processOrder(): bool'));

    const grepRes = await fetch(`${baseUrl}/api/grep?repo=demo-service&number=42&sha=${headSha}&q=processOrder`);
    assert.equal(grepRes.status, 200);
    const grepData = await grepRes.json();
    assert.equal(grepData.matches.length, 1);
    assert.equal(grepData.matches[0].filePath, 'src/Service/OrderProcessor.php');
    assert.equal(grepData.matches[0].line, 4);
  });

  test('POST /api/worktree/mount creates an isolated git worktree with vendor/ copy and /unmount removes it', async () => {
    const mountRes = await fetch(`${baseUrl}/api/worktree/mount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'demo-service', number: 42, headSha }),
    });
    assert.equal(mountRes.status, 200);
    const mountData = await mountRes.json();
    assert.equal(mountData.mounted, true);
    assert.ok(fs.existsSync( path.join(mountData.worktreePath, 'src/Service/OrderProcessor.php') ));
    assert.ok(fs.existsSync( path.join(mountData.worktreePath, 'vendor/autoload.php') ));

    const unmountRes = await fetch(`${baseUrl}/api/worktree/unmount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'demo-service', number: 42 }),
    });
    assert.equal(unmountRes.status, 200);
    const unmountData = await unmountRes.json();
    assert.equal(unmountData.mounted, false);
    assert.equal(fs.existsSync(mountData.worktreePath), false);
  });

  test('POST /api/agent/chat and /api/agent/dismiss handle Q&A and Mode 2 False Positives', async () => {
    const chatRes = await fetch(`${baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: 'demo-service',
        number: 42,
        message: 'Que retourne processOrder ?',
        action: 'ask',
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.equal(chatData.messages.length, 2);
    assert.ok(chatData.assistantMsg.text.includes('OrderProcessor::processOrder()'));

    const dismissRes = await fetch(`${baseUrl}/api/agent/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: 'demo-service',
        number: 42,
        finding: { id: '#1', title: 'Test Finding', filePath: 'src/Service/OrderProcessor.php' },
        reason: 'Intentional design in this microservice',
      }),
    });
    assert.equal(dismissRes.status, 200);
    const fpContent = fs.readFileSync(fpFile, 'utf8');
    assert.ok(fpContent.includes('Intentional design in this microservice'));
  });

  test('parseFindingsFromMarkdown prioritizes EN comment over FR, strips redundant Blocking: prefix, and extracts (lines X-Y)', () => {
    const md = `
## Detailed Findings

### #1 — 🔴 Blocking: Legacy \`.test\` service URLs in merged Behat scenarios
- **File:** [\`projects/services/front-partner/features/ShoppingCartItem/post/invalid.feature\`](file:///Users/antoinefawer/Ubitransport/projects/2cloud-services/projects/services/front-partner/features/ShoppingCartItem/post/invalid.feature) (lines 180–344)

#### Ready-to-paste GitHub comment (EN):
\`\`\`markdown
English comment that must win over the French block.
\`\`\`

#### Ready-to-paste GitHub comment (FR):
\`\`\`markdown
Commentaire en français qui ne doit jamais écraser le bloc anglais.
\`\`\`
`;
    const findings = parseFindingsFromMarkdown(md, '2cloud-services');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, 'Legacy `.test` service URLs in merged Behat scenarios');
    assert.equal(findings[0].comment, 'English comment that must win over the French block.');
    assert.equal(findings[0].startLine, 180);
    assert.equal(findings[0].endLine, 344);
  });

  test('GET, POST, PUT, and DELETE /api/rules manage reviewer-dna.md and false-positives.md rules', async () => {
    const dnaFile = path.join(tmpRoot, 'reviewer-dna.md');
    const changelogFile = path.join(tmpRoot, 'changelog.md');
    fs.writeFileSync(
      dnaFile,
      `# Reviewer DNA\n\n## 1. Architecture, Serialization & Clean Code\n- **Existing Rule:** Always type-hint interfaces.\n`,
      'utf8'
    );
    fs.writeFileSync(changelogFile, `# Changelog\n`, 'utf8');
    process.env.REVIEW_HUB_DNA_FILE = dnaFile;
    process.env.REVIEW_HUB_CHANGELOG_FILE = changelogFile;

    // 1. GET /api/rules
    const listRes1 = await fetch(`${baseUrl}/api/rules`);
    assert.equal(listRes1.status, 200);
    const listData1 = await listRes1.json();
    assert.ok(listData1.rules.some((r) => r.title === 'Existing Rule' && r.target === 'dna'));

    // 2. POST /api/rules
    const addRes = await fetch(`${baseUrl}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'dna',
        section: '1. Architecture, Serialization & Clean Code',
        title: 'Strict DateTimeImmutable Usage',
        body: 'Prefer DateTimeImmutable over mutable DateTime in DTOs and entities.',
        source: '2cloud-services#5648 (#1)',
      }),
    });
    assert.equal(addRes.status, 200);
    const addData = await addRes.json();
    const addedRule = addData.rules.find((r) => r.title === 'Strict DateTimeImmutable Usage');
    assert.ok(addedRule);

    // 3. PUT /api/rules
    const updateRes = await fetch(`${baseUrl}/api/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: addedRule.id,
        target: 'dna',
        title: 'Strict DateTimeImmutable Only',
        body: 'Always enforce DateTimeImmutable across all domain services.',
      }),
    });
    assert.equal(updateRes.status, 200);
    const updateData = await updateRes.json();
    const updatedRule = updateData.rules.find((r) => r.title === 'Strict DateTimeImmutable Only');
    assert.ok(updatedRule);
    assert.ok(updatedRule.body.includes('Always enforce DateTimeImmutable'));

    // 4. DELETE /api/rules
    const delRes = await fetch(`${baseUrl}/api/rules`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: updatedRule.id,
        target: 'dna',
      }),
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.ok(!delData.rules.some((r) => r.title === 'Strict DateTimeImmutable Only'));

    const changelogContent = fs.readFileSync(changelogFile, 'utf8');
    assert.ok(changelogContent.includes('Added DNA rule'));
    assert.ok(changelogContent.includes('Removed DNA rule'));

    delete process.env.REVIEW_HUB_DNA_FILE;
    delete process.env.REVIEW_HUB_CHANGELOG_FILE;
  });

  test('UI serves full-screen Focus Diff mode, sticky diff header, and ArrowLeft/ArrowRight keyboard navigation', async () => {
    const [jsRes, cssRes] = await Promise.all([
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    assert.equal(jsRes.status, 200);
    assert.equal(cssRes.status, 200);
    const js = await jsRes.text();
    const css = await cssRes.text();

    assert.ok(css.includes('.app-shell.focus-diff-mode .pr-topbar'));
    assert.ok(css.includes('.app-shell.focus-diff-mode .view-tabs'));
    assert.ok(css.includes('.diff-scroll-area'));
    assert.ok(js.includes('selectRelativeDiffFile'));
    assert.ok(js.includes("getKeybind('prevFile')"));
    assert.ok(js.includes("getKeybind('nextFile')"));
    assert.ok(!js.includes('diffFileJumpSelect'));
    assert.ok(js.includes('openKeyboardShortcutsModal'));
    assert.ok(js.includes('applyDiffZoomVariables'));
    assert.ok(css.includes('--diff-font-size'));
  });

  test('1-year team PR review comment onboarding synthesizes candidate rules and requires user approval/rejection before activation', async () => {
    const tmpWanOnboarding = path.join(tmpRoot, 'wanreview-onboarding');
    fs.mkdirSync(path.join(tmpWanOnboarding, 'rules', 'org'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWanOnboarding, 'rules', 'org', 'no-secrets.md'),
      [
        '---',
        'id: org.no-secrets',
        'title: Never commit secrets or credentials',
        'severity: high',
        'locked: true',
        '---',
        '',
        'Never hardcode credentials.',
        '',
        '## Flag',
        '- Committed secrets or API keys.',
        '',
        '## Accept',
        '- Environment variables.',
        '',
      ].join('\n'),
      'utf8'
    );
    const dnaFile = path.join(tmpRoot, 'reviewer-dna.local.md');
    const candidateFile = path.join(tmpRoot, 'candidate-rules.local.json');
    const changelogFile = path.join(tmpRoot, 'changelog.local.md');

    fs.writeFileSync(
      dnaFile,
      `# Local DNA\n\n## 1. Architecture, Serialization & Clean Code\n`,
      'utf8'
    );
    fs.writeFileSync(changelogFile, `# Changelog\n`, 'utf8');

    process.env.REVIEW_HUB_WANREVIEW_DIR = tmpWanOnboarding;
    process.env.REVIEW_HUB_DNA_FILE = dnaFile;
    process.env.REVIEW_HUB_CANDIDATES_FILE = candidateFile;
    process.env.REVIEW_HUB_CHANGELOG_FILE = changelogFile;

    // Simulate 1-year team PR review comments from GitHub
    const sampleComments = [
      {
        pr: '2cloud-services#5100',
        reviewer: 'alice-dev',
        path: 'src/Dto/Input/CreateUserDto.php',
        body: 'Can we declare this DTO as a `readonly class` and remove redundant `readonly` on properties?',
      },
      {
        pr: '2cloud-services#5210',
        reviewer: 'bob-dev',
        path: 'src/Service/PaymentService.php',
        body: 'Please avoid magic strings here and use the backed Enum case or HTTP constant instead.',
      },
      {
        pr: '2cloud-services#5300',
        reviewer: 'charlie-dev',
        path: 'tests/Unit/PaymentServiceTest.php',
        body: 'Prefer `createStub()` instead of `createMock()` when no `expects()` call is needed in PHPUnit.',
      },
    ];

    const synthesized = synthesizeCandidateRulesFromComments(sampleComments, []);
    assert.equal(synthesized.length, 3);
    saveCandidateRules(synthesized);

    // 1. GET /api/rules returns centralized wanreview rules + pending candidate rules
    const listRes = await fetch(`${baseUrl}/api/rules`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.candidates.length, 3);
    assert.ok(listData.rules.some((r) => r.target === 'wanreview' && r.wanreviewId === 'org.no-secrets'));

    // 2. Approve first candidate into Local DNA ('dna')
    const cand1 = listData.candidates[0];
    const approveRes = await fetch(`${baseUrl}/api/rules/candidates/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: cand1.id,
        action: 'approve',
        target: 'dna',
      }),
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.equal(approveData.candidates.length, 2);
    assert.ok(approveData.rules.some((r) => r.title === cand1.title && r.target === 'dna'));

    // 3. Reject second candidate
    const cand2 = approveData.candidates[0];
    const rejectRes = await fetch(`${baseUrl}/api/rules/candidates/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: cand2.id,
        action: 'reject',
      }),
    });
    assert.equal(rejectRes.status, 200);
    const rejectData = await rejectRes.json();
    assert.equal(rejectData.candidates.length, 1);
    assert.ok(!rejectData.rules.some((r) => r.title === cand2.title));

    // 4. Verify GET /api/github/teams endpoint responds cleanly
    const teamsRes = await fetch(`${baseUrl}/api/github/teams?org=ubitransports`);
    assert.equal(teamsRes.status, 200);
    const teamsData = await teamsRes.json();
    assert.ok(Array.isArray(teamsData.teams));

    process.env.REVIEW_HUB_WANREVIEW_DIR = '';
    delete process.env.REVIEW_HUB_DNA_FILE;
    delete process.env.REVIEW_HUB_CANDIDATES_FILE;
    delete process.env.REVIEW_HUB_CHANGELOG_FILE;
  });

  test('Full-Page PR Selection Queue, zero abbreviations (full words), rich PR tags, 3-theme cycle (light/purple/dark), and >100 files pagination', async () => {
    const [htmlRes, jsRes, cssRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    assert.equal(htmlRes.status, 200);
    assert.equal(jsRes.status, 200);
    assert.equal(cssRes.status, 200);

    const html = await htmlRes.text();
    const js = await jsRes.text();
    const css = await cssRes.text();

    // Full-page PR selection queue layout & controls (exclusively full-page, no narrow left PR column)
    assert.ok(html.includes('pr-queue-fullpage'));
    assert.ok(html.includes('id="backToPrQueueBtn"'));
    assert.ok(html.includes('id="returnToActivePrBtn"'));
    assert.ok(!html.includes('id="togglePinSidebarBtn"'));
    assert.ok(!html.includes('id="togglePrSidebarBtn"'));
    assert.ok(css.includes('.app-shell.pr-queue-fullpage'));
    assert.ok(js.includes('enterPrReviewWorkspace'));
    assert.ok(js.includes('showFullPagePrQueue'));

    // Removed redundant buttons (.zip and topbar Focus Diff) and removed 2-letter initials badges
    assert.ok(!html.includes('/api/export-zip'));
    assert.ok(!html.includes('id="toggleZenModeBtn"'));
    assert.ok(!html.includes('id="prAuthorInitialsBadge"'));
    assert.ok(!js.includes('author-initials-circle'));

    // Zero abbreviations (full words in English) & rich PR detail tags in HTML and JS
    assert.ok(html.includes('Settings'));
    assert.ok(html.includes('Review All'));
    assert.ok(html.includes('Sync GitHub'));
    assert.ok(html.includes('Peer-Review'));
    assert.ok(html.includes('Self-Review'));
    assert.ok(html.includes('Mount Worktree'));
    assert.ok(js.includes('All repositories'));
    assert.ok(js.includes('CI: Success'));
    assert.ok(js.includes('CI: Failure'));
    assert.ok(js.includes('Stacked branch →'));
    assert.ok(js.includes('Worktree: Direct Git'));
    assert.ok(js.includes('Open Diff'));
    assert.ok(js.includes('Read Audit'));
    assert.ok(js.includes('Approved by:'));
    assert.ok(js.includes('Changes requested by:'));
    assert.ok(js.includes('Waiting for:'));
    assert.ok(js.includes('Git conflict'));
    assert.ok(js.includes('Mergeable'));
    assert.ok(!js.includes('$1 blk'));
    assert.ok(!js.includes('$1 maj'));

    // 3-Theme cycle with 'purple' between 'light' and 'dark'
    assert.ok(css.includes('[data-theme="purple"]'));
    assert.ok(css.includes('#231f33'));
    assert.ok(js.includes("const THEME_ORDER = ['light', 'purple', 'dark']"));

    // Dedicated 'b' shortcut for modified file tree & Enter/Cmd+Enter chat submission
    assert.ok(js.includes("getKeybind('toggleFiles')"));
    assert.ok(js.includes('Hide Files ('));
    assert.ok(js.includes("document.getElementById('agentChatInput')?.addEventListener('keydown'"));
    assert.ok(js.includes('form.requestSubmit()'));

    // On-demand context expansion (↑ / ↓ arrows & full-file toggle) for unchanged lines in Diff
    assert.ok(js.includes('parsePatchIntoHunks'));
    assert.ok(js.includes('renderGapWithExpanderHtml'));
    assert.ok(js.includes('diff-expand-range-btn'));
    assert.ok(js.includes('diff-expand-eof-btn'));
    assert.ok(js.includes('diffExpandAllContextBtn'));
    assert.ok(css.includes('.diff-expand-btn'));
    assert.ok(css.includes('.diff-row-expanded-ctx'));

    // Responsive Split-view toolbars, resizable left file tree, full file names & collapsible folders
    assert.ok(html.includes('id="diffSidebarResizer"'));
    assert.ok(html.includes('id="tab-overview"'));
    assert.ok(css.includes('.file-tree-resizer'));
    assert.ok(css.includes('--file-sidebar-width'));
    assert.ok(css.includes('.diff-folder-group'));
    assert.ok(css.includes('.diff-file-path-sub'));
    assert.ok(js.includes('initSidebarResizers'));
    assert.ok(js.includes('renderDiffFileItemHtml'));

    // Customizable keybindings & dynamic legends
    assert.ok(js.includes('DEFAULT_KEYBINDINGS'));
    assert.ok(js.includes('setKeybind'));
    assert.ok(js.includes('syncKeybindingLegends'));
    assert.ok(js.includes('shortcut-recorder-btn'));
    assert.ok(html.includes('data-kb-id="toggleFiles"'));

    // Clickable breadcrumbs & inline manual comment composer
    assert.ok(js.includes('renderClickableBreadcrumbsHtml'));
    assert.ok(js.includes('bindClickableBreadcrumbs'));
    assert.ok(css.includes('.clickable-breadcrumb-bar'));
    assert.ok(js.includes('openInlineCommentComposer'));
    assert.ok(js.includes('saveManualInlineComment'));
    assert.ok(css.includes('.diff-line-add-btn'));

    // Server pagination for >100 changed files
    const serverSrc = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    assert.ok(serverSrc.includes("'--paginate'"));
    assert.ok(serverSrc.includes("'--slurp'"));
  });

  test('Manual inline comments CRUD (/api/manual-comments) persists and merges into /api/review', async () => {
    // 1. Create a manual inline comment on a PR
    const createRes = await fetch(`${baseUrl}/api/manual-comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prKey: '2cloud-services#9999',
        filePath: 'projects/services/mobility-account/src/Service/ExportService.php',
        line: 77,
        title: 'Check null return value',
        severity: '🟠 Major',
        comment: 'Please guard against null here before calling `->getId()`.',
      }),
    });
    assert.equal(createRes.status, 200);
    const createdData = await createRes.json();
    assert.equal(createdData.ok, true);
    assert.ok(createdData.comment.cid.startsWith('2cloud-services#9999::#M1-'));
    assert.equal(createdData.comment.isManual, true);
    assert.equal(createdData.comment.startLine, 77);

    // 2. Verify GET /api/review includes the manual comment even without a markdown file
    const reviewRes = await fetch(
      `${baseUrl}/api/review?key=${encodeURIComponent('2cloud-services#9999')}`
    );
    assert.equal(reviewRes.status, 200);
    const reviewData = await reviewRes.json();
    const manualFinding = reviewData.findings.find((f) => f.cid === createdData.comment.cid);
    assert.ok(manualFinding, 'Expected manual comment in GET /api/review findings');
    assert.equal(manualFinding.customComment, 'Please guard against null here before calling `->getId()`.');

    // 3. Edit the manual comment
    const updateRes = await fetch(`${baseUrl}/api/manual-comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prKey: '2cloud-services#9999',
        cid: createdData.comment.cid,
        filePath: 'projects/services/mobility-account/src/Service/ExportService.php',
        line: 77,
        title: 'Updated title',
        severity: '🔴 Blocker',
        comment: 'Updated comment body.',
      }),
    });
    assert.equal(updateRes.status, 200);
    const updatedData = await updateRes.json();
    assert.equal(updatedData.comment.title, 'Updated title');
    assert.equal(updatedData.comment.customComment, 'Updated comment body.');

    // 4. Delete the manual comment
    const delRes = await fetch(`${baseUrl}/api/manual-comments`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prKey: '2cloud-services#9999',
        cid: createdData.comment.cid,
      }),
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.ok, true);
    assert.equal(delData.manualComments.length, 0);
  });

  test('Multi-line manual inline comments, CODEOWNERS team approval & Mergeable computation, Draft PRs, createdAt sort, default Report landing, and configurable Split panes', async () => {
    // 1. CODEOWNERS parser & required service team resolution
    const sampleCodeOwners = `
/projects/services/mobility-account @ubitransports/popcorn-back
/projects/services/subscription @ubitransports/popcorn-back
/projects/services/passenger-information-fare @ubitransports/pili-back
/projects/services/user-service @ubitransports/banana-back
/projects/common @ubitransports/popcorn-back @ubitransports/pili-back @ubitransports/banana-back @ubitransports/papaya-back
`;
    const rules = parseCodeOwners(sampleCodeOwners);
    assert.equal(rules.length, 5);

    const maTeams = resolveRequiredOwnerTeams(
      ['projects/services/mobility-account/src/Entity/Contract.php'],
      rules
    );
    assert.deepEqual(maTeams, ['popcorn-back']);

    const multiTeams = resolveRequiredOwnerTeams(
      [
        'projects/services/mobility-account/src/Entity/Contract.php',
        'projects/services/passenger-information-fare/src/Dto/FareDto.php',
      ],
      rules
    );
    assert.deepEqual(multiTeams, ['popcorn-back', 'pili-back']);

    // 2. computeMergeReadiness checks Draft, Git conflict, CODEOWNERS team approval, Changes Requested, and CI
    const draftCheck = computeMergeReadiness({
      pr: {
        isDraft: true,
        mergeable: 'MERGEABLE',
        changedFilePaths: ['projects/services/mobility-account/src/Entity/Contract.php'],
        latestReviews: [{ login: 'p-pichet', state: 'APPROVED' }],
      },
      ciStatus: 'PASS',
      codeOwnersRules: rules,
    });
    assert.equal(draftCheck.isMergeable, false);
    assert.ok(draftCheck.blockingReasons.includes('Draft'));

    const missingOwnerApprove = computeMergeReadiness({
      pr: {
        isDraft: false,
        mergeable: 'MERGEABLE',
        changedFilePaths: ['projects/services/mobility-account/src/Entity/Contract.php'],
        latestReviews: [{ login: 'external-user', state: 'APPROVED' }],
      },
      ciStatus: 'PASS',
      codeOwnersRules: rules,
    });
    assert.equal(missingOwnerApprove.isMergeable, false);
    assert.equal(missingOwnerApprove.requiredOwnerTeams[0].teamSlug, 'popcorn-back');
    assert.equal(missingOwnerApprove.requiredOwnerTeams[0].approved, false);

    const readyToMerge = computeMergeReadiness({
      pr: {
        isDraft: false,
        mergeable: 'MERGEABLE',
        changedFilePaths: ['projects/services/mobility-account/src/Entity/Contract.php'],
        latestReviews: [{ login: 'nahsing-ubi', state: 'APPROVED' }],
      },
      ciStatus: 'PASS',
      codeOwnersRules: rules,
    });
    assert.equal(readyToMerge.isMergeable, true);
    assert.equal(readyToMerge.blockingReasons.length, 0);
    assert.equal(readyToMerge.requiredOwnerTeams[0].approved, true);
    assert.ok(readyToMerge.requiredOwnerTeams[0].approvedBy.includes('@nahsing-ubi'));

    // 3. Multi-line manual comment creation (startLine .. endLine) and diff resolution
    const multiCreateRes = await fetch(`${baseUrl}/api/manual-comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prKey: '2cloud-services#9999',
        filePath: 'src/Service/ExampleService.php',
        startLine: 11,
        endLine: 15,
        title: 'Extract block into method',
        severity: '🟡 Suggestion',
        comment: 'Lines 11 to 15 can be extracted into a dedicated helper method.',
      }),
    });
    assert.equal(multiCreateRes.status, 200);
    const multiCreated = await multiCreateRes.json();
    assert.equal(multiCreated.comment.startLine, 11);
    assert.equal(multiCreated.comment.endLine, 15);

    const samplePatch = [
      '@@ -10,6 +10,8 @@ namespace App\\Service;',
      ' class ExampleService',
      ' {',
      '-    private string $oldProp;',
      '+    private readonly string $newProp;',
      '+    private readonly int $count;',
      '     public function execute(): void',
      '     {',
      '         return;',
    ].join('\n');
    const resolvedMulti = resolveFindingAgainstDiff(multiCreated.comment, [
      { filename: 'src/Service/ExampleService.php', patch: samplePatch },
    ]);
    assert.equal(resolvedMulti.inDiff, true);
    assert.equal(resolvedMulti.resolvedStartLine, 11);
    assert.equal(resolvedMulti.resolvedLine, 15);

    // Clean up multi-line manual comment
    await fetch(`${baseUrl}/api/manual-comments`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prKey: '2cloud-services#9999', cid: multiCreated.comment.cid }),
    });

    // 4. Verify UI includes Draft filter, Sort button, configurable Split selectors, and opens on Report
    const [htmlRes, jsRes, cssRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    const html = await htmlRes.text();
    const js = await jsRes.text();
    const css = await cssRes.text();

    assert.ok(html.includes('data-filter="draft"'));
    assert.ok(html.includes('id="prSortOrderBtn"'));
    assert.ok(html.includes('id="splitPaneSelectors"'));
    assert.ok(html.includes('id="splitLeftTabSelect"'));
    assert.ok(html.includes('id="splitRightTabSelect"'));
    assert.ok(html.includes('id="prDraftBadge"'));
    assert.ok(html.includes('id="prMergeableBadge"'));
    assert.ok(html.includes('id="prCodeOwnersBadges"'));
    assert.ok(css.includes('tr.comment-range-selected'));
    assert.ok(css.includes('.tab-panel[data-split-pane="left"]'));
    assert.ok(css.includes('.tab-panel[data-split-pane="right"]'));
    assert.ok(js.includes('bindMultiLineCommentSelection'));
    assert.ok(js.includes('setSplitLeftPanel'));
    assert.ok(js.includes('setSplitRightPanel'));
    assert.ok(js.includes("const effectiveTab = targetTab || 'report'"));
  });

  test('Ultra-thin single-line hunk separator, immediate mouseup multi-line comment composer, PR Overview tab (Description, Commits, Threads), and 4. Propositions IA', async () => {
    const [htmlRes, jsRes, cssRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    const html = await htmlRes.text();
    const js = await jsRes.text();
    const css = await cssRes.text();

    // 1. Working tree tab removed; replaced by 2. Description & Conversation (`overview`) and 4. AI Proposals (`comments`)
    assert.ok(!html.includes('data-tab="tree"'));
    assert.ok(!html.includes('id="tab-tree"'));
    assert.ok(html.includes('data-tab="overview"'));
    assert.ok(html.includes('2. Description &amp; Conversation'));
    assert.ok(html.includes('id="tabOverviewCommitsCount"'));
    assert.ok(html.includes('id="tabOverviewCommentsCount"'));
    assert.ok(html.includes('4. AI Proposals'));

    // 2. Ultra-thin single-line hunk separator (.diff-row-hunk) & 3+ digit line number non-wrapping
    assert.ok(css.includes('height: 20px;'));
    assert.ok(css.includes('padding-top: 0 !important;'));
    assert.ok(css.includes('padding-bottom: 0 !important;'));
    assert.ok(js.includes('<td class="diff-line-code"><div class="diff-hunk-header-bar">'));

    // 3. Immediate inline comment composer on mouse release (mouseup) for line drag & code text drag
    assert.ok(js.includes('_activeLineDragMouseUpHandler'));
    assert.ok(js.includes('getSelectedTextLineRange'));
    assert.ok(js.includes('ev.preventDefault()'));

    // 4. Test GET /api/github/overview, POST /api/github/thread-reply, and POST /api/github/thread-resolve
    let lastOverviewAction = null;
    setCustomOverviewHandlerForTests(async (payload) => {
      const { action } = payload;
      lastOverviewAction = { action, payload };
      if (action === 'overview') {
        return {
          repo: payload.repo,
          number: payload.number,
          title: 'feat(MA): PRD-17956 - Normalize bank card category',
          body: '### Context\nNormalize bank card categories.',
          author: 'fawr-ubi',
          commitsCount: 2,
          totalCommentsCount: 3,
          unresolvedThreadsCount: 1,
          commits: [
            {
              oid: '1111111111111111111111111111111111111111',
              shortOid: '1111111',
              messageHeadline: 'feat(MA): PRD-17956 - Initial commit',
              committedDate: '2026-11-09T10:00:00Z',
              author: 'fawr-ubi',
            },
            {
              oid: '2222222222222222222222222222222222222222',
              shortOid: '2222222',
              messageHeadline: 'test(MA): PRD-17956 - Add unit tests',
              committedDate: '2026-11-09T11:00:00Z',
              author: 'fawr-ubi',
            },
          ],
          generalComments: [
            {
              id: 'IC_1',
              author: 'p-pichet',
              body: 'Looks good overall!',
              createdAt: '2026-11-09T11:15:00Z',
            },
          ],
          reviews: [],
          reviewThreads: [
            {
              id: 'PRRT_123',
              isResolved: false,
              isOutdated: false,
              path: 'src/Service/CardCategoryNormalizer.php',
              line: 42,
              startLine: 40,
              comments: [
                {
                  id: 'PRRC_1',
                  author: 'nahsing-ubi',
                  body: 'Could we use a match expression here?',
                  createdAt: '2026-11-09T11:20:00Z',
                },
              ],
            },
          ],
        };
      }
      if (action === 'reply') {
        return {
          ok: true,
          comment: {
            id: 'PRRC_2',
            body: payload.body,
            author: 'fawr-ubi',
            createdAt: '2026-11-09T11:30:00Z',
          },
        };
      }
      if (action === 'resolve') {
        return {
          ok: true,
          thread: {
            id: payload.threadId,
            isResolved: Boolean(payload.resolve),
          },
        };
      }
      return { ok: true };
    });

    try {
      const ovRes = await fetch(
        `${baseUrl}/api/github/overview?repo=2cloud-services&number=5651`
      );
      assert.equal(ovRes.status, 200);
      const ovData = await ovRes.json();
      assert.equal(ovData.commitsCount, 2);
      assert.equal(ovData.commits.length, 2);
      assert.equal(ovData.reviewThreads.length, 1);
      assert.equal(ovData.reviewThreads[0].id, 'PRRT_123');

      const replyRes = await fetch(`${baseUrl}/api/github/thread-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: '2cloud-services',
          number: 5651,
          threadId: 'PRRT_123',
          body: 'Done in commit 2222222!',
        }),
      });
      assert.equal(replyRes.status, 200);
      const replyData = await replyRes.json();
      assert.equal(replyData.ok, true);
      assert.equal(lastOverviewAction.action, 'reply');
      assert.equal(lastOverviewAction.payload.threadId, 'PRRT_123');

      const resolveRes = await fetch(`${baseUrl}/api/github/thread-resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: '2cloud-services',
          number: 5651,
          threadId: 'PRRT_123',
          resolve: true,
        }),
      });
      assert.equal(resolveRes.status, 200);
      const resolveData = await resolveRes.json();
      assert.equal(resolveData.ok, true);
      assert.equal(resolveData.thread.isResolved, true);
    } finally {
      setCustomOverviewHandlerForTests(null);
    }
  });

  test('2-tier Git diff menu without PhpStorm/Tree/Hunk text, J/K PR list auto-scroll, Split mode file tree auto-collapse, and GitHub syntax & file colors', async () => {
    const [htmlRes, jsRes, cssRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    const html = await htmlRes.text();
    const js = await jsRes.text();
    const css = await cssRes.text();

    // 1. 2-tier diff header layout & removed PhpStorm / Tree / <- PRs / Hunk word from diff submenu
    assert.ok(js.includes('diff-file-header-identity'));
    assert.ok(js.includes('diff-file-header-toolbar'));
    assert.ok(js.includes('diff-nav-group'));
    assert.ok(js.includes('diff-hunk-nav-group'));
    assert.ok(!js.includes('id="diffOpenIdeBtn"'));
    assert.ok(!js.includes('id="diffOpenFullFileBtn"'));
    assert.ok(!js.includes('id="diffBackToQueueInlineBtn"'));
    assert.ok(!js.includes('&uarr; Hunk'));
    assert.ok(!js.includes('&darr; Hunk'));

    // 2. Auto-scroll PR list (#prList) when navigating with j / k
    assert.ok(js.includes("const activeCard = listEl.querySelector('.pr-card.active')"));
    assert.ok(js.includes("activeCard?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })"));

    // 3. Smart Split-mode adaptation: auto-collapse file tree sidebar & compact buttons
    assert.ok(js.includes('state._prevSplitFileTree = state.fileTreeCollapsed'));
    assert.ok(css.includes('.panels-container.split-mode .diff-file-header'));
    assert.ok(css.includes('.panels-container.split-mode .diff-file-header-toolbar .btn'));

    // 4. GitHub-style file status badges (M/A/D/R only, no extension badge) and syntax highlighting inside diff lines
    assert.ok(html.includes('gherkin.min.js'));
    assert.ok(js.includes('getFileStatusMeta'));
    assert.ok(js.includes('getFileExtMeta'));
    assert.ok(js.includes('highlightDiffCodeLine'));
    assert.ok(js.includes('diff-line-prefix'));
    assert.ok(js.includes('diff-line-syntax'));
    assert.ok(js.includes('file-status-badge'));
    assert.ok(!js.includes('file-ext-badge'));
    assert.ok(css.includes('.file-status-badge'));
    assert.ok(css.includes('.diff-line-syntax .hljs-keyword'));
    assert.ok(css.includes('[data-theme="purple"] .diff-line-syntax .hljs-keyword'));
    assert.ok(css.includes('[data-theme="light"] .diff-line-syntax .hljs-keyword'));

    // 5. Hybrid server/client pre-fetch & Tab 2 aligned commit/conversation layout
    assert.ok(js.includes('prefetchPrData'));
    assert.ok(js.includes('scheduleClientPrPrefetch'));
    assert.ok(js.includes('pr-commit-top-row'));
    assert.ok(js.includes('pr-commit-sub-row'));
    assert.ok(js.includes('compact-review'));
    assert.ok(css.includes('.pr-commit-top-row'));
    assert.ok(css.includes('.pr-commit-sub-row'));
    assert.ok(css.includes('.pr-thread-card.compact-review .pr-thread-header'));
    assert.ok(css.includes('.pr-thread-comment,'));

    // 6. Multi-Team Profiles & Centralized wanreview + Personal (.local.md) Architecture
    assert.ok(html.includes('data-rule-target="wanreview"'));
    assert.ok(html.includes('data-rule-target="dna"'));
    assert.ok(!html.includes('data-rule-target="team"'));
    assert.ok(js.includes('openTeamProfileModal'));
    assert.ok(js.includes('activeTeamProfileSelect'));

    const tmpTeamsDir = path.join(tmpRoot, 'teams');
    fs.mkdirSync(tmpTeamsDir, { recursive: true });
    process.env.REVIEW_HUB_TEAMS_DIR = tmpTeamsDir;
    try {
      const createTeamRes = await fetch(`${baseUrl}/api/teams/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'moneris-back',
          name: 'Moneris Backend Team',
          description: 'Payment & Moneris gateway microservices',
          techStack: ['PHP 8.3+', 'Symfony', 'Moneris SDK'],
          githubTeams: ['ubi-eng-team-moneris'],
          agentInstructions: 'Enforce strict idempotency and PCI-DSS logging rules on payment endpoints.',
          activate: true,
        }),
      });
      assert.equal(createTeamRes.status, 200);
      const createdTeamData = await createTeamRes.json();
      assert.equal(createdTeamData.ok, true);
      assert.equal(createdTeamData.profile.id, 'moneris-back');
      assert.equal(createdTeamData.activeTeamProfile.id, 'moneris-back');

      // Direct writes to legacy 'team' / 'common' targets are rejected in favor of wanreview PRs
      const legacyTeamWriteRes = await fetch(`${baseUrl}/api/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'team',
          teamProfile: 'moneris-back',
          section: '1. Architecture, Serialization & Clean Code',
          title: 'Idempotent Payment Gateway Retries',
          body: 'Always attach an idempotency key when calling external payment gateway endpoints.',
        }),
      });
      assert.equal(legacyTeamWriteRes.status, 500);
      const legacyErrData = await legacyTeamWriteRes.json();
      assert.ok(legacyErrData.error.includes('ubitransports/wanreview'));
    } finally {
      delete process.env.REVIEW_HUB_TEAMS_DIR;
    }
  });

  test('GET /api/doctor and POST /api/rex provide colleague diagnostics and structured REX export', async () => {
    const docRes = await fetch(`${baseUrl}/api/doctor`);
    assert.equal(docRes.status, 200);
    const docData = await docRes.json();
    assert.ok(Array.isArray(docData.checks));
    assert.ok(docData.checks.some((c) => c.id === 'node' && c.ok === true));

    const addRexRes = await fetch(`${baseUrl}/api/rex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'ux',
        rating: 5,
        prKey: '2cloud-services#5677',
        activeTab: 'diff',
        title: 'Love the instant diff switching',
        description: 'Pre-fetching makes switching PRs super smooth.',
      }),
    });
    assert.equal(addRexRes.status, 200);
    const rexData = await addRexRes.json();
    assert.equal(rexData.ok, true);
    assert.equal(rexData.items.length, 1);
    assert.ok(rexData.markdown.includes('Love the instant diff switching'));

    const delRexRes = await fetch(`${baseUrl}/api/rex`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rexData.item.id }),
    });
    assert.equal(delRexRes.status, 200);
    const afterDel = await delRexRes.json();
    assert.equal(afterDel.items.length, 0);
  });

  test('Multi-team auto-inference, zero-jq Node.js sync engine (recordPrReview / generateIndexMarkdown), Doctor modal, and First-Run Welcome Wizard', async () => {
    // 1. Auto-inference of teamProfile from detected GitHub team slugs
    assert.equal(inferTeamProfileFromGithubTeams(['popcorn-front']), 'frontend-web');
    assert.equal(inferTeamProfileFromGithubTeams(['ubitransports/ubi-eng-team-mobile']), 'mobile-kotlin');
    assert.equal(inferTeamProfileFromGithubTeams(['ubi-eng-team-qa']), 'qa-automation');
    assert.equal(inferTeamProfileFromGithubTeams(['pili-back']), 'pili-back');
    assert.equal(inferTeamProfileFromGithubTeams(['banana-back']), 'banana-back');
    assert.equal(inferTeamProfileFromGithubTeams(['papaya-back']), 'papaya-back');
    assert.equal(inferTeamProfileFromGithubTeams(['popcorn-back']), 'popcorn-back');
    assert.equal(inferTeamProfileFromGithubTeams([]), 'popcorn-back');

    // 2. Native Node.js sync engine records review state and generates INDEX.md without jq
    const syncTmpDir = path.join(tmpRoot, 'sync-test-reviews');
    fs.mkdirSync(syncTmpDir, { recursive: true });
    const customSyncCfg = {
      githubOrg: 'ubitransports',
      githubUser: 'test-colleague',
      githubTeams: ['pili-back'],
      teamProfile: 'popcorn-back',
      projectsDir: tmpRoot,
      reviewsDir: syncTmpDir,
      jiraBaseUrl: 'https://ubitransport.atlassian.net/browse',
    };
    const recRes = recordPrReview({
      cfg: customSyncCfg,
      repo: '2cloud-services',
      number: 5800,
      headSha: 'abcdef1234567890',
      reviewStatus: '🟢 Ready to Approve',
      findingsSummary: '0 🔴, 0 🟠, 1 🟡, 0 🔵',
      jiraKey: 'PRD-18000',
      reviewFile: 'review-2cloud-services-5800.md',
    });
    assert.equal(recRes.key, '2cloud-services#5800');
    assert.ok(fs.existsSync(recRes.indexFile));
    const indexMd = fs.readFileSync(recRes.indexFile, 'utf8');
    assert.ok(indexMd.includes('2cloud-services #5800'));
    assert.ok(indexMd.includes('PRD-18000'));
    assert.ok(indexMd.includes('abcdef1'));

    // 3. Verify UI includes Doctor button, openDoctorModal, openFirstRunWelcomeModal, and Antigravity CLI (agy) option
    const [htmlRes, jsRes, docRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/api/doctor`),
    ]);
    const html = await htmlRes.text();
    const js = await jsRes.text();
    const docData = await docRes.json();

    assert.ok(html.includes('id="doctorBtn"'));
    assert.ok(js.includes('async function openDoctorModal()'));
    assert.ok(js.includes('async function openFirstRunWelcomeModal()'));
    assert.ok(js.includes('Antigravity CLI (agy)'));
    assert.ok(!docData.checks.some((c) => c.id === 'jq'));
    assert.ok(docData.checks.some((c) => c.id === 'teamProfile' && c.ok === true));
    assert.ok(docData.checks.some((c) => c.id === 'skillSymlink' && c.ok === true));
  });
});

// =============================================================================
// 8. Shared Review Hub (Write-Once, Read-Many) & Auto-Review Scheduler Tests
// =============================================================================
describe('Shared Review Hub & Single-Worker Auto-Review Engine', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-hub-shared-engine-'));
  });

  after(() => {
    setCustomAgentRunnerForTests(null);
    delete process.env.REVIEW_HUB_COMMON_DNA_FILE;
    delete process.env.REVIEW_HUB_TEAM_DNA_FILE;
    delete process.env.REVIEW_HUB_TEAM_FP_FILE;
    delete process.env.REVIEW_HUB_DNA_FILE;
    delete process.env.REVIEW_HUB_FP_FILE;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runCliPrompt resets heartbeat on streaming chunks and auto-retries once on silent stall', async () => {
    const streamBin = path.join(tmpDir, 'fake-agy-stream.sh');
    fs.writeFileSync(
      streamBin,
      [
        `#!/bin/sh`,
        `printf '%s\\n' '{"event":"init"}'`,
        `sleep 0.3`,
        `printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"# Code Review: "}}'`,
        `sleep 0.3`,
        `printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"streamed "}}'`,
        `sleep 0.3`,
        `printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"ok"}}'`,
        `sleep 0.3`,
        `printf '%s\\n' '{"event":"result","result":{"response":"# Code Review: streamed ok"}}'`,
      ].join('\n'),
      { mode: 0o755 }
    );

    // Total runtime >1200ms > inactivityTimeoutMs (850ms), yet succeeds because chunks reset heartbeat
    const streamedOut = await runCliPrompt({
      prompt: 'Short test prompt',
      cwd: tmpDir,
      agentCli: 'agy',
      timeoutMs: 6000,
      inactivityTimeoutMs: 850,
      maxRetries: 0,
      _customBinPath: streamBin,
    });
    assert.equal(streamedOut, '# Code Review: streamed ok');

    // Attempt 1 stalls silently (>650ms), triggering heartbeat kill + 1 automatic retry which succeeds
    const stateMarker = path.join(tmpDir, 'stall-attempt.txt');
    const stallThenRecoverBin = path.join(tmpDir, 'fake-agy-stall-recover.sh');
    fs.writeFileSync(
      stallThenRecoverBin,
      [
        `#!/bin/sh`,
        `MARKER=${JSON.stringify(stateMarker)}`,
        `COUNT=0`,
        `if [ -f "$MARKER" ]; then COUNT=$(cat "$MARKER"); fi`,
        `COUNT=$((COUNT + 1))`,
        `printf '%s' "$COUNT" > "$MARKER"`,
        `if [ "$COUNT" = "1" ]; then`,
        `  sleep 5`,
        `else`,
        `  printf '%s\\n' '{"event":"result","result":{"response":"# Code Review: recovered on retry"}}'`,
        `fi`,
      ].join('\n'),
      { mode: 0o755 }
    );

    const phases = [];
    const recoveredOut = await runCliPrompt({
      prompt: 'Short retry prompt',
      cwd: tmpDir,
      agentCli: 'agy',
      timeoutMs: 6000,
      inactivityTimeoutMs: 650,
      maxRetries: 1,
      _customBinPath: stallThenRecoverBin,
      onStreamUpdate: ({ phase }) => {
        if (phase) phases.push(phase);
      },
    });
    assert.equal(recoveredOut, '# Code Review: recovered on retry');
    assert.equal(fs.readFileSync(stateMarker, 'utf8'), '2');
    assert.ok(phases.some((p) => p.includes('Auto-retrying')));
  });

  test('scope: "shared" resolves centralized wanreview rules while excluding .local.md, whereas scope: "personal" includes .local.md without polluting shared store', async () => {
    const tmpWanScope = path.join(tmpDir, 'wanreview-scope');
    fs.mkdirSync(path.join(tmpWanScope, 'rules', 'org'), { recursive: true });
    fs.mkdirSync(path.join(tmpWanScope, 'rules', 'verticals', 'wfwp-backend'), { recursive: true });
    fs.mkdirSync(path.join(tmpWanScope, 'rules', 'teams', 'popcorn-back'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpWanScope, 'rules', 'org', 'no-secrets.md'),
      '---\nid: org.no-secrets\ntitle: SHARED_ORG_RULE_01\nseverity: high\nlocked: true\n---\n\nNever hardcode secrets.\n\n## Flag\n- Secrets.\n\n## Accept\n- Env vars.\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWanScope, 'rules', 'verticals', 'wfwp-backend', 'tenant-isolation.md'),
      '---\nid: wfwp-backend.tenant-isolation\ntitle: SHARED_VERTICAL_RULE_02\nseverity: high\n---\n\nIsolate tenant queries.\n\n## Flag\n- Unscoped queries.\n\n## Accept\n- Tenant-scoped queries.\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWanScope, 'rules', 'teams', 'popcorn-back', '_layer.md'),
      '---\nvertical: wfwp-backend\n---\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWanScope, 'rules', 'teams', 'popcorn-back', 'popcorn-rule.md'),
      '---\nid: popcorn-back.popcorn-rule\ntitle: SHARED_TEAM_RULE_03\nseverity: medium\n---\n\nPopcorn team convention.\n\n## Flag\n- Legacy helper.\n\n## Accept\n- Modern helper.\n',
      'utf8'
    );

    const teamFp = path.join(tmpDir, 'team-fp.md');
    const localDna = path.join(tmpDir, 'reviewer-dna.local.md');
    const localFp = path.join(tmpDir, 'false-positives.local.md');
    const reviewsDir = path.join(tmpDir, 'rule-scope-reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });

    fs.writeFileSync(teamFp, '## Team Exceptions\n- **SHARED_TEAM_FP_04:** Legacy DTO allowed.\n', 'utf8');
    fs.writeFileSync(localDna, '## Personal\n- **SECRET_LOCAL_DNA_RULE_99:** Personal preference only.\n', 'utf8');
    fs.writeFileSync(localFp, '## Personal Exceptions\n- **SECRET_LOCAL_FP_99:** Personal exception only.\n', 'utf8');

    process.env.REVIEW_HUB_WANREVIEW_DIR = tmpWanScope;
    process.env.REVIEW_HUB_TEAM_FP_FILE = teamFp;
    process.env.REVIEW_HUB_DNA_FILE = localDna;
    process.env.REVIEW_HUB_FP_FILE = localFp;

    const capturedPrompts = [];
    setCustomAgentRunnerForTests(async ({ prompt }) => {
      capturedPrompts.push(prompt);
      return `# Code Review: 2cloud-services#5701 — Test Scope\n\n## 1. Task Summary & Functional Problem Solved\n- **Verdict:** 🟢 Ready to Approve\n`;
    });

    const cfg = {
      githubOrg: 'ubitransports',
      githubUser: 'worker-bot',
      teamProfile: 'popcorn-back',
      wanreviewRepoPath: tmpWanScope,
      projectsDir: tmpDir,
      reviewsDir,
      agentCli: 'agy',
    };
    const pr = {
      repo: '2cloud-services',
      number: 5701,
      title: 'feat(MA): PRD-18100 - Test shared vs personal scope',
      author: 'alice',
      headRefOid: '1111222233334444555566667777888899990000',
    };

    await runPrReviewJob({ cfg, pr, scope: 'shared' });
    assert.equal(capturedPrompts.length, 1);
    const sharedPrompt = capturedPrompts[0];
    assert.ok(sharedPrompt.includes('FAST ZERO-WASTE MODE'));
    assert.ok(sharedPrompt.includes('SHARED_ORG_RULE_01'));
    assert.ok(sharedPrompt.includes('SHARED_VERTICAL_RULE_02'));
    assert.ok(sharedPrompt.includes('SHARED_TEAM_RULE_03'));
    assert.ok(sharedPrompt.includes('SHARED_TEAM_FP_04'));
    assert.ok(!sharedPrompt.includes('SECRET_LOCAL_DNA_RULE_99'));
    assert.ok(!sharedPrompt.includes('SECRET_LOCAL_FP_99'));
    assert.equal(
      hasReviewArtifact({
        cfg,
        repo: '2cloud-services',
        number: 5701,
        headSha: pr.headRefOid,
        teamProfile: 'popcorn-back',
      }),
      true
    );

    const personalPr = {
      repo: '2cloud-services',
      number: 5702,
      title: 'feat(MA): PRD-18101 - Personal pass',
      author: 'alice',
      headRefOid: 'aaaabbbbccccddddeeeeffff0000111122223333',
    };
    await runPrReviewJob({ cfg, pr: personalPr, scope: 'personal' });
    assert.equal(capturedPrompts.length, 2);
    const personalPrompt = capturedPrompts[1];
    assert.ok(personalPrompt.includes('SHARED_ORG_RULE_01'));
    assert.ok(personalPrompt.includes('SECRET_LOCAL_DNA_RULE_99'));
    assert.ok(personalPrompt.includes('SECRET_LOCAL_FP_99'));
    // Personal pass must NOT register a shared Hub artifact
    assert.equal(
      hasReviewArtifact({
        cfg,
        repo: '2cloud-services',
        number: 5702,
        headSha: personalPr.headRefOid,
        teamProfile: 'popcorn-back',
      }),
      false
    );

    setCustomAgentRunnerForTests(null);
    process.env.REVIEW_HUB_WANREVIEW_DIR = '';
    delete process.env.REVIEW_HUB_TEAM_FP_FILE;
    delete process.env.REVIEW_HUB_DNA_FILE;
    delete process.env.REVIEW_HUB_FP_FILE;
  });

  test('AutoReviewScheduler enforces concurrency=1 FIFO, priority jump, Draft exclusion, Reader skip, and Write-Once SHA deduplication', async () => {
    const schedReviewsDir = path.join(tmpDir, 'scheduler-reviews');
    fs.mkdirSync(schedReviewsDir, { recursive: true });

    let currentRole = 'worker';
    const makeCfg = () => ({
      githubOrg: 'ubitransports',
      githubUser: 'worker-bot',
      teamProfile: 'popcorn-back',
      hubRole: currentRole,
      autoReviewEnabled: true,
      autoSyncIntervalSec: 300,
      projectsDir: tmpDir,
      reviewsDir: schedReviewsDir,
    });

    const seedState = (sha101 = 'sha101_v1_000000') => {
      const statePayload = {
        prs: {
          '2cloud-services#101': {
            key: '2cloud-services#101',
            repo: '2cloud-services',
            number: 101,
            state: 'OPEN',
            isDraft: false,
            headRefOid: sha101,
            syncStatus: 'NEEDS_REVIEW',
            updatedAt: '2026-11-13T12:00:00Z',
          },
          '2cloud-services#102': {
            key: '2cloud-services#102',
            repo: '2cloud-services',
            number: 102,
            state: 'OPEN',
            isDraft: false,
            headRefOid: 'sha102_v1_000000',
            syncStatus: 'NEEDS_REVIEW',
            updatedAt: '2026-11-13T11:00:00Z',
          },
          '2cloud-services#103': {
            key: '2cloud-services#103',
            repo: '2cloud-services',
            number: 103,
            state: 'OPEN',
            isDraft: true,
            headRefOid: 'sha103_draft_000',
            syncStatus: 'DRAFT',
            updatedAt: '2026-11-13T13:00:00Z',
          },
        },
      };
      fs.writeFileSync(
        path.join(schedReviewsDir, '.state.json'),
        JSON.stringify(statePayload, null, 2),
        'utf8'
      );
    };
    seedState();

    let inFlight = 0;
    let maxConcurrent = 0;
    const executionOrder = [];

    const scheduler = new AutoReviewScheduler({
      loadConfigFn: makeCfg,
      scanPrQueueFn: async () => ({ actionable: [], drafts: [], upToDate: [] }),
      runReviewFn: async ({ cfg, pr, existingJob }) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        executionOrder.push(`${pr.repo}#${pr.number}@${pr.headRefOid}`);
        await new Promise((r) => setTimeout(r, 35));
        saveReviewArtifact({
          cfg,
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headRefOid,
          teamProfile: cfg.teamProfile,
          scope: 'shared',
          markdown: `# Code Review: ${pr.repo}#${pr.number}\n\n🟢 Ready to Approve\n`,
          verdict: '🟢 Ready to Approve',
          findingsSummary: '0 🔴, 0 🟠, 0 🟡, 0 🔵',
        });
        if (existingJob) {
          existingJob.status = 'completed';
          existingJob.phase = 'Completed';
        }
        inFlight--;
      },
    });

    // 1. Cycle 1: Worker enqueues #101 and #102 sequentially, excluding Draft #103
    const cycle1 = await scheduler.runSyncCycle();
    assert.equal(cycle1.enqueuedCount, 2);
    await scheduler.waitForIdle();

    assert.equal(maxConcurrent, 1, 'Worker must never run more than 1 review concurrently');
    assert.deepEqual(executionOrder, [
      '2cloud-services#101@sha101_v1_000000',
      '2cloud-services#102@sha102_v1_000000',
    ]);

    // 2. Cycle 2 (same SHAs): Write-Once guarantees 0 duplicate runs
    const cycle2 = await scheduler.runSyncCycle();
    assert.equal(cycle2.enqueuedCount, 0);
    await scheduler.waitForIdle();
    assert.equal(executionOrder.length, 2);

    // 3. Priority jump test: enqueue 2 new PRs, then promote the second to front while #201 runs
    scheduler.enqueuePrReview(
      { repo: '2cloud-services', number: 201, headRefOid: 'sha201' },
      { priority: false }
    );
    scheduler.enqueuePrReview(
      { repo: '2cloud-services', number: 202, headRefOid: 'sha202' },
      { priority: false }
    );
    scheduler.enqueuePrReview(
      { repo: '2cloud-services', number: 203, headRefOid: 'sha203' },
      { priority: true }
    );
    await scheduler.waitForIdle();
    assert.deepEqual(executionOrder.slice(2), [
      '2cloud-services#201@sha201',
      '2cloud-services#203@sha203',
      '2cloud-services#202@sha202',
    ]);

    // 4. Reader role never auto-enqueues even when a PR has a new commit SHA
    currentRole = 'reader';
    const updatedState = JSON.parse(
      fs.readFileSync(path.join(schedReviewsDir, '.state.json'), 'utf8')
    );
    fs.writeFileSync(
      path.join(schedReviewsDir, '.state.json'),
      JSON.stringify(
        {
          prs: {
            ...updatedState.prs,
            '2cloud-services#101': {
              ...updatedState.prs['2cloud-services#101'],
              headRefOid: 'sha101_v2_newcommit',
              syncStatus: 'NEEDS_UPDATE',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
    const readerCycle = await scheduler.runSyncCycle();
    assert.equal(readerCycle.enqueuedCount, 0);
    assert.equal(executionOrder.length, 5);
  });

  test('GitSharedStore syncs shared review + collaborative posted/dismissed state from Worker to Reader while keeping customComment local', async () => {
    const bareRepoDir = path.join(tmpDir, 'shared-reviews-remote.git');
    const workerReviewsDir = path.join(tmpDir, 'worker-reviews');
    const readerReviewsDir = path.join(tmpDir, 'reader-reviews');
    const readerConfigPath = path.join(tmpDir, 'reader-config.json');

    fs.mkdirSync(bareRepoDir, { recursive: true });
    fs.mkdirSync(workerReviewsDir, { recursive: true });
    fs.mkdirSync(readerReviewsDir, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: bareRepoDir });

    const workerCfg = {
      githubOrg: 'ubitransports',
      githubUser: 'antoine-worker',
      teamProfile: 'popcorn-back',
      hubRole: 'worker',
      autoReviewEnabled: true,
      autoSyncIntervalSec: 300,
      sharedStoreRepo: bareRepoDir,
      sharedStoreBranch: 'reviews-store',
      projectsDir: tmpDir,
      reviewsDir: workerReviewsDir,
    };

    const sampleSharedMd = [
      '# Code Review: 2cloud-services#5750 — Shared Hub E2E',
      '',
      '## 1. Task Summary & Functional Problem Solved',
      '- **Verdict:** 🟠 Request Changes',
      '',
      '## 3. Detailed Findings',
      '',
      '### 🟠 Major Issues',
      '',
      '#### #1 — `src/Service/PaymentGateway.php:44`',
      '- **Category:** Reliability',
      '- **Why it matters:** Missing idempotency key.',
      '- **Ready-to-paste GitHub comment:**',
      '```markdown',
      'Please pass an explicit idempotency key to the gateway request.',
      '```',
      '',
      '#### #2 — `src/Service/PaymentGateway.php:88`',
      '- **Category:** Style',
      '- **Why it matters:** Optional nit.',
      '- **Ready-to-paste GitHub comment:**',
      '```markdown',
      'Consider extracting constant.',
      '```',
    ].join('\n');

    const prSha = 'deadbeef1234567890abcdef1234567890abcdef';
    saveReviewArtifact({
      cfg: workerCfg,
      repo: '2cloud-services',
      number: 5750,
      headSha: prSha,
      teamProfile: 'popcorn-back',
      scope: 'shared',
      markdown: sampleSharedMd,
      verdict: '🟠 Request Changes',
      findingsSummary: '0 🔴, 2 🟠, 0 🟡, 0 🔵',
      jiraKey: 'PRD-18200',
      reviewedBy: 'antoine-worker',
    });

    // Worker posts #1 and dismisses #2, then pushes to bare Git repo
    recordSharedFindingAction({
      cfg: workerCfg,
      cid: '2cloud-services#5750::#1',
      action: 'posted',
      actor: 'antoine-worker',
      url: 'https://github.com/ubitransports/2cloud-services/pull/5750#discussion_r1',
    });
    const teamFpTmp = path.join(tmpDir, 'shared-team-fp.md');
    process.env.REVIEW_HUB_TEAM_FP_FILE = teamFpTmp;
    dismissFindingAsFalsePositive({
      cfg: workerCfg,
      pr: { repo: '2cloud-services', number: 5750 },
      finding: { id: '#2', title: 'Optional nit', filePath: 'src/Service/PaymentGateway.php' },
      reason: 'Accepted by team convention',
      scope: 'team',
      actor: 'colleague-reviewer',
    });
    delete process.env.REVIEW_HUB_TEAM_FP_FILE;

    const pushRes = await pushSharedStore(workerCfg, 'chore(ReviewHub): N/A - Push #5750 review');
    assert.equal(pushRes.pushed, true);

    // Reader node starts with empty local reviewsDir, pulls from bare Git repo, and serves via HTTP
    const prevConfigEnv = process.env.REVIEW_HUB_CONFIG;
    process.env.REVIEW_HUB_CONFIG = readerConfigPath;
    saveConfig(
      {
        githubOrg: 'ubitransports',
        githubUser: 'bob-reader',
        teamProfile: 'popcorn-back',
        hubRole: 'reader',
        autoReviewEnabled: false,
        sharedStoreRepo: bareRepoDir,
        sharedStoreBranch: 'reviews-store',
        projectsDir: tmpDir,
        reviewsDir: readerReviewsDir,
        onboardingCompleted: true,
      },
      readerConfigPath
    );

    const pullRes = await pullSharedStore(loadConfig(readerConfigPath));
    assert.equal(pullRes.synced, true);
    assert.equal(pullRes.hydratedCount, 1);

    const readerServer = createHubServer();
    await new Promise((r) => readerServer.listen(0, '127.0.0.1', r));
    const readerUrl = `http://127.0.0.1:${readerServer.address().port}`;

    try {
      const stateRes = await fetch(`${readerUrl}/api/state`);
      const stateData = await stateRes.json();
      const hydratedPr = stateData.prs.find((p) => p.key === '2cloud-services#5750');
      assert.ok(hydratedPr, 'Reader must see hydrated PR from GitSharedStore');
      assert.equal(hydratedPr.syncStatus, 'UP_TO_DATE');
      assert.equal(hydratedPr.postedCount, 1);
      assert.equal(hydratedPr.dismissedCount, 1);

      // Reader edits customComment locally on #1 — must NOT leak into shared findings-state.json
      await fetch(`${readerUrl}/api/ui-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cid: '2cloud-services#5750::#1',
          customComment: 'Bob personal draft wording (strictly local)',
        }),
      });

      const revRes = await fetch(
        `${readerUrl}/api/review?file=review-2cloud-services-5750.md&key=${encodeURIComponent('2cloud-services#5750')}`
      );
      assert.equal(revRes.status, 200);
      const revData = await revRes.json();
      assert.equal(revData.findings.length, 2);

      const f1 = revData.findings.find((f) => f.id === '#1');
      const f2 = revData.findings.find((f) => f.id === '#2');
      assert.equal(f1.posted, true);
      assert.equal(f1.postedBy, 'antoine-worker');
      assert.equal(f1.customComment, 'Bob personal draft wording (strictly local)');

      assert.equal(f2.dismissed, true);
      assert.equal(f2.dismissedBy, 'colleague-reviewer');

      const sharedOnReaderDisk = readSharedFindingsState(loadConfig(readerConfigPath));
      assert.equal(
        sharedOnReaderDisk.findings['2cloud-services#5750::#1']?.customComment,
        undefined,
        'Personal customComment must never be written to shared findings-state.json'
      );
    } finally {
      await new Promise((r) => readerServer.close(r));
      if (prevConfigEnv) {
        process.env.REVIEW_HUB_CONFIG = prevConfigEnv;
      } else {
        delete process.env.REVIEW_HUB_CONFIG;
      }
    }
  });

  test('Consolidation: strips legacy model config, defaults brand-new installs to reader, exposes My PR badge + 3-row header, and pauses scheduler on OAuth expiry', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-consolidation-'));
    const freshCfgPath = path.join(tmpDir, 'fresh-config.json');
    const prevRoleEnv = process.env.REVIEW_HUB_ROLE;
    delete process.env.REVIEW_HUB_ROLE;

    try {
      const bootstrapped = ensureConfigBootstrapped(freshCfgPath);
      assert.equal(bootstrapped.hubRole, 'reader', 'Brand-new teammate config must default to safe reader role');
      assert.equal('model' in bootstrapped, false, 'Default config must not expose legacy model selection');

      // Legacy config with broken model key is cleaned on load and save
      fs.writeFileSync(
        freshCfgPath,
        JSON.stringify({
          githubOrg: 'ubitransports',
          githubUser: 'teammate-dev',
          model: 'deprecated-broken-model',
          onboardingCompleted: true,
        }),
        'utf8'
      );
      const cleanedLoad = loadConfig(freshCfgPath);
      assert.equal('model' in cleanedLoad, false);
      const cleanedSave = saveConfig({ model: 'another-broken-model', hubRole: 'reader' }, freshCfgPath);
      assert.equal('model' in cleanedSave, false);

      // Auth error helper & Scheduler OAuth pause + resumeAfterAuth
      assert.equal(
        isAgentAuthError('Antigravity CLI (agy) authentication required. Click "Sign in"'),
        true
      );
      assert.equal(isAgentAuthError('Transient 503 service unavailable'), false);

      const sched = new AutoReviewScheduler({
        loadConfigFn: () => ({
          hubRole: 'worker',
          autoReviewEnabled: true,
          autoSyncIntervalSec: 300,
          teamProfile: 'popcorn-back',
          reviewsDir: tmpDir,
        }),
        scanPrQueueFn: async () => ({ prs: [] }),
        pullStoreFn: async () => ({ synced: false }),
        hydrateFn: () => {},
        runReviewFn: async () => {
          throw new Error('Antigravity CLI (agy) authentication required.');
        },
      });

      sched.enqueuePrReview({
        repo: '2cloud-services',
        number: 5999,
        headRefOid: 'deadbeef1234',
      });
      await sched.waitForIdle();
      assert.equal(sched.getStatus().authRequired, true);

      // Next automatic enqueue stays paused while authRequired is true
      const pausedRes = sched.enqueuePendingFromLocalState({ force: false });
      assert.equal(pausedRes.authRequired, true);
      assert.equal(pausedRes.enqueuedJobs.length, 0);

      // Resuming after OAuth clears authRequired
      sched.resumeAfterAuth();
      assert.equal(sched.getStatus().authRequired, false);

      // HTTP & UI verification: /api/models removed (404), UI exposes badge-my-pr, 3-row header, and welcomeHubRole
      const prevConfigEnv = process.env.REVIEW_HUB_CONFIG;
      process.env.REVIEW_HUB_CONFIG = freshCfgPath;
      const srv = createHubServer();
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const baseUrl = `http://127.0.0.1:${srv.address().port}`;
      try {
        const modelsRes = await fetch(`${baseUrl}/api/models?cli=agy`);
        assert.equal(modelsRes.status, 404, 'Removed /api/models endpoint must return 404');

        const [htmlRes, cssRes, jsRes] = await Promise.all([
          fetch(`${baseUrl}/`),
          fetch(`${baseUrl}/styles.css`),
          fetch(`${baseUrl}/app.js`),
        ]);
        const [html, css, js] = await Promise.all([htmlRes.text(), cssRes.text(), jsRes.text()]);

        assert.ok(html.includes('pr-topbar-row-top'), 'index.html must include 3-row full-width topbar');
        assert.ok(html.includes('pr-topbar-row-meta'), 'index.html must include full-width metadata row');
        assert.ok(css.includes('.badge-my-pr'), 'styles.css must define .badge-my-pr');
        assert.ok(css.includes('.pr-card.is-my-pr'), 'styles.css must define .pr-card.is-my-pr');
        assert.ok(js.includes('function isMyPr(pr)'), 'app.js must define isMyPr helper');
        assert.ok(js.includes('👤 My PR'), 'app.js must render My PR badge');
        assert.ok(js.includes('welcomeHubRole'), 'Welcome wizard must expose Reader/Worker selector');
        assert.equal(js.includes('cfgModel'), false, 'app.js must not contain legacy cfgModel selector');
      } finally {
        await new Promise((r) => srv.close(r));
        if (prevConfigEnv) {
          process.env.REVIEW_HUB_CONFIG = prevConfigEnv;
        } else {
          delete process.env.REVIEW_HUB_CONFIG;
        }
      }
    } finally {
      if (prevRoleEnv !== undefined) {
        process.env.REVIEW_HUB_ROLE = prevRoleEnv;
      }
    }
  });

  test('Visual hierarchy: highlights key CTAs, collapses secondary actions into More dropdowns, and renders bold clickable branch pills', async () => {
    const srv = createHubServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${srv.address().port}`;
    try {
      const [htmlRes, cssRes, jsRes] = await Promise.all([
        fetch(`${baseUrl}/`),
        fetch(`${baseUrl}/styles.css`),
        fetch(`${baseUrl}/app.js`),
      ]);
      const [html, css, js] = await Promise.all([htmlRes.text(), cssRes.text(), jsRes.text()]);

      // Prominent primary & daily-driver CTAs
      assert.ok(html.includes('id="backToPrQueueBtn" class="btn btn-nav-back'), 'Back to All PRs must be prominent');
      assert.ok(html.includes('id="openBatchReviewModalBtn" class="btn btn-cta-submit'), 'Submit Review must use emerald CTA');
      assert.ok(html.includes('id="triggerReviewBtn" class="btn btn-ai'), 'Run Review must use AI accent CTA');
      assert.ok(html.includes('id="reviewAllPendingBtn" class="btn btn-ai'), 'Review All must use AI accent CTA');
      assert.ok(html.includes('id="syncQueueBtn" class="btn btn-sync'), 'Sync GitHub must use sync primary CTA');
      assert.ok(html.includes('id="openGithubPrBtn"') && html.includes('btn-external'), 'GitHub link must be prominent');
      assert.ok(html.includes('id="prJiraLink"') && html.includes('btn-jira'), 'Jira ticket link must be prominent');
      assert.ok(html.includes('id="openPhpstormBtn" class="btn btn-ide'), 'PhpStorm button must use IDE highlight');
      assert.ok(html.includes('id="openVscodeBtn" class="btn btn-ide'), 'VS Code button must use IDE highlight');

      // Secondary actions grouped in More ▾ dropdowns
      assert.ok(html.includes('id="prTopbarMoreMenu"'), 'PR topbar must group secondary actions into More dropdown');
      assert.ok(html.includes('id="queueHeaderMoreMenu"'), 'Queue header must group utility actions into More dropdown');

      // Bold clickable source & target branch pills + stacked amber warning + finding CTAs + uniform heights
      assert.ok(css.includes('.branch-pill'), 'styles.css must define .branch-pill');
      assert.ok(css.includes('.branch-pill.branch-target.is-stacked'), 'styles.css must highlight stacked target branches');
      assert.ok(css.includes('.btn.btn-sm') && css.includes('height: 28px;'), 'All .btn-sm buttons must share locked 28px height');
      assert.ok(css.includes('.btn.btn-xs') && css.includes('height: 24px;'), 'All .btn-xs buttons must share locked 24px height');
      assert.ok(css.includes('[data-theme="light"] .btn.btn-ai'), 'Light theme must preserve semantic button colors');
      assert.ok(css.includes('.btn-cta-submit') && css.includes('.btn-ai') && css.includes('.btn-diff-jump'));
      assert.ok(js.includes('function renderBranchPillsHtml('), 'app.js must render bold clickable branch pills');
      assert.ok(js.includes('copy-branch-btn'), 'branch pills must copy branch name on click');
      assert.ok(js.includes('Post to GitHub') && js.includes('View in Diff'), 'Finding cards must highlight Post to GitHub & View in Diff');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('Multi-Domain PR Scoring Agents, Jira Context & wanreview Surgical Export', () => {
  test('Bounded Hybrid Scoring: loads 5 agents, handles N/A weight redistribution, respects proposed/advisory/enforced statuses, caps Blockers at 59/100, and lifts cap on Dismiss', () => {
    const catalog = loadDomainAgentCatalog();
    assert.deepEqual(
      catalog.map((a) => a.id),
      ['security', 'product', 'quality', 'performance', 'testing']
    );

    const rulesById = new Map([
      ['tenant-isolation', { id: 'tenant-isolation', status: 'enforced', locked: true }],
      ['style-hint', { id: 'style-hint', status: 'advisory', locked: false }],
      ['experimental-check', { id: 'experimental-check', status: 'proposed', locked: false }],
    ]);

    const rawDomains = {
      security: { applicable: true, rawScore: 80, summary: 'Cross-tenant query missing customer filter.' },
      product: { applicable: false, rawScore: null, summary: 'Technical chore PR — N/A.' },
      quality: { applicable: true, rawScore: 96, summary: 'Clean SOLID processor.' },
      performance: { applicable: true, rawScore: 94, summary: 'Queries properly indexed.' },
      testing: { applicable: true, rawScore: 92, summary: 'Nominal and error paths covered.' },
    };

    const findings = [
      {
        id: '#1',
        domain: 'security',
        ruleId: 'tenant-isolation',
        severity: '🔴',
        title: 'Missing customer filter on repository query',
        dismissed: false,
      },
      {
        id: '#2',
        domain: 'quality',
        ruleId: 'style-hint',
        severity: '🟠',
        title: 'Advisory naming suggestion',
        dismissed: false,
      },
      {
        id: '#3',
        domain: 'testing',
        ruleId: 'experimental-check',
        severity: '🟠',
        title: 'Proposed candidate rule should inflict zero penalty',
        dismissed: false,
      },
    ];

    const cappedCard = computeBoundedScorecard({
      rawDomains,
      findings,
      rulesById,
    });

    // Product is N/A and excluded from denominator
    assert.equal(cappedCard.domains.product.applicable, false);
    assert.equal(cappedCard.domains.product.score, null);
    assert.equal(cappedCard.domains.product.tier, 'na');
    assert.equal(cappedCard.activeDomainsCount, 4);

    // Proposed rule inflicts 0 penalty -> testing keeps its 92 rawScore
    assert.equal(cappedCard.domains.testing.score, 92);

    // Advisory Major inflicts 35% of 15 (~5 pts -> ceiling 95), capping 96 -> 95
    assert.equal(cappedCard.domains.quality.score, 95);

    // Locked / Blocker rule in security caps security domain at 45 and global PR score at 59/100
    assert.equal(cappedCard.domains.security.score, 45);
    assert.equal(cappedCard.domains.security.capped, true);
    assert.equal(cappedCard.capped, true);
    assert.equal(cappedCard.globalScore, 59);
    assert.equal(cappedCard.tier, 'warning');

    // Dismissing the False Positive Blocker immediately lifts both domain & global caps!
    const afterDismiss = computeBoundedScorecard({
      rawDomains,
      findings: findings.map((f) => (f.id === '#1' ? { ...f, dismissed: true } : f)),
      rulesById,
    });
    assert.equal(afterDismiss.capped, false);
    assert.ok(afterDismiss.domains.security.score >= 80, 'Dismissed blocker restores security score');
    assert.ok(afterDismiss.globalScore >= 88, 'Global score recovers to B/A once false positive blocker is dismissed');
  });

  test('Product & Scope Jira Context: marks chore/N/A PRs non-applicable, caches ADF Jira tickets via acli, and falls back gracefully', async () => {
    const tmpReviewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-jira-test-'));
    try {
      const cfg = { reviewsDir: tmpReviewsDir, jiraPrefixes: ['PRD'] };

      // 1. Pure technical chore PR without Jira key -> applicableHint: false
      const chorePr = {
        repo: '2cloud-services',
        number: 5800,
        title: 'chore(2CS): N/A - Bump phpstan baseline',
        headRefName: 'chore/bump-phpstan',
      };
      assert.equal(isPureTechnicalNonProductPr(chorePr), true);
      const choreCtx = await resolveProductContextForPr({ cfg, pr: chorePr });
      assert.equal(choreCtx.applicableHint, false);
      assert.equal(choreCtx.source, 'technical_na');

      // 2. Feature PR with Jira ticket fetched via mock acli (ADF JSON) + cached on second call
      let acliCalls = 0;
      const mockExec = async () => {
        acliCalls += 1;
        return {
          stdout: JSON.stringify({
            fields: {
              summary: 'Invalidate passenger card on tag disable',
              status: { name: 'In Review' },
              issuetype: { name: 'Story' },
              description: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'When a passenger tag is disabled, create CARD_INVALIDATION.' }],
                  },
                ],
              },
            },
          }),
        };
      };

      const featPr = {
        repo: '2cloud-services',
        number: 5704,
        title: 'feat(MA): PRD-17484 - Create CARD_INVALIDATION on tag disable',
        headRefName: 'feat/PRD-17484-card-invalidation',
      };
      saveManualProductContextNote({
        cfg,
        repo: featPr.repo,
        number: featPr.number,
        note: 'Verify idempotency if already disabled.',
      });

      const ctx1 = await resolveProductContextForPr({ cfg, pr: featPr, execFn: mockExec });
      const ctx2 = await resolveProductContextForPr({ cfg, pr: featPr, execFn: mockExec });
      assert.equal(acliCalls, 1, 'Second call must use 1h disk cache');
      assert.equal(ctx1.applicableHint, true);
      assert.equal(ctx1.jiraAvailable, true);
      assert.equal(ctx2.jiraKey, 'PRD-17484');
      assert.ok(ctx1.ticketDescription.includes('CARD_INVALIDATION'));
      assert.ok(ctx1.formattedPromptBlock.includes('Verify idempotency if already disabled.'));

      // 3. Graceful fallback when acli throws / is unauthenticated
      const failingExec = async () => {
        throw new Error('acli not authenticated');
      };
      const uncachedPr = {
        repo: '2cloud-services',
        number: 5705,
        title: 'feat(PIF): PRD-99999 - Add fare export',
        body: 'Exports fare CSV for active networks.',
      };
      const fallbackCtx = await resolveProductContextForPr({
        cfg,
        pr: uncachedPr,
        execFn: failingExec,
      });
      assert.equal(fallbackCtx.jiraAvailable, false);
      assert.equal(fallbackCtx.source, 'pr_description');
      assert.ok(fallbackCtx.formattedPromptBlock.includes('Exports fare CSV'));
    } finally {
      fs.rmSync(tmpReviewsDir, { recursive: true, force: true });
    }
  });

  test('Hybrid Orchestrated Review + Isolated Single-Agent Deep Pass preserves other domains while updating target domain', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-multiagent-'));
    const cfg = {
      githubOrg: 'ubitransports',
      githubUser: 'fawr-ubi',
      teamProfile: 'popcorn-back',
      agentCli: 'agy',
      projectsDir: tmpRoot,
      reviewsDir: path.join(tmpRoot, 'reviews'),
      domainAgents: {
        security: { enabled: true, weight: 25 },
        product: { enabled: true, weight: 20 },
        quality: { enabled: true, weight: 25 },
        performance: { enabled: true, weight: 15 },
        testing: { enabled: true, weight: 15 },
      },
    };

    const pr = {
      repo: '2cloud-services',
      number: 5912,
      title: 'chore(MA): N/A - Optimize tag lookup',
      author: 'colleague-ubi',
      headRefOid: 'abcdef1234567890',
    };

    let capturedPrompts = [];
    setCustomAgentRunnerForTests(async ({ prompt }) => {
      capturedPrompts.push(prompt);
      if (prompt.includes('SINGLE-DOMAIN DEEP AUDIT')) {
        return [
          '# Performance & Scalability Deep Audit: 2cloud-services#5912',
          '',
          '## 2. Review Findings',
          '',
          '### 🟠 Architecture, Security & Major Issues',
          '',
          '#### `#1` — [Await inside foreach loop](projects/services/ma/src/Handler.php#L42-L46)',
          '- **Domain:** performance',
          '- **Why it matters:** Sequential HTTP awaits inside a loop degrade latency.',
          '- **Ready-to-paste GitHub comment:**',
          '````markdown',
          'Move `$this->asyncManager->await()` outside the loop please 🙏',
          '````',
          '',
          '<!-- SCORECARD_JSON',
          JSON.stringify({
            domains: {
              performance: {
                applicable: true,
                rawScore: 76,
                summary: 'Found unbatched async await inside foreach loop.',
              },
            },
          }),
          '-->',
        ].join('\n');
      }

      return [
        '# Code Review: 2cloud-services#5912 — Optimize tag lookup',
        '',
        '## 1. Task Summary & Functional Problem Solved',
        '- **Business & Functional Problem Solved:** Tag lookup optimization.',
        '',
        '## 2. Review Findings',
        '',
        '### 🟠 Architecture, Security & Major Issues',
        '',
        '#### `#1` — [Return 404 instead of 403 in Voter](projects/services/ma/src/Security/TagVoter.php#L30-L33)',
        '- **Domain:** security',
        '- **Why it matters:** Avoid cross-tenant enumeration.',
        '- **Ready-to-paste GitHub comment:**',
        '````markdown',
        'Return 404 Not Found to prevent cross-tenant enumeration.',
        '````',
        '',
        '### 🟡 Clean Code, Strong Typing & Testing',
        '',
        '#### `#2` — [Use Response::HTTP_OK constant](projects/services/ma/src/Controller/TagController.php#L19-L19)',
        '- **Domain:** quality',
        '- **Why it matters:** Avoid magic HTTP numbers.',
        '- **Ready-to-paste GitHub comment:**',
        '````markdown',
        'Can you use `Response::HTTP_OK` here please 🙏',
        '````',
        '',
        '<!-- SCORECARD_JSON',
        JSON.stringify({
          domains: {
            security: { applicable: true, rawScore: 80, summary: 'Voter returns 403 instead of 404.' },
            product: { applicable: false, rawScore: null, summary: 'Technical chore PR.' },
            quality: { applicable: true, rawScore: 92, summary: 'Minor HTTP constant nit.' },
            performance: { applicable: true, rawScore: 95, summary: 'Initial pass looked clean.' },
            testing: { applicable: true, rawScore: 90, summary: 'Unit tests present.' },
          },
        }),
        '-->',
      ].join('\n');
    });

    try {
      // 1. Initial orchestrated multi-domain pass
      await runPrReviewJob({ cfg, pr, scope: 'shared' });
      const reviewMdPath = path.join(cfg.reviewsDir, 'review-2cloud-services-5912.md');
      const metaPath = path.join(cfg.reviewsDir, 'review-2cloud-services-5912.meta.json');
      assert.equal(fs.existsSync(reviewMdPath), true);
      const initialMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.equal(initialMeta.scorecard.domains.performance.score, 95);
      assert.equal(initialMeta.scorecard.domains.security.score, 80);
      assert.equal(initialMeta.scorecard.domains.product.applicable, false);

      // 2. Granular single-agent Deep Re-run ONLY on `performance`
      await runPrReviewJob({ cfg, pr, scope: 'shared', targetDomain: 'performance' });
      assert.equal(capturedPrompts.length, 2);

      const mergedMd = fs.readFileSync(reviewMdPath, 'utf8');
      const mergedFindings = parseFindingsFromMarkdown(mergedMd, pr.repo);
      const mergedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

      // Security & Quality findings from initial pass MUST still be intact + new Performance finding added!
      assert.equal(mergedFindings.length, 3);
      assert.ok(mergedFindings.some((f) => f.domain === 'security' && f.title.includes('Voter')));
      assert.ok(mergedFindings.some((f) => f.domain === 'quality' && f.title.includes('HTTP_OK')));
      assert.ok(
        mergedFindings.some((f) => f.domain === 'performance' && f.title.includes('Await inside foreach'))
      );

      // Security score stays 80 while Performance updated to 76 (`lastRunMode: 'deep'`)
      assert.equal(mergedMeta.scorecard.domains.security.score, 80);
      assert.equal(mergedMeta.scorecard.domains.performance.score, 76);
      assert.equal(mergedMeta.scorecard.domains.performance.lastRunMode, 'deep');
    } finally {
      setCustomAgentRunnerForTests(null);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('wanreview 4-layer ingestion + 100% resolve.py-compliant surgical export + UI Scorecard without PR Queue clutter', async () => {
    const tmpWanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wanreview-'));
    const tmpExportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wanexport-'));
    const prevCfgEnv = process.env.REVIEW_HUB_CONFIG;
    const tmpCfgPath = path.join(tmpWanDir, 'hub-config.json');
    process.env.REVIEW_HUB_CONFIG = tmpCfgPath;

    try {
      // Build a mock ubitransports/wanreview repository with org locked rule + vertical + team _layer.md
      fs.mkdirSync(path.join(tmpWanDir, 'rules', 'org'), { recursive: true });
      fs.mkdirSync(path.join(tmpWanDir, 'rules', 'verticals', 'wfwp-backend'), { recursive: true });
      fs.mkdirSync(path.join(tmpWanDir, 'rules', 'teams', 'ubi-eng-popcorn'), { recursive: true });

      fs.writeFileSync(
        path.join(tmpWanDir, 'rules', 'org', 'no-secrets.md'),
        [
          '---',
          'id: no-secrets',
          'title: Never commit secrets or credentials',
          'severity: high',
          'status: enforced',
          'locked: true',
          '---',
          '',
          'Never hardcode credentials.',
          '',
          '## Flag',
          '- Committed tokens or passwords.',
          '',
          '## Accept',
          '- Environment variables.',
          '',
        ].join('\n'),
        'utf8'
      );

      // Team tries to disable locked rule `no-secrets` and non-locked rule `noisy-vertical-rule`
      fs.writeFileSync(
        path.join(tmpWanDir, 'rules', 'verticals', 'wfwp-backend', 'noisy-vertical-rule.md'),
        [
          '---',
          'id: noisy-vertical-rule',
          'title: Optional vertical check',
          'severity: low',
          'status: advisory',
          '---',
          '',
          'Optional check.',
          '',
          '## Flag',
          '- Foo.',
          '',
          '## Accept',
          '- Bar.',
          '',
        ].join('\n'),
        'utf8'
      );

      fs.writeFileSync(
        path.join(tmpWanDir, 'rules', 'teams', 'ubi-eng-popcorn', '_layer.md'),
        ['---', 'vertical: wfwp-backend', 'disable:', '  - no-secrets', '  - noisy-vertical-rule', '---', ''].join(
          '\n'
        ),
        'utf8'
      );

      const loaded = loadWanreviewRulesFromRepo(tmpWanDir, 'popcorn-back');
      assert.equal(loaded.available, true);
      assert.equal(loaded.rules.length, 1, 'noisy-vertical-rule is disabled, but locked org rule no-secrets MUST survive');
      assert.equal(loaded.rules[0].wanreviewId, 'no-secrets');
      assert.equal(loaded.rules[0].locked, true);
      assert.equal(loaded.rules[0].domain, 'security');

      // Test surgical export: personal .local.md rules excluded by default, shared rules 100% resolve.py valid
      const sampleRules = [
        {
          id: 'team-1',
          source: 'team',
          title: 'Deprecated getCustomUuid() Ban',
          body: '- Never introduce or use getCustomUuid().\n- Use NeedLegacyConversion attributes or Uuid::buildFromCustomerAndId().',
        },
        {
          id: 'dna-1',
          source: 'dna',
          title: 'Personal friendly tone',
          body: '- Use polite suggestions.',
        },
      ];

      const exportRes = exportRulesToWanreviewDirectory({
        rules: sampleRules,
        targetRootDir: tmpExportDir,
        vertical: 'wfwp-backend',
        team: 'ubi-eng-popcorn',
        statusOverride: 'proposed',
        allowPersonalPromotion: false,
        writeToDisk: true,
      });

      assert.equal(exportRes.files.length, 1);
      assert.equal(exportRes.skippedPersonal.length, 1, 'Personal .local.md rule must be skipped by default');
      const writtenFile = exportRes.files[0];
      assert.equal(
        writtenFile.relativePath,
        'rules/teams/popcorn-back/deprecated-getcustomuuid-ban.md'
      );
      assert.equal(fs.existsSync(writtenFile.absolutePath), true);

      const diskCheck = validateWanreviewRuleMarkdown(
        fs.readFileSync(writtenFile.absolutePath, 'utf8'),
        'deprecated-getcustomuuid-ban'
      );
      assert.equal(diskCheck.valid, true, `Exported markdown must pass resolve.py validation: ${diskCheck.errors.join(', ')}`);

      // Verify HTTP endpoints (/api/agents, /api/wanreview/preview-export, /api/wanreview/propose-pr) and clean PR Queue UI
      const tmpCandFile = path.join(tmpWanDir, 'candidates.json');
      process.env.REVIEW_HUB_CANDIDATES_FILE = tmpCandFile;
      saveCandidateRules([
        {
          id: 'cand-export-1',
          source: 'candidate',
          title: 'Use Readonly DTO Classes',
          body: '- Avoid mutable DTO properties.\n- Declare DTOs as readonly class.',
        },
      ]);
      saveConfig({ wanreviewRepoPath: tmpWanDir }, tmpCfgPath);
      const srv = createHubServer();
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const baseUrl = `http://127.0.0.1:${srv.address().port}`;
      try {
        const [agentsRes, htmlRes, jsRes] = await Promise.all([
          fetch(`${baseUrl}/api/agents`),
          fetch(`${baseUrl}/`),
          fetch(`${baseUrl}/app.js`),
        ]);
        assert.equal(agentsRes.status, 200);
        const agentsJson = await agentsRes.json();
        assert.equal(agentsJson.agents.length, 5);
        assert.equal(agentsJson.wanreview.available, true);

        const previewRes = await fetch(`${baseUrl}/api/wanreview/preview-export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ statusOverride: 'proposed' }),
        });
        assert.equal(previewRes.status, 200);
        const previewJson = await previewRes.json();
        assert.ok(previewJson.files.length > 0, 'Preview export must return converted candidate rules');
        for (const f of previewJson.files) {
          assert.equal(f.valid, true);
        }

        const [html, js] = await Promise.all([htmlRes.text(), jsRes.text()]);
        assert.ok(html.includes('id="prGlobalScoreBadge"'), 'PR topbar must include compact clickable #prGlobalScoreBadge');
        assert.ok(html.includes('id="prScorecardPanel"'), 'Audit Report tab must include #prScorecardPanel');
        const headerEndIdx = html.indexOf('</header>');
        const navTabsIdx = html.indexOf('<nav class="view-tabs">');
        const tabReportIdx = html.indexOf('<section id="tab-report"');
        const scorecardIdx = html.indexOf('id="prScorecardPanel"');
        assert.ok(
          scorecardIdx > tabReportIdx && !(scorecardIdx > headerEndIdx && scorecardIdx < navTabsIdx),
          '#prScorecardPanel must live inside #tab-report rather than as a persistent top banner above tabs'
        );
        assert.ok(html.includes('id="syncWanreviewBtn"'), 'Rules tab must include Sync wanreview button');
        assert.ok(js.includes('function renderPrScorecardPanel()'), 'app.js must define renderPrScorecardPanel');
        assert.ok(js.includes('function focusAuditScorecardDetail()'), 'app.js must define focusAuditScorecardDetail on global score click');
        assert.ok(js.includes('function autoResizeFindingTextarea('), 'app.js must auto-expand AI proposal textareas without inner scrolling');
        const cssRes = await fetch(`${baseUrl}/styles.css`);
        const css = await cssRes.text();
        assert.ok(css.includes('field-sizing: content'), 'finding-textarea must auto-fit full suggestion height');
        assert.ok(!css.includes('.findings-list {\n  max-width: 920px;'), 'findings-list must not be constrained to narrow 920px');
        assert.ok(css.includes('.diff-inline-finding-body') && css.includes('font-size: var(--diff-font-size, 12px);'), 'Inline PR comments must match code font size');
        assert.ok(js.includes('gh-thread-toggle-reply-btn'), 'Inline PR GitHub threads must collapse Reply input behind a compact toggle button');
        // Ensure PR Queue card rendering was NOT cluttered with score badges
        const prListSlice = js.slice(js.indexOf('function renderPrList()'), js.indexOf('function renderPrList()') + 3500);
        assert.equal(
          prListSlice.includes('scorecard-score-pill'),
          false,
          'PR Queue cards must remain clean without score badges'
        );
      } finally {
        delete process.env.REVIEW_HUB_CANDIDATES_FILE;
        await new Promise((r) => srv.close(r));
      }
    } finally {
      if (prevCfgEnv !== undefined) {
        process.env.REVIEW_HUB_CONFIG = prevCfgEnv;
      } else {
        delete process.env.REVIEW_HUB_CONFIG;
      }
      fs.rmSync(tmpWanDir, { recursive: true, force: true });
      fs.rmSync(tmpExportDir, { recursive: true, force: true });
    }
  });

  test('Colleague Onboarding Simulation (Pili Squad): auto-detects pili-back, defaults to Standalone Reader Mode, exposes Doctor Jira/Mode checks, and blocks public GitHub sharedStore pushes', async () => {
    const tmpSimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sim-pili-'));
    const prevCfgEnv = process.env.REVIEW_HUB_CONFIG;
    const prevTeamsEnv = process.env.REVIEW_HUB_TEAMS;
    const prevRoleEnv = process.env.REVIEW_HUB_ROLE;
    const prevReviewsEnv = process.env.REVIEWS_DIR;

    const simCfgPath = path.join(tmpSimDir, 'config.json');
    const simReviewsDir = path.join(tmpSimDir, 'reviews');
    process.env.REVIEW_HUB_CONFIG = simCfgPath;
    process.env.REVIEW_HUB_TEAMS = 'pili-back,ubi-eng-team-pili';
    process.env.REVIEW_HUB_ROLE = 'reader';
    process.env.REVIEWS_DIR = simReviewsDir;

    try {
      // 1. Fresh colleague bootstrap must select `pili-back`, Reader Mode, 0 background auto-review, and trigger Welcome Wizard
      const bootstrapped = ensureConfigBootstrapped(simCfgPath);
      assert.equal(bootstrapped.teamProfile, 'pili-back');
      assert.deepEqual(bootstrapped.githubTeams, ['pili-back', 'ubi-eng-team-pili']);
      assert.equal(bootstrapped.hubRole, 'reader');
      assert.equal(bootstrapped.autoReviewEnabled, false);
      assert.equal(bootstrapped.onboardingCompleted, false);

      // 2. Spin up server and verify Welcome endpoints + Doctor checks (`acli` + `executionMode`)
      const srv = createHubServer();
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const [stateRes, teamsRes, doctorRes, profilesRes] = await Promise.all([
          fetch(`${baseUrl}/api/state`),
          fetch(`${baseUrl}/api/github/teams?org=ubitransports`),
          fetch(`${baseUrl}/api/doctor`),
          fetch(`${baseUrl}/api/teams/profiles`),
        ]);
        const stateJson = await stateRes.json();
        const teamsJson = await teamsRes.json();
        const doctorJson = await doctorRes.json();
        const profilesJson = await profilesRes.json();

        assert.equal(stateJson.config.teamProfile, 'pili-back');
        assert.equal(stateJson.config.hubRole, 'reader');
        assert.equal(stateJson.config.onboardingCompleted, false);
        assert.deepEqual(
          teamsJson.teams.map((t) => t.slug),
          ['pili-back', 'ubi-eng-team-pili']
        );
        assert.ok(
          (profilesJson.profiles || []).some((p) => p.id === 'pili-back'),
          'Team profiles catalog must expose dedicated pili-back squad profile'
        );
        assert.ok(
          (doctorJson.checks || []).some((c) => c.id === 'acli' && c.ok === true),
          'Doctor must expose non-blocking Jira CLI check'
        );
        assert.ok(
          (doctorJson.checks || []).some(
            (c) => c.id === 'executionMode' && c.detail.includes('Standalone Mode')
          ),
          'Doctor must confirm Teammate Standalone Mode'
        );
      } finally {
        await new Promise((r) => srv.close(r));
      }

      // 3. Public GitHub leak guard must reject pushing internal review artifacts to a public repo
      await assert.rejects(
        () =>
          assertSharedStoreNotPublicGithub('fawr-ubi/pr-review-hub', async () => false),
        /Security block: refusing to push internal PR review artifacts to PUBLIC GitHub repository/
      );
      const privRes = await assertSharedStoreNotPublicGithub(
        'ubitransports/private-review-store',
        async () => true
      );
      assert.equal(privRes.ok, true);
    } finally {
      if (prevCfgEnv !== undefined) process.env.REVIEW_HUB_CONFIG = prevCfgEnv;
      else delete process.env.REVIEW_HUB_CONFIG;
      if (prevTeamsEnv !== undefined) process.env.REVIEW_HUB_TEAMS = prevTeamsEnv;
      else delete process.env.REVIEW_HUB_TEAMS;
      if (prevRoleEnv !== undefined) process.env.REVIEW_HUB_ROLE = prevRoleEnv;
      else delete process.env.REVIEW_HUB_ROLE;
      if (prevReviewsEnv !== undefined) process.env.REVIEWS_DIR = prevReviewsEnv;
      else delete process.env.REVIEWS_DIR;
      fs.rmSync(tmpSimDir, { recursive: true, force: true });
    }
  });

  test('Centralized wanreview E2E (A1-A5): resolve.py 4-layer parity, CODEOWNERS team override, UI rule badges with zero comment pollution, isolated worktree PR creation, and safe fast-forward sync', async () => {
    const tmpE2eRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wanreview-e2e-'));
    const bareOriginDir = path.join(tmpE2eRoot, 'wanreview-origin.git');
    const seedCloneDir = path.join(tmpE2eRoot, 'wanreview-seed');
    const localWanCloneDir = path.join(tmpE2eRoot, 'wanreview-local');
    const targetServiceRepoDir = path.join(tmpE2eRoot, 'target-repo');
    const tmpReviewsDir = path.join(tmpE2eRoot, 'reviews');
    const tmpCfgPath = path.join(tmpE2eRoot, 'config.json');

    const prevCfgEnv = process.env.REVIEW_HUB_CONFIG;
    const prevReviewsEnv = process.env.REVIEWS_DIR;
    process.env.REVIEW_HUB_CONFIG = tmpCfgPath;
    process.env.REVIEWS_DIR = tmpReviewsDir;

    try {
      fs.mkdirSync(tmpReviewsDir, { recursive: true });
      fs.mkdirSync(path.join(targetServiceRepoDir, '.agent-review'), { recursive: true });

      // 1. Create a real bare git origin + local clone mimicking ubitransports/wanreview (master branch, dot-namespaced IDs, omitted status -> enforced)
      execFileSync('git', ['init', '--bare', bareOriginDir]);
      execFileSync('git', ['clone', bareOriginDir, seedCloneDir]);
      execFileSync('git', ['-C', seedCloneDir, 'checkout', '-b', 'master']);
      execFileSync('git', ['-C', seedCloneDir, 'config', 'user.email', 'test@matawan.io']);
      execFileSync('git', ['-C', seedCloneDir, 'config', 'user.name', 'Wanreview Test']);

      fs.mkdirSync(path.join(seedCloneDir, 'rules', 'org'), { recursive: true });
      fs.mkdirSync(path.join(seedCloneDir, 'rules', 'verticals', 'wfwp-backend'), { recursive: true });
      fs.mkdirSync(path.join(seedCloneDir, 'rules', 'teams', 'popcorn-back'), { recursive: true });
      fs.mkdirSync(path.join(seedCloneDir, 'rules', 'teams', 'pili-back'), { recursive: true });

      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'org', 'no-secrets.md'),
        '---\nid: org.no-secrets\ntitle: Never commit secrets or credentials\nseverity: high\nlocked: true\n---\n\nNever hardcode secrets.\n\n## Flag\n- API keys in source.\n\n## Accept\n- Env vars.\n',
        'utf8'
      );
      // Notice omitted `status:` and dot-namespaced `id: wfwp-backend.tenant-isolation` inside `tenant-isolation.md` (real wanreview convention)
      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'verticals', 'wfwp-backend', 'tenant-isolation.md'),
        '---\nid: wfwp-backend.tenant-isolation\ntitle: Enforce multi-tenant isolation on queries\nseverity: medium\n---\n\nScope all queries by tenant.\n\n## Flag\n- Unscoped findAll().\n\n## Accept\n- Tenant filter enabled.\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'verticals', 'wfwp-backend', 'legacy-array-shape.md'),
        '---\nid: wfwp-backend.legacy-array-shape\ntitle: Avoid untyped associative arrays\nseverity: low\nstatus: advisory\n---\n\nPrefer DTOs.\n\n## Flag\n- Raw array return.\n\n## Accept\n- Readonly DTO.\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'teams', 'popcorn-back', '_layer.md'),
        '---\nvertical: wfwp-backend\n---\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'teams', 'popcorn-back', 'popcorn-rule.md'),
        '---\nid: popcorn-back.popcorn-rule\ntitle: Popcorn specific check\nseverity: low\n---\n\nPopcorn check.\n\n## Flag\n- Popcorn anti-pattern.\n\n## Accept\n- Popcorn idiom.\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'teams', 'pili-back', '_layer.md'),
        '---\nvertical: wfwp-backend\n---\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'teams', 'pili-back', 'pili-rule.md'),
        '---\nid: pili-back.pili-rule\ntitle: Pili specific check\nseverity: medium\n---\n\nPili check.\n\n## Flag\n- Pili anti-pattern.\n\n## Accept\n- Pili idiom.\n',
        'utf8'
      );

      execFileSync('git', ['-C', seedCloneDir, 'add', '.']);
      execFileSync('git', ['-C', seedCloneDir, 'commit', '-m', 'chore: initial wanreview rules']);
      execFileSync('git', ['-C', seedCloneDir, 'push', '-u', 'origin', 'master']);
      execFileSync('git', ['--git-dir', bareOriginDir, 'symbolic-ref', 'HEAD', 'refs/heads/master']);

      execFileSync('git', ['clone', bareOriginDir, localWanCloneDir]);
      execFileSync('git', ['-C', localWanCloneDir, 'config', 'user.email', 'antoine@matawan.io']);
      execFileSync('git', ['-C', localWanCloneDir, 'config', 'user.name', 'Antoine Test']);

      // 2. Test A3: CODEOWNERS dynamic team override (`pili-back` overrides `popcorn-back`) + 4th layer `.agent-review/_layer.md` overrides/disable
      fs.writeFileSync(
        path.join(targetServiceRepoDir, '.agent-review', '_layer.md'),
        [
          '---',
          'overrides:',
          '  wfwp-backend.tenant-isolation:',
          '    severity: high',
          '  org.no-secrets:',
          '    severity: low',
          'disable:',
          '  - wfwp-backend.legacy-array-shape',
          '  - org.no-secrets',
          '---',
          '',
        ].join('\n'),
        'utf8'
      );

      const codeownersContent = [
        '# Service CODEOWNERS',
        '* @ubitransports/ubi-eng-pili',
      ].join('\n');

      assert.equal(
        parseTeamFromCodeownersContent(codeownersContent, new Set(['popcorn-back', 'pili-back'])),
        'pili-back'
      );

      const resolvedForPiliRepo = loadWanreviewRulesFromRepo(localWanCloneDir, 'popcorn-back', {
        codeownersContent,
        repoAgentReviewDir: path.join(targetServiceRepoDir, '.agent-review'),
      });
      assert.equal(resolvedForPiliRepo.available, true);
      assert.equal(resolvedForPiliRepo.team, 'pili-back', 'CODEOWNERS must dynamically override fallback teamProfile');
      assert.equal(resolvedForPiliRepo.resolutionSource, 'codeowners');
      assert.equal(resolvedForPiliRepo.vertical, 'wfwp-backend');

      const activeIds = resolvedForPiliRepo.rules.map((r) => r.wanreviewId);
      assert.ok(activeIds.includes('org.no-secrets'), 'Locked org rule must survive disable');
      assert.ok(activeIds.includes('wfwp-backend.tenant-isolation'));
      assert.ok(activeIds.includes('pili-back.pili-rule'), 'Pili rule must be loaded via CODEOWNERS');
      assert.ok(!activeIds.includes('popcorn-back.popcorn-rule'), 'Popcorn rule must NOT load on Pili-owned PR');
      assert.ok(!activeIds.includes('wfwp-backend.legacy-array-shape'), 'Disabled vertical rule must be excluded');

      const tenantRule = resolvedForPiliRepo.rules.find((r) => r.wanreviewId === 'wfwp-backend.tenant-isolation');
      assert.equal(tenantRule.status, 'enforced', 'Omitted status in frontmatter must default to enforced');
      assert.equal(tenantRule.severity, 'high', '4th layer .agent-review/_layer.md override must upgrade severity to high');
      assert.equal(
        tenantRule.url,
        'https://github.com/ubitransports/wanreview/blob/master/rules/verticals/wfwp-backend/tenant-isolation.md'
      );

      const lockedOrgRule = resolvedForPiliRepo.rules.find((r) => r.wanreviewId === 'org.no-secrets');
      assert.equal(lockedOrgRule.severity, 'high', 'Locked rule severity must NOT be downgraded to low by overrides');

      // 3. Test A5: UI Rule Citations (matchedRules with GitHub URLs) while keeping finding.comment & customComment 100% clean human English
      const reviewFilename = 'review-2cloud-services-5999.md';
      const reviewMd = [
        '# Code Review: `2cloud-services#5999` — Tenant Query Check',
        '',
        '## 1. Task Summary & Functional Problem Solved',
        '- **Verdict:** 🟠 Request Changes',
        '',
        '## 3. Detailed Findings',
        '',
        '### 🔴 Blockers & Bugs',
        '',
        '#### #1 Missing tenant filter in `ContractRepository::findActive()`',
        '- **Domain:** `security`',
        '- **Rule:** `wfwp-backend.tenant-isolation`, `org.no-secrets`',
        '- **File:** `src/Repository/ContractRepository.php:42-48`',
        '- **Why it matters:** Queries across tenants leak customer contracts.',
        '',
        '**Ready-to-paste GitHub comment:**',
        '````markdown',
        '`findActive()` queries `Contract` without filtering by the current tenant, which can expose contracts across customer tenants. Could we scope the query builder with `->andWhere(\'c.customer = :customer\')`?',
        '',
        '**Triggered Rules:** [wfwp-backend.tenant-isolation](https://github.com/ubitransports/wanreview/blob/master/rules/verticals/wfwp-backend/tenant-isolation.md)',
        '🤖 Wanreview automated check',
        '````',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpReviewsDir, reviewFilename), reviewMd, 'utf8');

      saveConfig(
        {
          githubOrg: 'ubitransports',
          githubUser: 'antoine-test',
          teamProfile: 'popcorn-back',
          wanreviewRepoPath: localWanCloneDir,
          reviewsDir: tmpReviewsDir,
        },
        tmpCfgPath
      );

      const srv = createHubServer();
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const baseUrl = `http://127.0.0.1:${srv.address().port}`;
      try {
        const revRes = await fetch(`${baseUrl}/api/review?file=${encodeURIComponent(reviewFilename)}&prKey=2cloud-services%235999`);
        assert.equal(revRes.status, 200);
        const revData = await revRes.json();
        assert.equal(revData.findings.length, 1);
        const f1 = revData.findings[0];
        assert.deepEqual(f1.ruleIds, ['wfwp-backend.tenant-isolation', 'org.no-secrets']);
        assert.equal(f1.matchedRules.length, 2);
        assert.equal(
          f1.matchedRules[0].url,
          'https://github.com/ubitransports/wanreview/blob/master/rules/verticals/wfwp-backend/tenant-isolation.md'
        );
        assert.ok(!f1.comment.includes('Triggered Rules'), 'Ready-to-paste GitHub comment must NOT contain Triggered Rules footer');
        assert.ok(!f1.comment.includes('Wanreview'), 'Ready-to-paste GitHub comment must NOT contain Wanreview bot branding');
        assert.ok(!f1.customComment.includes('Triggered Rules'));

        // 4. Test A4 (dryRun via HTTP + live isolated git worktree PR creation against bare origin)
        const dryRunRes = await fetch(`${baseUrl}/api/wanreview/propose-pr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dryRun: true,
            layer: 'vertical',
            vertical: 'wfwp-backend',
            severity: 'medium',
            title: 'Avoid Deprecated getCustomUuid()',
            body: '- Never call getCustomUuid() on entities.\n- Use NeedLegacyConversion or Uuid::buildFromCustomerAndId().',
          }),
        });
        assert.equal(dryRunRes.status, 200);
        const dryRunJson = await dryRunRes.json();
        assert.equal(dryRunJson.dryRun, true);
        assert.equal(dryRunJson.ruleId, 'wfwp-backend.avoid-deprecated-getcustomuuid');
        assert.equal(
          dryRunJson.relativePath,
          'rules/verticals/wfwp-backend/avoid-deprecated-getcustomuuid.md'
        );
        const previewValidation = validateWanreviewRuleMarkdown(
          dryRunJson.markdown,
          'avoid-deprecated-getcustomuuid'
        );
        assert.equal(previewValidation.valid, true);
        assert.equal(previewValidation.meta.status, 'proposed');
      } finally {
        await new Promise((r) => srv.close(r));
      }

      // Live isolated worktree test: add an untracked local file in localWanCloneDir to prove worktree isolation
      fs.writeFileSync(path.join(localWanCloneDir, 'WIP-LOCAL-NOTE.txt'), 'keep untouched', 'utf8');
      let capturedGhArgs = null;
      const prResult = await proposeRulePrToWanreview({
        rule: {
          title: 'Avoid Deprecated getCustomUuid()',
          body: '- Never call getCustomUuid() on entities.\n- Use NeedLegacyConversion or Uuid::buildFromCustomerAndId().',
        },
        layer: 'vertical',
        vertical: 'wfwp-backend',
        severity: 'medium',
        status: 'proposed',
        wanreviewRepoPath: localWanCloneDir,
        sourcePrKey: '2cloud-services#5999',
        execFn: async (cmd, args, opts) => {
          if (cmd === 'gh') {
            capturedGhArgs = args;
            return { stdout: 'https://github.com/ubitransports/wanreview/pull/42\n', stderr: '' };
          }
          return execFileAsyncTest(cmd, args, opts);
        },
      });

      assert.equal(prResult.ok, true);
      assert.equal(prResult.prUrl, 'https://github.com/ubitransports/wanreview/pull/42');
      assert.ok(Array.isArray(capturedGhArgs) && capturedGhArgs[0] === 'pr' && capturedGhArgs[1] === 'create');
      // Verify main checkout is STILL on master and untouched, while remote bare origin received the pushed feature branch!
      const currentMainBranch = execFileSync('git', ['-C', localWanCloneDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(currentMainBranch, 'master');
      assert.equal(
        fs.existsSync(path.join(localWanCloneDir, 'rules', 'verticals', 'wfwp-backend', 'avoid-deprecated-getcustomuuid.md')),
        false,
        'Main wanreview checkout must stay clean while PR branch was pushed from isolated worktree'
      );
      const pushedFileInOrigin = execFileSync(
        'git',
        ['--git-dir', bareOriginDir, 'show', `${prResult.branchName}:rules/verticals/wfwp-backend/avoid-deprecated-getcustomuuid.md`],
        { encoding: 'utf8' }
      );
      assert.ok(pushedFileInOrigin.includes('id: wfwp-backend.avoid-deprecated-getcustomuuid'));
      assert.ok(pushedFileInOrigin.includes('status: proposed'));
      fs.unlinkSync(path.join(localWanCloneDir, 'WIP-LOCAL-NOTE.txt'));

      // 5. Test A1: Safe fast-forward sync (`ensureWanreviewRepoSynced`)
      fs.writeFileSync(
        path.join(seedCloneDir, 'rules', 'org', 'no-eval.md'),
        '---\nid: org.no-eval\ntitle: Never use dynamic eval()\nseverity: high\n---\n\nBan eval.\n\n## Flag\n- eval().\n\n## Accept\n- Safe parser.\n',
        'utf8'
      );
      execFileSync('git', ['-C', seedCloneDir, 'add', '.']);
      execFileSync('git', ['-C', seedCloneDir, 'commit', '-m', 'feat(org): add org.no-eval rule']);
      execFileSync('git', ['-C', seedCloneDir, 'push', 'origin', 'master']);

      // Dirty tracked file -> must skip pull safely (`skipped-dirty`)
      fs.appendFileSync(path.join(localWanCloneDir, 'rules', 'org', 'no-secrets.md'), '\n', 'utf8');
      const dirtySync = await ensureWanreviewRepoSynced(
        { wanreviewRepoPath: localWanCloneDir, projectsDir: tmpE2eRoot },
        { pull: true, allowAutoClone: false }
      );
      assert.equal(dirtySync.action, 'skipped-dirty');
      assert.equal(fs.existsSync(path.join(localWanCloneDir, 'rules', 'org', 'no-eval.md')), false);

      // Clean working tree on master -> fast-forwards cleanly!
      execFileSync('git', ['-C', localWanCloneDir, 'checkout', '--', 'rules/org/no-secrets.md']);
      const cleanSync = await ensureWanreviewRepoSynced(
        { wanreviewRepoPath: localWanCloneDir, projectsDir: tmpE2eRoot },
        { pull: true, allowAutoClone: false }
      );
      assert.equal(cleanSync.action, 'pulled');
      assert.equal(fs.existsSync(path.join(localWanCloneDir, 'rules', 'org', 'no-eval.md')), true);
    } finally {
      if (prevCfgEnv !== undefined) process.env.REVIEW_HUB_CONFIG = prevCfgEnv;
      else delete process.env.REVIEW_HUB_CONFIG;
      if (prevReviewsEnv !== undefined) process.env.REVIEWS_DIR = prevReviewsEnv;
      else delete process.env.REVIEWS_DIR;
      fs.rmSync(tmpE2eRoot, { recursive: true, force: true });
    }
  });

  test('Monorepo path-aware CODEOWNERS routing (2cloud-services) + Duplicate Rule ID/File Collision Guard + Word-Boundary Slugifier', async () => {
    const tmpMonoWan = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wan-monorepo-'));
    try {
      fs.mkdirSync(path.join(tmpMonoWan, 'rules', 'org'), { recursive: true });
      fs.mkdirSync(path.join(tmpMonoWan, 'rules', 'verticals', 'wfwp-backend'), { recursive: true });
      for (const sq of ['popcorn-back', 'pili-back', 'banana-back', 'papaya-back']) {
        fs.mkdirSync(path.join(tmpMonoWan, 'rules', 'teams', sq), { recursive: true });
        fs.writeFileSync(
          path.join(tmpMonoWan, 'rules', 'teams', sq, '_layer.md'),
          '---\nvertical: wfwp-backend\n---\n',
          'utf8'
        );
      }
      fs.writeFileSync(
        path.join(tmpMonoWan, 'rules', 'org', 'no-secrets.md'),
        '---\nid: org.no-secrets\ntitle: No Secrets\nseverity: high\nlocked: true\n---\n\nNo secrets.\n\n## Flag\n- Secrets.\n\n## Accept\n- Env.\n',
        'utf8'
      );

      // Realistic 2cloud-services monorepo CODEOWNERS (no `*` catch-all, Billing/pili-back on line 1!)
      const monorepoCodeowners = [
        '/projects/services/wfwp-platform/src/Billing/ @ubitransports/pili-back',
        '/projects/services/consumption/ @ubitransports/papaya-back',
        '/projects/services/mobility-account/ @ubitransports/popcorn-back',
        '/projects/services/passenger-information-network/ @ubitransports/banana-back',
      ].join('\n');

      // 1. PR touching PIN -> banana-back (NOT line 1 pili-back!)
      const resPin = loadWanreviewRulesFromRepo(tmpMonoWan, 'popcorn-back', {
        codeownersContent: monorepoCodeowners,
        changedFiles: ['projects/services/passenger-information-network/src/Entity/Stop.php'],
      });
      assert.equal(resPin.team, 'banana-back');
      assert.equal(resPin.resolutionSource, 'codeowners');

      // 2. PR touching Mobility Account -> popcorn-back via codeowners
      const resMa = loadWanreviewRulesFromRepo(tmpMonoWan, 'pili-back', {
        codeownersContent: monorepoCodeowners,
        changedFiles: ['projects/services/mobility-account/src/Dto/InputDto.php'],
      });
      assert.equal(resMa.team, 'popcorn-back');
      assert.equal(resMa.resolutionSource, 'codeowners');

      // 3. PR touching unowned `projects/common/` -> falls back to active `teamProfile` (`popcorn-back`) instead of line 1 (`pili-back`)!
      const resCommon = loadWanreviewRulesFromRepo(tmpMonoWan, 'popcorn-back', {
        codeownersContent: monorepoCodeowners,
        changedFiles: ['projects/common/src/Identifier/Uuid.php'],
      });
      assert.equal(resCommon.team, 'popcorn-back');
      assert.equal(resCommon.resolutionSource, 'teamProfile');

      // 4. Duplicate Rule ID / File Collision Guard in `proposeRulePrToWanreview`
      await assert.rejects(
        () =>
          proposeRulePrToWanreview({
            dryRun: true,
            layer: 'org',
            severity: 'high',
            rule: { title: 'No Secrets', body: '- Never commit secrets.' },
            wanreviewRepoPath: tmpMonoWan,
          }),
        /already exists in ubitransports\/wanreview/
      );

      // 5. Long rule titles truncate cleanly on hyphen word boundaries (never chopping mid-word)
      const longRule = convertHubRuleToWanreview(
        {
          title:
            'Doctrine Events: Never Call EntityManager flush() Inside AsDoctrineListener postUpdate Subscribers When Computing Changesets',
          body: '- Never call flush() inside postUpdate.',
        },
        { layer: 'vertical', vertical: 'wfwp-backend', statusOverride: 'proposed' }
      );
      assert.equal(longRule.valid, true);
      assert.ok(longRule.stem.length <= 76);
      assert.ok(!longRule.stem.endsWith('-sub') && !longRule.stem.endsWith('-po'));
    } finally {
      fs.rmSync(tmpMonoWan, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// 10. Review & Comment Posting Hardening, Manual GitHub Post Exclusion,
//     Review Asked Filtering & GitHub-Style Intra-Line Diff
// =============================================================================
describe('Review & Comment Posting Hardening, Review Asked Filter & Intra-Line Diff', () => {
  test('computeIntraLineDiffRanges highlights exact single-line changes (identifier sub-token, port/number, multi-token) and skips unrelated rewrites', () => {
    // 1. Sub-token PHP getter rename: $billing->getZipCode() -> $billing->getPostalCode()
    const oldPhp = '    $zip = $billingInformation->getZipCode();';
    const newPhp = '    $zip = $billingInformation->getPostalCode();';
    const resPhp = computeIntraLineDiffRanges(oldPhp, newPhp);
    assert.equal(resPhp.highlight, true);
    assert.equal(resPhp.delRanges.length, 1);
    assert.equal(resPhp.addRanges.length, 1);
    assert.equal(oldPhp.slice(resPhp.delRanges[0][0], resPhp.delRanges[0][1]), 'Zip');
    assert.equal(newPhp.slice(resPhp.addRanges[0][0], resPhp.addRanges[0][1]), 'Postal');

    // 2. Single-digit YAML port change: "8080:80" -> "8081:80"
    const oldYaml = '      - "8080:80"';
    const newYaml = '      - "8081:80"';
    const resYaml = computeIntraLineDiffRanges(oldYaml, newYaml);
    assert.equal(resYaml.highlight, true);
    assert.equal(oldYaml.slice(resYaml.delRanges[0][0], resYaml.delRanges[0][1]), '0');
    assert.equal(newYaml.slice(resYaml.addRanges[0][0], resYaml.addRanges[0][1]), '1');

    // 3. Multi-token expression change on a single line
    const oldCond = 'if (!empty($value)) {';
    const newCond = "if ($value !== null && $value !== '') {";
    const resCond = computeIntraLineDiffRanges(oldCond, newCond);
    assert.equal(resCond.highlight, true);
    assert.ok(resCond.delRanges.length >= 1);
    assert.ok(resCond.addRanges.length >= 1);

    // 4. Completely unrelated lines should NOT highlight intra-line noise
    const unrelated = computeIntraLineDiffRanges(
      'return null;',
      '$this->logger->critical("Database connection pool exhausted");'
    );
    assert.equal(unrelated.highlight, false);
  });

  test('Nested 3-backtick suggestion fences, LEFT-side deleted line resolution, and oversized suggestion range safety', () => {
    // 1. 3-backtick outer fence containing an inner ```suggestion fence + trailing note
    const mdWith3TickNested = `
## 2. Review Findings

### 🟡 Clean Code

#### \`#1\` — [Align Step 3 fallback](file:///skills/ci-review/SKILL.md#L18-L63)
- **Domain:** quality
- **Ready-to-paste GitHub comment:**
\`\`\`markdown
Nit: Removing the \`gh pr comment\` fallback keeps the instructions consistent.

\`\`\`suggestion
When reviewing a GitHub Pull Request, publish a single COMMENT PR review:
\`\`\`

Let me know if you prefer keeping a dry-run note!
\`\`\`
`;
    const parsed = parseFindingsFromMarkdown(mdWith3TickNested);
    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].comment.includes('```suggestion'));
    assert.ok(
      parsed[0].comment.includes('Let me know if you prefer keeping a dry-run note!'),
      'Outer 3-backtick fence must not close early on inner ```suggestion fence'
    );

    // 2. Oversized suggestion range (L18-L63 = 46 lines for a 1-line suggestion) drops start_line so GitHub will not delete 45 lines
    const sugAnalysis = analyzeSuggestionBlockRange(parsed[0].comment, 18, 63);
    assert.equal(sugAnalysis.hasSuggestion, true);
    assert.equal(sugAnalysis.suggestionLines, 1);
    assert.equal(sugAnalysis.oversizedRange, true);

    const sampleDiff = [
      {
        filename: 'skills/ci-review/SKILL.md',
        patch: [
          '@@ -15,55 +15,55 @@',
          ...Array.from({ length: 55 }, (_, i) => (i === 48 ? '+Updated line 63' : ` line ${15 + i}`)),
        ].join('\n'),
      },
      {
        filename: 'projects/services/mobility-account/docker-compose.yml',
        patch: [
          '@@ -35,6 +35,4 @@',
          '   environment:',
          '     APP_ENV: dev',
          '-    LEGACY_FLAG: "1"',
          '-    DEPRECATED_PORT: "9009"',
          '     DATABASE_URL: postgres://db',
          '     REDIS_URL: redis://cache',
        ].join('\n'),
      },
    ];

    const resolvedSug = resolveFindingAgainstDiff(
      {
        filePath: 'skills/ci-review/SKILL.md',
        startLine: 18,
        endLine: 63,
        customComment: parsed[0].comment,
      },
      sampleDiff
    );
    assert.equal(resolvedSug.inDiff, true);
    assert.equal(resolvedSug.resolvedLine, 63);
    assert.equal(
      resolvedSug.resolvedStartLine,
      null,
      'Oversized multi-line range on a 1-line suggestion must clamp to single-line endLine'
    );

    // 3. Deleted lines (LEFT side) resolve accurately on docker-compose.yml lines 37-38
    const leftSet = parsePatchLeftLines(sampleDiff[1].patch);
    assert.ok(leftSet.has(37) && leftSet.has(38));

    const resolvedDeleted = resolveFindingAgainstDiff(
      {
        filePath: 'projects/services/mobility-account/docker-compose.yml',
        startLine: 37,
        endLine: 38,
        side: 'LEFT',
        comment: "Can't it be deleted ?",
      },
      sampleDiff
    );
    assert.equal(resolvedDeleted.inDiff, true);
    assert.equal(resolvedDeleted.resolvedSide, 'LEFT');
    assert.equal(resolvedDeleted.resolvedStartLine, 37);
    assert.equal(resolvedDeleted.resolvedLine, 38);
  });

  test('E2E HTTP: excludes manually posted comments (Hub + GitHub Overview) from batch review, supports Overview general comments, LEFT side, self-PR guard, re-review fingerprint & Review Asked filter', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-posting-e2e-'));
    const prevCfgEnv = process.env.REVIEW_HUB_CONFIG;
    const publishedCalls = [];

    try {
      const cfgPath = path.join(tmpDir, 'config.json');
      const reviewsDir = path.join(tmpDir, 'reviews');
      const cacheDir = path.join(reviewsDir, '.cache');
      const projectsDir = path.join(tmpDir, 'projects');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.mkdirSync(projectsDir, { recursive: true });

      process.env.REVIEW_HUB_CONFIG = cfgPath;
      saveConfig({
        githubUser: 'fawr-ubi',
        githubOrg: 'ubitransports',
        teamProfile: 'popcorn-back',
        githubTeams: ['ubi-eng-team-popcorn', 'popcorn-back'],
        reviewsDir,
        projectsDir,
        hubRole: 'reader',
        autoReviewEnabled: false,
      });

      // Seed PR queue state to test Review Asked (direct vs team vs already-reviewed vs self vs draft)
      const headSha = 'abcdef1234567890abcdef1234567890abcdef12';
      fs.writeFileSync(
        path.join(reviewsDir, '.state.json'),
        JSON.stringify(
          {
            prs: {
              '2cloud-services#5701': {
                repo: '2cloud-services',
                number: 5701,
                title: 'PRD-18382 feat: Moneris billing details',
                state: 'OPEN',
                isDraft: false,
                author: 'sontungpham',
                headRefOid: headSha,
                reviewFile: 'review-2cloud-services-5701.md',
                pendingReviewers: [{ login: 'fawr-ubi', name: 'Antoine', isTeam: false }],
                latestReviews: [],
              },
              '2cloud-services#5742': {
                repo: '2cloud-services',
                number: 5742,
                title: 'PRD-18400 feat: Mobility account endpoint',
                state: 'OPEN',
                isDraft: false,
                author: 'augarnier',
                headRefOid: '111111111111',
                pendingReviewers: [{ login: 'popcorn-back', name: 'popcorn-back', isTeam: true }],
                latestReviews: [],
              },
              '2cloud-services#5500': {
                repo: '2cloud-services',
                number: 5500,
                title: 'Already approved team PR',
                state: 'OPEN',
                isDraft: false,
                author: 'augarnier',
                headRefOid: '222222222222',
                pendingReviewers: [{ login: 'popcorn-back', name: 'popcorn-back', isTeam: true }],
                latestReviews: [{ login: 'fawr-ubi', name: 'Antoine', state: 'APPROVED' }],
              },
              '2cloud-services#5800': {
                repo: '2cloud-services',
                number: 5800,
                title: 'My own PR',
                state: 'OPEN',
                isDraft: false,
                author: 'fawr-ubi',
                headRefOid: headSha,
                pendingReviewers: [{ login: 'popcorn-back', name: 'popcorn-back', isTeam: true }],
                latestReviews: [],
              },
              '2cloud-services#5900': {
                repo: '2cloud-services',
                number: 5900,
                title: 'Draft PR',
                state: 'OPEN',
                isDraft: true,
                author: 'sontungpham',
                headRefOid: '333333333333',
                pendingReviewers: [{ login: 'fawr-ubi', name: 'Antoine', isTeam: false }],
                latestReviews: [],
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      // Seed cached diff for 2cloud-services#5701 and #5800
      const diffPayload = [
        {
          filename: 'src/Billing/MonerisPaymentGateway.php',
          patch: [
            '@@ -250,8 +250,9 @@',
            '     public function preloadOrder(): array',
            '     {',
            '-        $legacy = true;',
            '+        if (!empty($zipCode)) {',
            '+            $payload["postal_code"] = $zipCode;',
            '+        }',
            '         return $payload;',
            '     }',
          ].join('\n'),
        },
        {
          filename: 'src/Listener/LittlepayMerchantCreationListener.php',
          patch: [
            '@@ -10,4 +10,4 @@',
            '-#[AsEntityListener(event: Events::postPersist, entity: Merchant::class)]',
            '+#[AsDoctrineListener(event: Events::postPersist)]',
            ' final class LittlepayMerchantCreationListener',
          ].join('\n'),
        },
      ];
      const safeSha = headSha.slice(0, 12);
      fs.writeFileSync(
        path.join(cacheDir, `diff-2cloud-services-5701-${safeSha}.json`),
        JSON.stringify(diffPayload),
        'utf8'
      );
      fs.writeFileSync(
        path.join(cacheDir, `diff-2cloud-services-5800-${safeSha}.json`),
        JSON.stringify(diffPayload),
        'utf8'
      );

      // Seed review markdown with 3 findings (#1, #2, #3)
      const reviewMdV1 = [
        '# Code Review: 2cloud-services#5701',
        '',
        '## 2. Review Findings',
        '',
        '### 🔴 Blockers',
        '',
        '#### `#1` — [Map all 5 billing_details fields](file:///src/Billing/MonerisPaymentGateway.php#L253-L254)',
        '- **Domain:** product',
        '- **Ready-to-paste GitHub comment:**',
        '```markdown',
        'Map `address_1`, `city`, `province`, `country`, and `postal_code` into `billing_details` instead of only `postal_code`.',
        '```',
        '',
        '#### `#2` — [Keep Merchant entity scope on listener](file:///src/Listener/LittlepayMerchantCreationListener.php#L10)',
        '- **Domain:** quality',
        '- **Ready-to-paste GitHub comment:**',
        '```markdown',
        'Switching from `AsEntityListener` to `AsDoctrineListener` makes this listener run on every entity across all entity managers.',
        '```',
        '',
        '#### `#3` — [Avoid loose empty() check](file:///src/Billing/MonerisPaymentGateway.php#L253)',
        '- **Domain:** quality',
        '- **Ready-to-paste GitHub comment:**',
        '```markdown',
        'Prefer strict `$zipCode !== null && $zipCode !== ""` instead of `!empty($zipCode)`.',
        '```',
      ].join('\n');
      fs.writeFileSync(path.join(reviewsDir, 'review-2cloud-services-5701.md'), reviewMdV1, 'utf8');

      // Seed cached GitHub Overview simulating that #2 was manually copy-pasted by @fawr-ubi directly onto GitHub.com!
      fs.writeFileSync(
        path.join(cacheDir, 'overview-2cloud-services-5701.json'),
        JSON.stringify({
          fetchedAt: Date.now(),
          data: {
            repo: '2cloud-services',
            number: 5701,
            headRefOid: headSha,
            generalComments: [],
            reviews: [],
            reviewThreads: [
              {
                id: 'PRRT_manual_2',
                isResolved: false,
                path: 'src/Listener/LittlepayMerchantCreationListener.php',
                line: 10,
                diffSide: 'RIGHT',
                comments: [
                  {
                    id: 'PRRC_manual_2',
                    body: 'Switching from `AsEntityListener` to `AsDoctrineListener` makes this listener run on every entity across all entity managers.',
                    authorLogin: 'fawr-ubi',
                    createdAt: '2026-11-20T09:00:00Z',
                    url: 'https://github.com/ubitransports/2cloud-services/pull/5701#discussion_r9992',
                  },
                ],
              },
            ],
          },
        }),
        'utf8'
      );

      setCustomGithubPublishHandlerForTests(async (call) => {
        publishedCalls.push(call);
        return {
          id: 77700 + publishedCalls.length,
          html_url: `https://github.com/ubitransports/${call.repo}/pull/${call.number}#discussion_r${77700 + publishedCalls.length}`,
        };
      });

      const srv = createHubServer({ enableScheduler: false });
      await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const port = srv.address().port;
      const base = `http://127.0.0.1:${port}`;

      try {
        // A. Verify Review Asked metadata in GET /api/state
        const stateRes = await fetch(`${base}/api/state`).then((r) => r.json());
        const byKey = Object.fromEntries(stateRes.prs.map((p) => [p.key, p]));
        assert.equal(byKey['2cloud-services#5701'].isReviewAsked, true);
        assert.equal(byKey['2cloud-services#5701'].reviewAskedDirect, true);
        assert.equal(byKey['2cloud-services#5701'].reviewAskedSource, 'direct');

        assert.equal(byKey['2cloud-services#5742'].isReviewAsked, true);
        assert.equal(byKey['2cloud-services#5742'].reviewAskedTeam, true);
        assert.equal(byKey['2cloud-services#5742'].reviewAskedSource, 'team');

        assert.equal(
          byKey['2cloud-services#5500'].isReviewAsked,
          false,
          'Team PR already approved by @fawr-ubi should move to Reviewed, not stay in Review Asked'
        );
        assert.equal(byKey['2cloud-services#5500'].reviewedByMe, true);
        assert.equal(byKey['2cloud-services#5800'].isReviewAsked, false, 'Own PR is never Review Asked');
        assert.equal(byKey['2cloud-services#5900'].isReviewAsked, false, 'Draft PR is never Review Asked');

        // B. Verify GET /api/review auto-reconciles #2 (manually posted on GitHub.com!) as posted=true
        const revRes1 = await fetch(
          `${base}/api/review?file=review-2cloud-services-5701.md&key=${encodeURIComponent('2cloud-services#5701')}`
        ).then((r) => r.json());
        const f1 = revRes1.findings.find((f) => f.id === '#1');
        const f2 = revRes1.findings.find((f) => f.id === '#2');
        const f3 = revRes1.findings.find((f) => f.id === '#3');
        assert.equal(f1.posted, false);
        assert.equal(f2.posted, true, '#2 manually posted on GitHub must be auto-marked posted=true');
        assert.equal(
          f2.postedUrl,
          'https://github.com/ubitransports/2cloud-services/pull/5701#discussion_r9992'
        );
        assert.equal(f3.posted, false);

        // C. Post General Comment from Overview tab using `{ body }` (previously 400 bug!)
        const genRes = await fetch(`${base}/api/github/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: '2cloud-services',
            number: 5701,
            mode: 'general',
            body: 'General note from PR Overview tab.',
          }),
        });
        assert.equal(genRes.status, 200);
        assert.equal(publishedCalls.at(-1).payload.body, 'General note from PR Overview tab.');

        // D. Post inline comment on a DELETED line (`side: 'LEFT'`, line 252 `- $legacy = true;`)
        const delInlineRes = await fetch(`${base}/api/github/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: '2cloud-services',
            number: 5701,
            headSha,
            mode: 'inline',
            side: 'LEFT',
            filePath: 'src/Billing/MonerisPaymentGateway.php',
            startLine: 252,
            endLine: 252,
            commentBody: 'Good cleanup removing $legacy!',
          }),
        });
        assert.equal(delInlineRes.status, 200);
        assert.equal(publishedCalls.at(-1).payload.side, 'LEFT');
        assert.equal(publishedCalls.at(-1).payload.line, 252);

        // E. Publish #1 individually via Hub (`POST /api/github/comment`)
        const postF1Res = await fetch(`${base}/api/github/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: '2cloud-services',
            number: 5701,
            headSha,
            mode: 'inline',
            filePath: f1.filePath,
            startLine: f1.startLine,
            endLine: f1.endLine,
            commentBody: f1.customComment,
            cid: f1.cid,
            title: f1.title,
          }),
        });
        assert.equal(postF1Res.status, 200);

        // F. CRITICAL USER REQUIREMENT: Submit global PR Review passing [#1, #2, #3].
        //    Both #1 (posted via Hub) AND #2 (posted manually on GitHub.com) MUST be excluded; ONLY #3 is sent!
        const batchRes = await fetch(`${base}/api/github/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: '2cloud-services',
            number: 5701,
            headSha,
            event: 'REQUEST_CHANGES',
            summaryBody: 'Please address the remaining point.',
            inlineComments: [f1, f2, f3].map((f) => ({
              cid: f.cid,
              title: f.title,
              filePath: f.filePath,
              startLine: f.startLine,
              endLine: f.endLine,
              body: f.customComment,
            })),
          }),
        });
        assert.equal(batchRes.status, 200);
        const batchData = await batchRes.json();
        assert.equal(batchData.postedCount, 1, 'Only #3 must be posted in batch review');
        assert.deepEqual(batchData.skippedAlreadyPostedCids.sort(), [f1.cid, f2.cid].sort());
        const ghBatchCall = publishedCalls.at(-1);
        assert.equal(ghBatchCall.payload.comments.length, 1);
        assert.ok(ghBatchCall.payload.comments[0].body.includes('Prefer strict'));

        // G. Calling COMMENT review again when all 3 comments are already posted and summaryBody is empty -> clear 400
        const duplicateBatchRes = await fetch(`${base}/api/github/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: '2cloud-services',
            number: 5701,
            headSha,
            event: 'COMMENT',
            summaryBody: '',
            inlineComments: [f3].map((f) => ({
              cid: f.cid,
              filePath: f.filePath,
              startLine: f.startLine,
              endLine: f.endLine,
              body: f.customComment,
            })),
          }),
        });
        assert.equal(duplicateBatchRes.status, 400);

        // H. Self-PR guard: APPROVE on own PR (2cloud-services#5800) returns 422
        const selfApproveRes = await fetch(`${base}/api/github/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: '2cloud-services',
            number: 5800,
            headSha,
            event: 'APPROVE',
            summaryBody: 'LGTM',
            inlineComments: [],
          }),
        });
        assert.equal(selfApproveRes.status, 422);

        // I. AI Re-Review Fingerprint Resilience: swap #1 and #3 in regenerated markdown + add a brand-new #1!
        const reviewMdV2 = [
          '# Code Review: 2cloud-services#5701 (Re-run)',
          '',
          '## 2. Review Findings',
          '',
          '### 🔴 Blockers',
          '',
          '#### `#1` — [Brand new unposted security finding](file:///src/Billing/MonerisPaymentGateway.php#L254)',
          '- **Domain:** security',
          '- **Ready-to-paste GitHub comment:**',
          '```markdown',
          'Sanitize postal_code format before forwarding.',
          '```',
          '',
          '#### `#2` — [Map all 5 billing_details fields](file:///src/Billing/MonerisPaymentGateway.php#L253-L254)',
          '- **Domain:** product',
          '- **Ready-to-paste GitHub comment:**',
          '```markdown',
          'Map `address_1`, `city`, `province`, `country`, and `postal_code` into `billing_details` instead of only `postal_code`.',
          '```',
        ].join('\n');
        fs.writeFileSync(path.join(reviewsDir, 'review-2cloud-services-5701.md'), reviewMdV2, 'utf8');

        const revRes2 = await fetch(
          `${base}/api/review?file=review-2cloud-services-5701.md&key=${encodeURIComponent('2cloud-services#5701')}`
        ).then((r) => r.json());
        const v2New1 = revRes2.findings.find((f) => f.id === '#1');
        const v2Moved2 = revRes2.findings.find((f) => f.id === '#2');
        assert.equal(
          v2New1.posted,
          false,
          'Brand-new finding #1 must NOT inherit old #1 posted=true state!'
        );
        assert.equal(
          v2Moved2.posted,
          true,
          'Moved finding (Map all 5 billing_details fields) must retain its posted=true state via fingerprint!'
        );
      } finally {
        await new Promise((resolve) => srv.close(resolve));
      }
    } finally {
      setCustomGithubPublishHandlerForTests(null);
      if (prevCfgEnv === undefined) delete process.env.REVIEW_HUB_CONFIG;
      else process.env.REVIEW_HUB_CONFIG = prevCfgEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('API Transport, Single Model Selection & PR Auto-Review Exclusion', () => {
  test('resolveApiTransportConfig selects vertex, gemini-api, or cli with single model override', () => {
    const vertexCfg = resolveApiTransportConfig(
      { agentRunnerMode: 'auto', agentModel: 'gemini-2.5-pro' },
      { GCP_PROJECT_ID: 'ubi-prod-123', GCP_LOCATION: 'europe-west1' }
    );
    assert.equal(vertexCfg.transport, 'vertex');
    assert.equal(vertexCfg.modelId, 'gemini-2.5-pro');
    assert.equal(
      buildVertexGenerateUrl(vertexCfg),
      'https://europe-west1-aiplatform.googleapis.com/v1/projects/ubi-prod-123/locations/europe-west1/publishers/google/models/gemini-2.5-pro:generateContent'
    );

    const apiKeyCfg = resolveApiTransportConfig(
      { agentRunnerMode: 'auto' },
      { GEMINI_API_KEY: 'test-key-123', REVIEW_HUB_MODEL: 'gemini-2.5-flash' }
    );
    assert.equal(apiKeyCfg.transport, 'gemini-api');
    assert.equal(apiKeyCfg.modelId, 'gemini-2.5-flash');
    assert.equal(
      buildGeminiApiUrl({ modelId: apiKeyCfg.modelId }),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    );

    const cliCfg = resolveApiTransportConfig(
      { agentRunnerMode: 'cli', agentModel: 'gemini-4-carbon-medium' },
      { GCP_PROJECT_ID: 'ubi-prod-123', GEMINI_API_KEY: 'test-key-123' }
    );
    assert.equal(cliCfg.transport, 'cli');
    assert.equal(cliCfg.modelId, 'gemini-4-carbon-medium');
  });

  test('runGeminiApiPrompt executes Vertex AI Function Calling (read_repo_file) and enforces max 3 calls', async () => {
    const seenPayloads = [];
    let callIdx = 0;
    const mockFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seenPayloads.push({ url, headers: init.headers, body });
      callIdx++;
      if (body.tools) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: 'read_repo_file',
                        args: { path: `src/File${callIdx}.php` },
                      },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: '# Code Review: repo#1\n\n## 1. Task Summary & Functional Problem Solved\nDone.' }],
              },
            },
          ],
        }),
      };
    };

    const fetchedPaths = [];
    const mockGithubFetcher = async ({ filePath }) => {
      fetchedPaths.push(filePath);
      return { ok: true, path: filePath, type: 'file', content: '<?php interface Foo {}' };
    };

    const result = await runGeminiApiPrompt({
      prompt: 'Audit this PR',
      transport: 'vertex',
      modelId: 'gemini-2.5-flash',
      projectId: 'ubi-test',
      location: 'global',
      prContext: { org: 'ubitransports', repo: '2cloud-services', headSha: 'abc123' },
      maxToolCalls: 3,
      fetchFn: mockFetch,
      tokenProvider: async () => 'adc-bearer-token',
      githubFileFetcher: mockGithubFetcher,
    });

    assert.match(result, /# Code Review: repo#1/);
    assert.deepEqual(fetchedPaths, ['src/File1.php', 'src/File2.php', 'src/File3.php']);
    assert.equal(seenPayloads.length, 4, '3 tool turns + 1 final turn without tools');
    assert.equal(seenPayloads[0].headers.Authorization, 'Bearer adc-bearer-token');
    assert.ok(seenPayloads[0].body.tools, 'tools must be offered on initial turn');
    assert.equal(
      seenPayloads[3].body.tools,
      undefined,
      'tools must be omitted after maxToolCalls is reached to force final synthesis'
    );
  });

  test('fetchRepoFileFromGithub blocks path traversal attempts', async () => {
    const res = await fetchRepoFileFromGithub({
      org: 'ubitransports',
      repo: '2cloud-services',
      filePath: '../../etc/passwd',
      headSha: 'abc123',
      execFn: async () => {
        throw new Error('Should not execute gh api');
      },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Invalid or unsafe file path/i);
  });

  test('shouldSkipAutoReview filters bots, releases/version bumps, excluded labels, lockfiles-only, and oversized PRs while allowing manual force', () => {
    const baseCfg = loadConfig();

    assert.equal(shouldSkipAutoReview({ author: 'dependabot[bot]', title: 'Update axios' }, baseCfg).skip, true);
    assert.equal(shouldSkipAutoReview({ author: 'ci-cd-matawan', title: 'Sync' }, baseCfg).skip, true);
    assert.equal(shouldSkipAutoReview({ author: 'dev1', title: 'chore(release): 2.196.0' }, baseCfg).skip, true);
    assert.equal(shouldSkipAutoReview({ author: 'dev1', title: 'Bump version to 1.4.0' }, baseCfg).skip, true);
    assert.equal(shouldSkipAutoReview({ author: 'dev1', title: "Merge branch 'main' into develop" }, baseCfg).skip, true);
    assert.equal(shouldSkipAutoReview({ author: 'dev1', title: 'Release', headRefName: 'release/2.196' }, baseCfg).skip, true);
    assert.equal(
      shouldSkipAutoReview({ author: 'dev1', title: 'Refactor', labels: [{ name: 'skip-ai-review' }] }, baseCfg).skip,
      true
    );
    assert.equal(
      shouldSkipAutoReview(
        {
          author: 'dev1',
          title: 'Refresh lockfile',
          changedFiles: 2,
          changedFilePaths: ['package-lock.json', 'composer.lock'],
        },
        baseCfg
      ).skip,
      true
    );
    assert.equal(
      shouldSkipAutoReview({ author: 'dev1', title: 'Huge migration', changedFiles: 200 }, baseCfg).skip,
      true
    );

    // Normal feature PR must NOT be skipped
    assert.equal(
      shouldSkipAutoReview(
        {
          author: 'dev1',
          title: 'feat(MA): PRD-18000 - Add ticket validation',
          headRefName: 'feat/PRD-18000-ticket-validation',
          labels: [{ name: 'backend' }],
          changedFiles: 4,
          changedFilePaths: ['src/Service/Validator.php'],
        },
        baseCfg
      ).skip,
      false
    );

    // Scheduler respects exclusion automatically, but allows manual force=true
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skip-test-'));
    let scheduler = null;
    try {
      scheduler = new AutoReviewScheduler({
        loadConfigFn: () => ({ ...baseCfg, reviewsDir: tmpDir }),
        runReviewFn: async () => {},
      });
      const skippedRes = scheduler.enqueuePrReview(
        {
          repo: '2cloud-services',
          number: 9991,
          title: 'chore(release): 2.200.0',
          author: 'dev1',
          headRefOid: 'sha1',
        },
        { force: false }
      );
      assert.equal(skippedRes.skipped, true);
      assert.match(skippedRes.reason, /^title:/);

      const forcedRes = scheduler.enqueuePrReview(
        {
          repo: '2cloud-services',
          number: 9991,
          title: 'chore(release): 2.200.0',
          author: 'dev1',
          headRefOid: 'sha1',
        },
        { force: true, priority: true }
      );
      assert.equal(forcedRes.skipped, false);
      assert.ok(forcedRes.job);
    } finally {
      scheduler?.stop?.();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});




