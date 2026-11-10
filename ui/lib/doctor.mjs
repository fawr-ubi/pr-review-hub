import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SKILL_ROOT, findCliBinaryPath, ensureSkillSymlinks } from './config.mjs';
import { listAllRules } from './rules.mjs';

const execFileAsync = promisify(execFile);

async function checkBinary(bin, args = ['--version']) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 4000 });
    const out = String(stdout || stderr || '').trim().split('\n')[0];
    return { ok: true, detail: out || `${bin} found` };
  } catch (err) {
    return { ok: false, detail: err.message || `${bin} not found` };
  }
}

export async function runDoctor(cfg = {}) {
  const checks = [];

  // 1. Node.js
  checks.push({
    id: 'node',
    label: 'Node.js Runtime (>= 18)',
    ok: parseInt(process.versions.node.split('.')[0], 10) >= 18,
    detail: `Node ${process.version}`,
  });

  // 2. Git CLI
  const gitCheck = await checkBinary('git', ['--version']);
  checks.push({
    id: 'git',
    label: 'Git CLI',
    ok: gitCheck.ok,
    detail: gitCheck.detail,
    fixHint: 'xcode-select --install',
  });

  // 3. GitHub CLI (gh) + Auth
  const ghCheck = await checkBinary('gh', ['--version']);
  let ghAuthOk = false;
  let ghAuthDetail = ghCheck.detail;
  if (ghCheck.ok) {
    try {
      const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
      ghAuthOk = true;
      const combined = `${stdout || ''}\n${stderr || ''}`;
      const match = combined.match(/Logged in to [^\s]+ account ([^\s(]+)/i);
      ghAuthDetail = match ? `Authenticated as ${match[1]}` : 'Authenticated with GitHub CLI';
    } catch {
      ghAuthOk = false;
      ghAuthDetail = 'Not authenticated (run: gh auth login)';
    }
  }
  checks.push({
    id: 'gh',
    label: 'GitHub CLI & Auth',
    ok: ghCheck.ok && ghAuthOk,
    detail: ghAuthDetail,
    fixHint: ghCheck.ok ? 'gh auth login' : 'brew install gh && gh auth login',
  });

  // 4. AI Agent CLI (agy, gemini, or claude)
  const preferredCli = ['agy', 'gemini', 'claude'].includes(cfg.agentCli) ? cfg.agentCli : 'agy';
  const allClis = ['agy', 'gemini', 'claude'];
  const fallbackClis = allClis.filter((c) => c !== preferredCli);
  const primaryBin = findCliBinaryPath(preferredCli) || preferredCli;
  const primaryCheck = await checkBinary(primaryBin, ['--version']);
  let agentOk = primaryCheck.ok;
  let resolvedCli = preferredCli;
  let agentDetail = primaryCheck.ok
    ? `${preferredCli} (${primaryBin}): ${primaryCheck.detail}`
    : `${preferredCli} not found`;
  if (!primaryCheck.ok) {
    for (const alt of fallbackClis) {
      const altBin = findCliBinaryPath(alt);
      if (altBin) {
        const altCheck = await checkBinary(altBin, ['--version']);
        if (altCheck.ok) {
          agentOk = true;
          resolvedCli = alt;
          agentDetail = `${preferredCli} missing, auto-falling back to ${alt} (${altBin}: ${altCheck.detail})`;
          break;
        }
      }
    }
  }
  checks.push({
    id: 'agentCli',
    label: `AI Agent CLI (${resolvedCli})`,
    ok: agentOk,
    detail: agentDetail,
    fixHint: 'npm install -g @google/gemini-cli && gemini',
  });

  // 5. Local Projects Workspace & Git Repositories (Optional — Remote GitHub mode always works)
  const projectsDir = cfg.projectsDir || '';
  let localRepos = [];
  const projectsDirExists = Boolean(projectsDir && fs.existsSync(projectsDir));
  if (projectsDirExists) {
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const gitDir = path.join(projectsDir, entry.name, '.git');
        if (fs.existsSync(gitDir)) {
          localRepos.push(entry.name);
        }
      }
    } catch {
      // ignore read errors
    }
  }
  checks.push({
    id: 'projectsDir',
    label: 'Local Projects Workspace',
    ok: true,
    optional: !projectsDirExists || localRepos.length === 0,
    detail:
      projectsDirExists && localRepos.length > 0
        ? `${projectsDir} (${localRepos.length} local git repo${localRepos.length === 1 ? '' : 's'}: ${localRepos.slice(0, 5).join(', ')}${localRepos.length > 5 ? '…' : ''})`
        : `Remote GitHub mode active (clone repos into ${projectsDir || '~/projects'} only if you want local Worktrees / IDE jump)`,
  });

  // 6. Reviews Directory & Queue State
  const reviewsDir = cfg.reviewsDir || '';
  const statePath = path.join(reviewsDir, '.state.json');
  const hasState = Boolean(reviewsDir && fs.existsSync(statePath));
  let trackedPrCount = 0;
  if (hasState) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      trackedPrCount = Object.keys(parsed.prs || {}).length;
    } catch {
      // ignore
    }
  }
  checks.push({
    id: 'reviewsDir',
    label: 'Reviews Storage & Queue Cache',
    ok: Boolean(reviewsDir && fs.existsSync(reviewsDir)),
    detail: hasState
      ? `${reviewsDir} (${trackedPrCount} PR${trackedPrCount === 1 ? '' : 's'} cached)`
      : `${reviewsDir} (Ready — click "Sync GitHub" to fetch open PRs)`,
  });

  // 7. Active Team Profile & 4-Layer Rules
  let rulesSummary = { common: 0, team: 0, personal: 0, falsePositives: 0 };
  let activeTeamName = cfg.teamProfile || 'popcorn-back';
  try {
    const bundle = listAllRules(cfg.teamProfile || 'popcorn-back');
    activeTeamName = bundle.activeTeamProfile?.name || activeTeamName;
    rulesSummary = {
      common: (bundle.commonRules || []).length,
      team: (bundle.teamRules || []).length,
      personal: (bundle.dnaRules || []).length,
      falsePositives: (bundle.falsePositives || []).length,
    };
  } catch {
    // ignore
  }
  checks.push({
    id: 'teamProfile',
    label: `Team Agent Profile (${cfg.teamProfile || 'popcorn-back'})`,
    ok: rulesSummary.common + rulesSummary.team > 0,
    detail: `${activeTeamName} — ${rulesSummary.common} Common, ${rulesSummary.team} Team, ${rulesSummary.personal} Personal, ${rulesSummary.falsePositives} False-Positive rules`,
  });

  // 8. Agent Skill Registration (Symlink to ~/.gemini/config/skills/my-review & ~/.claude/skills/my-review)
  try {
    ensureSkillSymlinks();
  } catch {
    // ignore
  }
  const geminiSkillPath = path.join(os.homedir(), '.gemini', 'config', 'skills', 'my-review');
  const skillLinked = fs.existsSync(geminiSkillPath) || fs.existsSync(path.join(SKILL_ROOT, 'SKILL.md'));
  checks.push({
    id: 'skillSymlink',
    label: 'IDE / CLI Skill Registration (my-review)',
    ok: skillLinked,
    detail: fs.existsSync(geminiSkillPath)
      ? `Linked at ${geminiSkillPath}`
      : `Loaded from ${SKILL_ROOT}`,
  });

  const allOk = checks.every((c) => c.ok);
  return {
    ok: allOk,
    timestamp: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    localRepos,
    trackedPrCount,
    rulesSummary,
    checks,
  };
}

