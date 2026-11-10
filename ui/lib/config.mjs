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
  const home = os.homedir();
  const defaultProjectsDir =
    process.env.REVIEW_HUB_PROJECTS_DIR || path.join(home, 'Ubitransport', 'projects');
  const defaultReviewsDir =
    process.env.REVIEWS_DIR || path.join(defaultProjectsDir, 'artifacts', 'reviews');

  return {
    githubOrg: process.env.REVIEW_HUB_ORG || 'ubitransports',
    githubUser: detectGithubUser(),
    githubTeams: [],
    teamProfile: process.env.REVIEW_HUB_TEAM_PROFILE || 'popcorn-back',
    agentCli: process.env.REVIEW_HUB_AGENT_CLI || 'gemini',
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
