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
  resolveFindingAgainstDiff
} from '../lib/parser.mjs';

import { loadConfig, saveConfig } from '../lib/config.mjs';
import {
  computeAuthorInitials,
  resolveAuthorDisplayName,
  extractJiraKey,
  detectStackedPr,
  normalizeCiState,
} from '../lib/metadata.mjs';
import { setCustomAgentRunnerForTests } from '../lib/agent.mjs';
import { synthesizeCandidateRulesFromComments } from '../lib/onboarding.mjs';
import { saveCandidateRules } from '../lib/rules.mjs';
import { createHubServer } from '../server.mjs';
import { execFileSync } from 'node:child_process';

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
  const realReviewsDir = '/Users/antoinefawer/Ubitransport/projects/artifacts/reviews';

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
      return `En réponse à ta question : OrderProcessor::processOrder() retourne bien un booléen strict.`;
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
    assert.ok(js.includes("e.key === 'ArrowLeft'"));
    assert.ok(js.includes("e.key === 'ArrowRight'"));
    assert.ok(js.includes('diffFileJumpSelect'));
    assert.ok(js.includes('openKeyboardShortcutsModal'));
    assert.ok(js.includes('applyDiffZoomVariables'));
    assert.ok(css.includes('--diff-font-size'));
  });

  test('1-year team PR review comment onboarding synthesizes candidate rules and requires user approval/rejection before activation', async () => {
    const commonFile = path.join(tmpRoot, 'common-dna.md');
    const dnaFile = path.join(tmpRoot, 'reviewer-dna.local.md');
    const candidateFile = path.join(tmpRoot, 'candidate-rules.local.json');
    const changelogFile = path.join(tmpRoot, 'changelog.local.md');

    fs.writeFileSync(
      commonFile,
      `# Common DNA\n\n## 1. Architecture, Serialization & Clean Code\n- **SOLID — Dependency Inversion (DIP):** Always type-hint interfaces.\n`,
      'utf8'
    );
    fs.writeFileSync(
      dnaFile,
      `# Local DNA\n\n## 1. Architecture, Serialization & Clean Code\n`,
      'utf8'
    );
    fs.writeFileSync(changelogFile, `# Changelog\n`, 'utf8');

    process.env.REVIEW_HUB_COMMON_DNA_FILE = commonFile;
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

    // 1. GET /api/rules returns common rules + pending candidate rules
    const listRes = await fetch(`${baseUrl}/api/rules`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.candidates.length, 3);
    assert.ok(listData.rules.some((r) => r.target === 'common'));

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

    delete process.env.REVIEW_HUB_COMMON_DNA_FILE;
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

    // Zero abbreviations ("en toutes lettres") & rich PR detail tags in HTML and JS
    assert.ok(html.includes('Configuration'));
    assert.ok(html.includes('Tout auditer'));
    assert.ok(html.includes('Synchroniser GitHub'));
    assert.ok(html.includes('Peer-Review'));
    assert.ok(html.includes('Self-Review'));
    assert.ok(html.includes('Monter Worktree'));
    assert.ok(js.includes('Tous les dépôts'));
    assert.ok(js.includes('CI : Succès'));
    assert.ok(js.includes('CI : Échec'));
    assert.ok(js.includes('Branche empilée →'));
    assert.ok(js.includes('Worktree : Git direct'));
    assert.ok(js.includes('Ouvrir Diff'));
    assert.ok(js.includes('Lire Audit'));
    assert.ok(js.includes('Approuvé par :'));
    assert.ok(js.includes('Changements demandés par :'));
    assert.ok(js.includes('En attente de :'));
    assert.ok(js.includes('Conflit Git'));
    assert.ok(js.includes('Fusionnable'));
    assert.ok(!js.includes('$1 blk'));
    assert.ok(!js.includes('$1 maj'));

    // 3-Theme cycle with 'purple' between 'light' and 'dark'
    assert.ok(css.includes('[data-theme="purple"]'));
    assert.ok(css.includes('#231f33'));
    assert.ok(js.includes("const THEME_ORDER = ['light', 'purple', 'dark']"));

    // Dedicated 'b' shortcut for modified file tree & Enter/Cmd+Enter chat submission
    assert.ok(js.includes("e.key === 'b'"));
    assert.ok(js.includes('Masquer Fichiers (b)'));
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

    // Server pagination for >100 changed files
    const serverSrc = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    assert.ok(serverSrc.includes("'--paginate'"));
    assert.ok(serverSrc.includes("'--slurp'"));
  });
});

