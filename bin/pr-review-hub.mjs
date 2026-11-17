#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILL_ROOT, loadConfig, ensureConfigBootstrapped } from '../ui/lib/config.mjs';
import { runDoctor } from '../ui/lib/doctor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ENTRY = path.resolve(__dirname, '../ui/server.mjs');

const TEAM_SIMULATION_PRESETS = {
  pili: {
    profile: 'pili-back',
    teams: 'pili-back,ubi-eng-team-pili',
    label: 'Pili Squad (pili-back, ubi-eng-team-pili)',
  },
  'pili-back': {
    profile: 'pili-back',
    teams: 'pili-back,ubi-eng-team-pili',
    label: 'Pili Squad (pili-back, ubi-eng-team-pili)',
  },
  banana: {
    profile: 'banana-back',
    teams: 'banana-back,ubi-eng-team-banana',
    label: 'Banana Squad (banana-back, ubi-eng-team-banana)',
  },
  'banana-back': {
    profile: 'banana-back',
    teams: 'banana-back,ubi-eng-team-banana',
    label: 'Banana Squad (banana-back, ubi-eng-team-banana)',
  },
  papaya: {
    profile: 'papaya-back',
    teams: 'papaya-back,ubi-eng-team-papaya',
    label: 'Papaya Squad (papaya-back, ubi-eng-team-papaya)',
  },
  'papaya-back': {
    profile: 'papaya-back',
    teams: 'papaya-back,ubi-eng-team-papaya',
    label: 'Papaya Squad (papaya-back, ubi-eng-team-papaya)',
  },
  popcorn: {
    profile: 'popcorn-back',
    teams: 'popcorn-back,ubi-eng-team-popcorn',
    label: 'Popcorn Squad (popcorn-back, ubi-eng-team-popcorn)',
  },
  'popcorn-back': {
    profile: 'popcorn-back',
    teams: 'popcorn-back,ubi-eng-team-popcorn',
    label: 'Popcorn Squad (popcorn-back, ubi-eng-team-popcorn)',
  },
  front: {
    profile: 'frontend-web',
    teams: 'frontend-web',
    label: 'Frontend Web (frontend-web)',
  },
  'frontend-web': {
    profile: 'frontend-web',
    teams: 'frontend-web',
    label: 'Frontend Web (frontend-web)',
  },
  mobile: {
    profile: 'mobile-kotlin',
    teams: 'mobile-kotlin',
    label: 'Mobile Android Kotlin (mobile-kotlin)',
  },
  'mobile-kotlin': {
    profile: 'mobile-kotlin',
    teams: 'mobile-kotlin',
    label: 'Mobile Android Kotlin (mobile-kotlin)',
  },
  qa: {
    profile: 'qa-automation',
    teams: 'qa-automation',
    label: 'QA Automation (qa-automation)',
  },
  'qa-automation': {
    profile: 'qa-automation',
    teams: 'qa-automation',
    label: 'QA Automation (qa-automation)',
  },
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === '-d') {
      flags.bg = true;
    } else {
      positional.push(arg);
    }
  }
  return { cmd: positional[0] || 'start', positional, flags };
}

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body || '{}') });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function findListeningPids(port) {
  try {
    const out = execFileSync('lsof', ['-iTCP:' + String(port), '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function openBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.env.NODE_ENV === 'test') return;
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', url] : [url];
  try {
    const p = spawn(opener, args, { detached: true, stdio: 'ignore' });
    p.unref();
  } catch {
    // ignore headless environment
  }
}

async function waitUntilHealthy(port, maxWaitMs = 12000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpGetJson(`http://127.0.0.1:${port}/api/state`, 1500);
      if (res.status === 200) return res.data;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function stopPort(port) {
  const pids = findListeningPids(port);
  if (pids.length === 0) {
    console.log(`PR Review Hub is not running on port ${port}.`);
    return false;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && findListeningPids(port).length > 0) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const remaining = findListeningPids(port);
  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  console.log(`Stopped PR Review Hub on port ${port} (PID: ${pids.join(', ')}).`);
  return true;
}

async function startBackground({ port, envOverrides = {}, logDir, noOpen = false, bannerLabel = '' }) {
  const existingPids = findListeningPids(port);
  if (existingPids.length > 0) {
    const state = await waitUntilHealthy(port, 1200);
    console.log(
      `🟢 PR Review Hub is already running on http://localhost:${port} (PID ${existingPids.join(', ')})${
        state?.config?.teamProfile ? ` · Profile: ${state.config.teamProfile}` : ''
      }`
    );
    if (!noOpen) openBrowser(`http://localhost:${port}`);
    return;
  }

  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, '.hub-daemon.log');
  const pidFile = path.join(logDir, '.hub-daemon.pid');
  const outFd = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SKILL_ROOT,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: {
      ...process.env,
      PORT: String(port),
      NO_OPEN: '1',
      ...envOverrides,
    },
  });
  child.unref();
  fs.closeSync(outFd);
  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');

  const state = await waitUntilHealthy(port, 12000);
  if (!state) {
    console.error(`🔴 PR Review Hub failed to start on port ${port}. Check logs: ${logFile}`);
    process.exit(1);
  }

  console.log('============================================================');
  console.log(`🚀 PR Review Hub ${bannerLabel ? `(${bannerLabel}) ` : ''}is live!`);
  console.log(`   • URL          : http://localhost:${port}`);
  console.log(`   • PID          : ${child.pid}`);
  console.log(`   • GitHub User  : @${state.config?.githubUser || 'unknown'}`);
  console.log(`   • Team Profile : ${state.config?.teamProfile || 'popcorn-back'}`);
  console.log(`   • Role         : ${state.config?.hubRole || 'reader'}`);
  console.log(`   • Logs         : ${logFile}`);
  console.log('============================================================');

  if (!noOpen) {
    openBrowser(`http://localhost:${port}`);
  }
}

async function runDoctorCommand() {
  const cfg = ensureConfigBootstrapped();
  const report = await runDoctor(cfg);
  console.log(`PR Review Hub Doctor — ${report.platform}`);
  console.log('------------------------------------------------------------');
  for (const c of report.checks) {
    const icon = c.ok ? (c.optional ? '🔵' : '🟢') : '🔴';
    console.log(`${icon} ${c.label} — ${c.detail}`);
    if (!c.ok && c.fixHint) {
      console.log(`   ↳ Fix: ${c.fixHint}`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}

async function runStatusCommand(port) {
  const pids = findListeningPids(port);
  if (pids.length === 0) {
    console.log(`⚪ PR Review Hub is stopped on port ${port}. Run "npm run start:bg" to launch it.`);
    return;
  }
  const state = await waitUntilHealthy(port, 1500);
  if (!state) {
    console.log(`🟡 Process listening on port ${port} (PID ${pids.join(', ')}), awaiting HTTP readiness.`);
    return;
  }
  console.log(`🟢 PR Review Hub running at http://localhost:${port} (PID ${pids.join(', ')})`);
  console.log(`   • Version      : v${state.version || '1.3.0'}`);
  console.log(`   • User / Teams : @${state.config?.githubUser} · ${(state.config?.githubTeams || []).join(', ') || 'none'}`);
  console.log(`   • Team Profile : ${state.config?.teamProfile}`);
  console.log(`   • Mode         : ${state.config?.hubRole === 'worker' ? 'Dedicated Worker' : 'Teammate Standalone / Reader'}`);
  console.log(`   • Open PRs     : ${(state.prs || []).length}`);
}

async function runSimulateCommand(flags) {
  const rawTeam = String(flags.team || 'pili-back').trim().toLowerCase();
  const preset = TEAM_SIMULATION_PRESETS[rawTeam] || {
    profile: rawTeam,
    teams: flags.teams || rawTeam,
    label: `Simulated Colleague (${rawTeam})`,
  };
  const port = Number(flags.port || process.env.SIM_PORT || 4243);

  if (flags.stop) {
    await stopPort(port);
    return;
  }

  const sandboxRoot =
    flags.dir || path.join(os.homedir(), '.cache', 'pr-review-hub-sim', preset.profile);
  const simConfigPath = path.join(sandboxRoot, 'config.json');
  const simReviewsDir = path.join(sandboxRoot, 'reviews');

  if (flags.reset || !fs.existsSync(simConfigPath)) {
    await stopPort(port);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fs.mkdirSync(simReviewsDir, { recursive: true });
  } else if (flags.restart) {
    await stopPort(port);
  }

  const envOverrides = {
    REVIEW_HUB_CONFIG: simConfigPath,
    REVIEWS_DIR: simReviewsDir,
    REVIEW_HUB_ROLE: 'reader',
    REVIEW_HUB_TEAMS: String(flags.teams || preset.teams),
  };
  if (flags.user) {
    envOverrides.REVIEW_HUB_USER = String(flags.user);
  }

  await startBackground({
    port,
    envOverrides,
    logDir: sandboxRoot,
    noOpen: Boolean(flags['no-open']),
    bannerLabel: `Colleague Simulation · ${preset.label}`,
  });
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const port = Number(flags.port || process.env.PORT || cfg.port || 4242);

  if (cmd === 'doctor') {
    await runDoctorCommand();
    return;
  }
  if (cmd === 'stop') {
    await stopPort(port);
    return;
  }
  if (cmd === 'status') {
    await runStatusCommand(port);
    return;
  }
  if (cmd === 'simulate') {
    await runSimulateCommand(flags);
    return;
  }
  if (cmd === 'help' || flags.help) {
    console.log(`Usage: pr-review-hub <command> [options]

Commands:
  start [--bg] [--port 4242] [--no-open]            Start PR Review Hub (foreground or background daemon)
  stop [--port 4242]                                Stop running background daemon
  status [--port 4242]                              Show running server status
  doctor                                            Verify Node, Git, gh, AI CLI, Jira CLI & rules
  simulate [--team pili-back] [--port 4243] [--reset] [--stop]
                                                    Launch an isolated brand-new colleague setup simulation
`);
    return;
  }

  if (flags.bg) {
    const bootstrapped = ensureConfigBootstrapped();
    await startBackground({
      port,
      logDir: bootstrapped.reviewsDir,
      noOpen: Boolean(flags['no-open']),
    });
    return;
  }

  // Foreground start
  process.env.PORT = String(port);
  if (flags['no-open']) process.env.NO_OPEN = '1';
  await import(SERVER_ENTRY);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
