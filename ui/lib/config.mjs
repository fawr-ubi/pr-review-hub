import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SKILL_ROOT = path.resolve(__dirname, '../..');

export function getConfigFile() {
  return process.env.REVIEW_HUB_CONFIG || path.join(SKILL_ROOT, 'config.json');
}

function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function detectGithubUser() {
  if (process.env.REVIEW_HUB_USER) return process.env.REVIEW_HUB_USER;
  try {
    const out = execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      timeout: 3500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // ignore offline / gh error
  }
  return os.userInfo().username || 'github-user';
}

export function detectGithubTeamsSync(orgFilter = 'ubitransports') {
  try {
    const out = execFileSync(
      'gh',
      [
        'api',
        'user/teams?per_page=100',
        '--jq',
        `[.[] | select(.organization.login == "${orgFilter}") | .slug]`,
      ],
      {
        encoding: 'utf8',
        timeout: 4500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();
    const parsed = JSON.parse(out || '[]');
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // ignore
  }
  return [];
}

export function findCliBinaryPath(cliName = 'agy') {
  const home = os.homedir();
  const candidatesByCli = {
    agy: [
      path.join(home, '.local/bin/agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
      path.join(home, 'Applications/Antigravity.app/Contents/Resources/app/bin/agy'),
    ],
    gemini: [
      '/opt/homebrew/bin/gemini',
      '/usr/local/bin/gemini',
      path.join(home, '.local/bin/gemini'),
      path.join(home, '.npm-global/bin/gemini'),
      path.join(home, '.bun/bin/gemini'),
    ],
    claude: [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(home, '.local/bin/claude'),
      path.join(home, '.claude/local/claude'),
      path.join(home, '.npm-global/bin/claude'),
      '/Applications/cmux.app/Contents/Resources/bin/claude',
    ],
  };
  const candidates = candidatesByCli[cliName] || candidatesByCli.agy;

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Check nvm node versions if present
  const nvmDir = path.join(home, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        const p = path.join(nvmDir, v, 'bin', cliName);
        if (fs.existsSync(p)) return p;
      }
    } catch {
      // ignore
    }
  }

  try {
    const whichOut = execFileSync('which', [cliName], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (whichOut && fs.existsSync(whichOut)) return whichOut;
  } catch {
    // ignore
  }
  return null;
}

export function detectInstalledAgentCli() {
  if (process.env.REVIEW_HUB_AGENT_CLI) return process.env.REVIEW_HUB_AGENT_CLI;
  if (findCliBinaryPath('agy')) return 'agy';
  if (findCliBinaryPath('gemini')) return 'gemini';
  if (findCliBinaryPath('claude')) return 'claude';
  return 'agy';
}

export function detectLocalProjectsDir() {
  if (process.env.REVIEW_HUB_PROJECTS_DIR) {
    return expandHome(process.env.REVIEW_HUB_PROJECTS_DIR);
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Ubitransport', 'projects'),
    path.join(home, 'ubitransport', 'projects'),
    path.join(home, 'Matawan', 'projects'),
    path.join(home, 'matawan', 'projects'),
    path.join(home, 'projects'),
    path.join(home, 'Projects'),
    path.join(home, 'dev'),
    path.join(home, 'Code'),
    path.join(home, 'workspace'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(home, 'Ubitransport', 'projects');
}

export async function discoverGithubIdentityAndTeams(orgFilter = '') {
  try {
    const [userRes, teamsRes] = await Promise.all([
      execFileAsync('gh', ['api', 'user', '--jq', '{login: .login, name: .name}'], {
        timeout: 6000,
      }).catch(() => ({ stdout: '{}' })),
      execFileAsync(
        'gh',
        [
          'api',
          'user/teams?per_page=100',
          '--jq',
          '[.[] | {slug: .slug, name: .name, org: .organization.login, fullSlug: (.organization.login + "/" + .slug)}]',
        ],
        { timeout: 8000 }
      ).catch(() => ({ stdout: '[]' })),
    ]);

    const user = JSON.parse(userRes.stdout || '{}');
    let teams = JSON.parse(teamsRes.stdout || '[]');
    if (orgFilter) {
      teams = teams.filter(
        (t) => String(t.org || '').toLowerCase() === String(orgFilter).toLowerCase()
      );
    }
    const resolvedLogin = user.login || detectGithubUser();
    return {
      login: resolvedLogin,
      githubUser: resolvedLogin,
      name: user.name || '',
      teams: Array.isArray(teams)
        ? teams.map((t) => ({ ...t, combinedSlug: t.fullSlug || `${t.org}/${t.slug}` }))
        : [],
    };
  } catch {
    const resolvedLogin = detectGithubUser();
    return {
      login: resolvedLogin,
      githubUser: resolvedLogin,
      name: '',
      teams: [],
    };
  }
}

export function getDefaultConfig() {
  const defaultProjectsDir = detectLocalProjectsDir();
  const defaultReviewsDir =
    process.env.REVIEWS_DIR || path.join(defaultProjectsDir, 'artifacts', 'reviews');

  return {
    githubOrg: process.env.REVIEW_HUB_ORG || 'ubitransports',
    githubUser: detectGithubUser(),
    githubTeams: [],
    teamProfile: process.env.REVIEW_HUB_TEAM_PROFILE || 'popcorn-back',
    agentCli: detectInstalledAgentCli(),
    projectsDir: defaultProjectsDir,
    reviewsDir: defaultReviewsDir,
    jiraBaseUrl: 'https://ubitransport.atlassian.net/browse',
    jiraPrefixes: ['PRD', 'HYB', 'WAN', 'POP', 'OPS', 'SEC', 'SUP', 'DEV'],
    syncScript: path.join(SKILL_ROOT, 'scripts', 'sync-queue.sh'),
  };
}

export function loadConfig() {
  const defaults = getDefaultConfig();
  const configFile = getConfigFile();
  try {
    if (fs.existsSync(configFile)) {
      const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const merged = {
        ...defaults,
        ...saved,
        githubTeams: Array.isArray(saved.githubTeams) ? saved.githubTeams : defaults.githubTeams,
        jiraPrefixes: Array.isArray(saved.jiraPrefixes)
          ? saved.jiraPrefixes
          : typeof saved.jiraPrefixes === 'string'
          ? saved.jiraPrefixes
              .split(',')
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean)
          : defaults.jiraPrefixes,
      };
      merged.projectsDir = expandHome(merged.projectsDir || defaults.projectsDir);
      merged.reviewsDir = expandHome(merged.reviewsDir || defaults.reviewsDir);
      return merged;
    }
  } catch {
    // fallback to defaults
  }
  return defaults;
}

export function saveConfig(partialConfig) {
  const current = loadConfig();
  const configFile = getConfigFile();
  const updated = {
    ...current,
    ...partialConfig,
  };
  if (typeof updated.githubTeams === 'string') {
    updated.githubTeams = updated.githubTeams
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof updated.jiraPrefixes === 'string') {
    updated.jiraPrefixes = updated.jiraPrefixes
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }
  if (updated.projectsDir) updated.projectsDir = expandHome(updated.projectsDir);
  if (updated.reviewsDir) updated.reviewsDir = expandHome(updated.reviewsDir);

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/**
 * Automatically bootstraps config.json and local reference files on first server start
 * even if the user ran `npm start` directly without running `./install.sh`.
 */
export function ensureConfigBootstrapped() {
  const refDir = path.join(SKILL_ROOT, 'references');
  const dnaLocal = path.join(refDir, 'reviewer-dna.local.md');
  const dnaExample = path.join(refDir, 'reviewer-dna.example.md');
  if (!fs.existsSync(dnaLocal) && fs.existsSync(dnaExample)) {
    try {
      fs.copyFileSync(dnaExample, dnaLocal);
    } catch {
      // ignore
    }
  }
  const fpLocal = path.join(refDir, 'false-positives.local.md');
  const fpExample = path.join(refDir, 'false-positives.example.md');
  if (!fs.existsSync(fpLocal) && fs.existsSync(fpExample)) {
    try {
      fs.copyFileSync(fpExample, fpLocal);
    } catch {
      // ignore
    }
  }
  const clLocal = path.join(refDir, 'changelog.local.md');
  if (!fs.existsSync(clLocal)) {
    try {
      fs.writeFileSync(clLocal, '# Review Memory Changelog\n\n---\n', 'utf8');
    } catch {
      // ignore
    }
  }

  const configFile = getConfigFile();
  if (!fs.existsSync(configFile)) {
    const defaults = getDefaultConfig();
    const detectedTeams = detectGithubTeamsSync(defaults.githubOrg);
    const bootstrapped = saveConfig({
      ...defaults,
      githubTeams: detectedTeams,
    });
    try {
      fs.mkdirSync(path.join(bootstrapped.reviewsDir, 'archive'), { recursive: true });
    } catch {
      // ignore
    }
    return bootstrapped;
  }

  const cfg = loadConfig();
  try {
    fs.mkdirSync(path.join(cfg.reviewsDir, 'archive'), { recursive: true });
  } catch {
    // ignore
  }
  return cfg;
}