function getRexFilePath(cfg) {
  const dir = cfg?.reviewsDir || path.join(os.tmpdir(), 'pr-review-hub-reviews');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, '.rex-feedback.json');
}

export function listRexFeedback(cfg) {
  const filePath = getRexFilePath(cfg);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

export function addRexFeedback(cfg, payload = {}, version = '1.1.0') {
  const title = String(payload.title || '').trim();
  const description = String(payload.description || '').trim();
  if (!title && !description) {
    throw new Error('Feedback title or description is required');
  }
  const items = listRexFeedback(cfg);
  const entry = {
    id: `rex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    author: cfg?.githubUser || 'colleague',
    teamProfile: cfg?.teamProfile || 'popcorn-back',
    agentCli: cfg?.agentCli || 'gemini',
    version,
    category: payload.category || 'ux',
    rating: Number(payload.rating) || 5,
    prKey: String(payload.prKey || '').trim() || null,
    activeTab: String(payload.activeTab || '').trim() || null,
    title: title || description.slice(0, 70),
    description,
  };
  items.unshift(entry);
  const filePath = getRexFilePath(cfg);
  fs.writeFileSync(filePath, JSON.stringify({ items }, null, 2) + '\n', 'utf8');
  return entry;
}

export function deleteRexFeedback(cfg, id) {
  const items = listRexFeedback(cfg);
  const next = items.filter((item) => item.id !== id);
  const filePath = getRexFilePath(cfg);
  fs.writeFileSync(filePath, JSON.stringify({ items: next }, null, 2) + '\n', 'utf8');
  return { deleted: items.length !== next.length, remaining: next.length };
}

const CATEGORY_LABELS = {
  bug: '🐛 Bug / Issue',
  ux: '✨ UX / Shortcuts / Ergonomics',
  'agent-quality': '🤖 AI Agent Quality / False Positive',
  'team-rule': '📏 Team DNA Rule Suggestion',
  'feature-request': '🚀 Feature Request',
};

export function formatRexMarkdownReport({ items = [], cfg = {}, version = '1.1.0' } = {}) {
  const user = cfg.githubUser || 'unknown';
  const team = cfg.teamProfile || 'popcorn-back';
  const cli = cfg.agentCli || 'gemini';
  const date = new Date().toISOString().slice(0, 10);

  const lines = [
    `# 🧪 PR Review Hub — Colleague REX Report (@${user})`,
    `- **Date:** \`${date}\``,
    `- **Version:** \`v${version}\``,
    `- **Team Profile:** \`${team}\` | **Agent CLI:** \`${cli}\``,
    `- **Total Feedback Items:** \`${items.length}\``,
    '',
  ];

  if (items.length === 0) {
    lines.push('_No feedback items recorded yet._');
    return lines.join('\n');
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const catLabel = CATEGORY_LABELS[item.category] || item.category || 'General';
    const stars = '★'.repeat(Math.max(1, Math.min(5, Number(item.rating) || 5)));
    lines.push(`### #${i + 1} [${catLabel}] ${item.title}`);
    lines.push(
      `- **Rating / Experience:** \`${stars}\` (${item.rating || 5}/5)` +
        (item.prKey ? ` · **PR:** \`${item.prKey}\`` : '') +
        (item.activeTab ? ` · **Tab:** \`${item.activeTab}\`` : '') +
        ` · **Date:** \`${String(item.createdAt || '').slice(0, 16).replace('T', ' ')}\``
    );
    if (item.description && item.description !== item.title) {
      lines.push('');
      lines.push(item.description);
    }
    lines.push('');
  }

  return lines.join('\n');
}
