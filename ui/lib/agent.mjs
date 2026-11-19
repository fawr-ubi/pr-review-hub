import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { SKILL_ROOT, findCliBinaryPath } from './config.mjs';
import { parseFindingsFromMarkdown } from './parser.mjs';
import { extractJiraKey } from './metadata.mjs';
import { getLocalRepoPath, getProjectsDir } from './worktree.mjs';
import {
  getReferencePaths,
  getSharedReviewRulesBundle,
  getPersonalReviewRulesBundle,
  syncCombinedReferenceFiles,
  buildRulesLookupMap,
} from './rules.mjs';
import {
  saveReviewArtifact,
  getReviewArtifact,
  recordSharedFindingAction,
  pushSharedStore,
} from './store.mjs';
import {
  loadDomainAgentCatalog,
  normalizeDomainId,
  normalizeDomainAgentsConfig,
  inferDomainForFinding,
  computeBoundedScorecard,
  parseScorecardBlockFromMarkdown,
  upsertScorecardInMarkdown,
} from './scoring.mjs';
import { resolveProductContextForPr } from './jira.mjs';
import { ensureWanreviewRepoSynced } from './wanreview.mjs';

const execFileAsync = promisify(execFile);

const activeJobs = new Map();
const activeChatStreams = new Map();
let customAgentRunner = null;

export function setCustomAgentRunnerForTests(fn) {
  customAgentRunner = fn;
}

export function getPrChatStatus(prKey) {
  return activeChatStreams.get(prKey) || null;
}

export function getAgentJobs() {
  return [...activeJobs.values()].sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || ''))
  );
}

function getChatsDir(reviewsDir) {
  const dir = path.join(reviewsDir, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getChatFilePath(reviewsDir, repo, number) {
  const safeRepo = path.basename(String(repo || ''));
  return path.join(getChatsDir(reviewsDir), `chat-${safeRepo}-${Number(number)}.json`);
}

export function getPrChatHistory(reviewsDir, repo, number) {
  const filePath = getChatFilePath(reviewsDir, repo, number);
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data.messages) ? data.messages : [];
  } catch {
    return [];
  }
}

export function appendPrChatMessage(reviewsDir, repo, number, msg) {
  const filePath = getChatFilePath(reviewsDir, repo, number);
  const current = getPrChatHistory(reviewsDir, repo, number);
  const entry = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    ...msg,
  };
  current.push(entry);
  fs.writeFileSync(filePath, JSON.stringify({ messages: current }, null, 2), 'utf8');
  return entry;
}

export function resolveAgentBinary(preferredCli = 'agy') {
  const normalized = ['agy', 'gemini', 'claude'].includes(preferredCli) ? preferredCli : 'agy';
  const order = [normalized, ...['agy', 'gemini', 'claude'].filter((c) => c !== normalized)];

  for (const candidate of order) {
    const binPath = findCliBinaryPath(candidate);
    if (binPath) {
      return { cli: candidate, bin: binPath };
    }
  }
  throw new Error(
    `No AI Agent CLI ('agy', 'gemini', or 'claude') was found in PATH. Install Antigravity CLI ('agy'), Gemini CLI ('npm install -g @google/gemini-cli'), or Claude Code CLI ('claude'), then retry.`
  );
}

function summarizeFindings(findings = []) {
  let blk = 0;
  let maj = 0;
  let min = 0;
  let nit = 0;
  for (const f of findings) {
    const s = String(f.severity || '');
    if (s.includes('🔴') || /blocker/i.test(s)) blk++;
    else if (s.includes('🟠') || /major/i.test(s)) maj++;
    else if (s.includes('🟡') || /minor|suggestion/i.test(s)) min++;
    else nit++;
  }
  return `${blk} 🔴, ${maj} 🟠, ${min} 🟡, ${nit} 🔵`;
}

function inferVerdictFromFindings(findings = [], rawMarkdown = '') {
  if (/Ready to Approve/i.test(rawMarkdown)) return '🟢 Ready to Approve';
  if (/Changes Requested|Request Changes/i.test(rawMarkdown)) return '🔴 Changes Requested';
  if (/Approve with Suggestions/i.test(rawMarkdown)) return '🟡 Approve with Suggestions';
  const hasBlocker = findings.some((f) => String(f.severity).includes('🔴'));
  const hasMajor = findings.some((f) => String(f.severity).includes('🟠'));
  if (hasBlocker) return '🔴 Changes Requested';
  if (hasMajor) return '🟠 Request Changes';
  if (findings.length > 0) return '🟡 Approve with Suggestions';
  return '🟢 Ready to Approve';
}

function cleanReviewMarkdownOutput(rawText = '') {
  let text = String(rawText || '').trim();
  if (!text) return '';

  // Strip outer ```markdown ... ``` fence if the LLM wrapped the whole document
  const fencedMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fencedMatch) {
    text = fencedMatch[1].trim();
  }

  // Strip any Gemini CLI startup banner lines before the first Markdown heading
  const firstHeadingIdx = text.search(/^#{1,2}\s+(?:Code Review|\d+\.\s+Task Summary)/m);
  if (firstHeadingIdx > 0) {
    text = text.slice(firstHeadingIdx).trim();
  } else {
    const anyHeadingIdx = text.search(/^#{1,3}\s+/m);
    if (anyHeadingIdx > 0) {
      text = text.slice(anyHeadingIdx).trim();
    }
  }
  return text;
}

function isTransientApiError(errMsg) {
  const e = String(errMsg).toLowerCase();
  return (
    e.includes('quota') ||
    e.includes('503') ||
    e.includes('504') ||
    e.includes('502') ||
    e.includes('500') ||
    e.includes('unavailable') ||
    e.includes('429') ||
    e.includes('exhausted')
  );
}

export function isAgentAuthError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  return (
    e.includes('authentication required') ||
    e.includes('authentication expired') ||
    e.includes('authentication timed out') ||
    e.includes('authentication failed') ||
    e.includes('waiting for authentication') ||
    e.includes('please sign in')
  );
}

function isRetryableCliError(errMsg) {
  if (isAgentAuthError(errMsg)) return false;
  const e = String(errMsg).toLowerCase();
  return (
    isTransientApiError(e) ||
    e.includes('stalled') ||
    e.includes('exited with code') ||
    e.includes('econnreset') ||
    e.includes('etimedout') ||
    e.includes('socket hang up')
  );
}

let activeAgyOAuth = null;

function cleanupActiveAgyOAuth() {
  if (!activeAgyOAuth) return;
  if (activeAgyOAuth.cleanupTimer) clearTimeout(activeAgyOAuth.cleanupTimer);
  try {
    activeAgyOAuth.child?.stdin?.destroy();
    activeAgyOAuth.child?.kill('SIGTERM');
  } catch {
    // ignore
  }
  activeAgyOAuth = null;
}

const AGY_PTY_BRIDGE_SCRIPT = [
  'import os, pty, select, signal, sys',
  'bin_path = sys.argv[1]',
  'args = [bin_path, "--dangerously-skip-permissions", "--disable-slash-commands", "--output-format", "stream-json", "--effort", "low", "-p", "Reply OK"]',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execv(bin_path, args)',
  'def _terminate(*_):',
  '    try: os.kill(pid, signal.SIGTERM)',
  '    except Exception: pass',
  '    sys.exit(0)',
  'signal.signal(signal.SIGTERM, _terminate)',
  'signal.signal(signal.SIGINT, _terminate)',
  'stdin_open = True',
  'while True:',
  '    watch = [fd] + ([0] if stdin_open else [])',
  '    try:',
  '        r, _, _ = select.select(watch, [], [], 0.2)',
  '    except Exception:',
  '        break',
  '    if fd in r:',
  '        try:',
  '            data = os.read(fd, 4096)',
  '            if not data: break',
  '            os.write(1, data)',
  '        except OSError:',
  '            break',
  '    if 0 in r:',
  '        try:',
  '            inp = os.read(0, 4096)',
  '            if not inp:',
  '                stdin_open = False',
  '            else:',
  '                os.write(fd, inp)',
  '        except OSError:',
  '            stdin_open = False',
  '_, status = os.waitpid(pid, 0)',
  'sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))',
].join('\n');

export async function startAgyOAuthSession({ _customBinPath = '' } = {}) {
  cleanupActiveAgyOAuth();
  const bin = _customBinPath || resolveAgentBinary('agy').bin;

  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-u', '-c', AGY_PTY_BRIDGE_SCRIPT, bin], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let combined = '';
    let urlResolved = false;
    let authSucceeded = false;
    let authWaiter = null;

    const cleanupTimer = setTimeout(() => {
      cleanupActiveAgyOAuth();
    }, 60000);
    cleanupTimer.unref?.();

    const session = {
      child,
      authUrl: '',
      expiresAt: Date.now() + 58000,
      cleanupTimer,
      getCombined: () => combined,
      setAuthWaiter: (w) => {
        authWaiter = w;
      },
      isAuthenticated: () => authSucceeded,
    };
    activeAgyOAuth = session;

    const startupTimer = setTimeout(() => {
      if (!urlResolved) {
        urlResolved = true;
        cleanupActiveAgyOAuth();
        reject(new Error('Timed out waiting for Antigravity CLI (agy) sign-in URL'));
      }
    }, 10000);

    const inspectOutput = (chunk) => {
      combined += chunk.toString('utf8');
      // Strip ANSI CSI sequences and carriage returns for clean URL & event matching
      const clean = combined.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

      if (
        clean.includes('"event":"init"') ||
        clean.includes('"event": "init"') ||
        clean.includes('"status":"SUCCESS"') ||
        /authentication successful|successfully logged in/i.test(clean)
      ) {
        authSucceeded = true;
        if (!urlResolved) {
          urlResolved = true;
          clearTimeout(startupTimer);
          cleanupActiveAgyOAuth();
          resolve({ ok: true, authRequired: false, authenticated: true });
          return;
        }
        if (authWaiter) {
          const w = authWaiter;
          authWaiter = null;
          cleanupActiveAgyOAuth();
          w.resolve({ ok: true, authenticated: true });
          return;
        }
      }

      if (!urlResolved) {
        // Wait until the full prompt line ("Enter:") arrives so a wrapped URL is never truncated mid-chunk
        const urlMatch = clean.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+/);
        if (urlMatch && (clean.includes('Enter:') || clean.includes('Waiting for authentication'))) {
          urlResolved = true;
          clearTimeout(startupTimer);
          session.authUrl = urlMatch[0].trim();
          session.expiresAt = Date.now() + 57000;
          resolve({
            ok: true,
            authRequired: true,
            authenticated: false,
            authUrl: session.authUrl,
            expiresAt: session.expiresAt,
          });
        }
      } else if (
        authWaiter &&
        /invalid_grant|authentication failed|authentication timed out|malformed auth code/i.test(
          clean
        )
      ) {
        const w = authWaiter;
        authWaiter = null;
        cleanupActiveAgyOAuth();
        w.reject(
          new Error(
            'Authorization code was rejected or expired. Click "Generate Fresh Link" and paste the new code within 60s.'
          )
        );
      }
    };

    child.stdout.on('data', inspectOutput);
    child.stderr.on('data', inspectOutput);

    child.on('error', (err) => {
      clearTimeout(startupTimer);
      if (!urlResolved) {
        urlResolved = true;
        cleanupActiveAgyOAuth();
        reject(err);
      } else if (authWaiter) {
        const w = authWaiter;
        authWaiter = null;
        cleanupActiveAgyOAuth();
        w.reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(startupTimer);
      if (authSucceeded) {
        if (authWaiter) {
          const w = authWaiter;
          authWaiter = null;
          cleanupActiveAgyOAuth();
          w.resolve({ ok: true, authenticated: true });
        }
        return;
      }
      if (!urlResolved) {
        urlResolved = true;
        cleanupActiveAgyOAuth();
        if (code === 0) {
          resolve({ ok: true, authRequired: false, authenticated: true });
        } else {
          reject(
            new Error(
              `Antigravity CLI (agy) exited with code ${code}: ${combined.trim().slice(-300)}`
            )
          );
        }
      } else if (authWaiter) {
        const w = authWaiter;
        authWaiter = null;
        cleanupActiveAgyOAuth();
        if (code === 0) {
          w.resolve({ ok: true, authenticated: true });
        } else {
          w.reject(
            new Error(
              'Authorization failed or timed out. Click "Generate Fresh Link" and submit the new code within 60s.'
            )
          );
        }
      }
    });
  });
}

export async function submitAgyOAuthCode(code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) {
    throw new Error('Authorization code is required');
  }
  if (!activeAgyOAuth || !activeAgyOAuth.child || Date.now() > activeAgyOAuth.expiresAt) {
    cleanupActiveAgyOAuth();
    throw new Error(
      'Sign-in session expired (60s PKCE window). Click "Generate Fresh Link" first, then paste the new code.'
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let modelPollTimer = null;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(verifyTimer);
      if (modelPollTimer) clearInterval(modelPollTimer);
      if (err) reject(err);
      else resolve(val);
    };

    const verifyTimer = setTimeout(() => {
      cleanupActiveAgyOAuth();
      finish(new Error('Timed out verifying authorization code with Antigravity CLI (agy).'));
    }, 25000);

    activeAgyOAuth.setAuthWaiter({
      resolve: (val) => finish(null, val),
      reject: (err) => finish(err),
    });

    // Fast parallel check: as soon as `agy` writes the exchanged token to disk, `agy models` exits 0
    const agyBin = resolveAgentBinary('agy').bin;
    modelPollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const { stdout, stderr } = await execFileAsync(agyBin, ['models'], { timeout: 3500 });
        if (!/please sign in|authentication required/i.test(`${stdout || ''}\n${stderr || ''}`)) {
          cleanupActiveAgyOAuth();
          finish(null, { ok: true, authenticated: true });
        }
      } catch {
        // still exchanging token or rejected
      }
    }, 2000);
    modelPollTimer.unref?.();

    try {
      activeAgyOAuth.child.stdin.write(`${trimmed}\r\n`);
    } catch (err) {
      cleanupActiveAgyOAuth();
      finish(new Error(`Failed to send authorization code to CLI: ${err.message}`));
    }
  });
}

export async function runCliPrompt(args) {
  const maxRetries = args.maxRetries ?? 1;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      return await _runCliPromptInternal(args);
    } catch (err) {
      if (attempt < maxRetries && isRetryableCliError(err.message)) {
        attempt++;
        args.onStreamUpdate?.({
          phase: `⚠️ CLI stall/error (${err.message}). Auto-retrying (${attempt + 1}/${maxRetries + 1})…`,
          partialText: '',
        });
        continue;
      }
      throw err;
    }
  }
}

function attachDualTimeoutTimers({ child, cliLabel, timeoutMs, inactivityTimeoutMs, onReject }) {
  let settled = false;
  let inactivityTimer = null;

  const terminateChild = () => {
    try {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2000);
      forceTimer.unref?.();
    } catch {
      // ignore
    }
  };

  const formatDuration = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

  const wallTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    terminateChild();
    onReject(new Error(`${cliLabel} timeout exceeded (${formatDuration(timeoutMs)})`));
  }, timeoutMs);

  const resetHeartbeat = () => {
    if (settled || !inactivityTimeoutMs || inactivityTimeoutMs <= 0) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      terminateChild();
      onReject(
        new Error(`${cliLabel} stalled with no output for ${formatDuration(inactivityTimeoutMs)}`)
      );
    }, inactivityTimeoutMs);
  };

  const clearAll = () => {
    settled = true;
    clearTimeout(wallTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
  };

  resetHeartbeat();
  return { resetHeartbeat, clearAll, isSettled: () => settled };
}

async function _runCliPromptInternal({
  prompt,
  cwd,
  agentCli = 'agy',
  approvalMode = 'yolo',
  timeoutMs = 420000,
  inactivityTimeoutMs = 210000,
  fastChatMode = false,
  includeDirs = [],
  onStreamUpdate = null,
  _customBinPath = '',
}) {
  if (customAgentRunner && !_customBinPath) {
    if (onStreamUpdate) {
      onStreamUpdate({ phase: 'Running agent…', partialText: '' });
    }
    return customAgentRunner({ prompt, cwd, approvalMode, agentCli });
  }

  const { cli, bin } = _customBinPath
    ? { cli: ['agy', 'gemini', 'claude'].includes(agentCli) ? agentCli : 'agy', bin: _customBinPath }
    : resolveAgentBinary(agentCli);
  const workingDir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const validIncludeDirs = includeDirs.filter((d) => d && fs.existsSync(d));

  // Antigravity CLI (`agy`) — first-class default agent runner
  if (cli === 'agy') {
    return new Promise((resolve, reject) => {
      const useStdin = prompt.length > 4000;
      const dirsToAdd = [...validIncludeDirs];

      const args = [
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        '--output-format',
        'stream-json',
      ];
      for (const dir of dirsToAdd) {
        args.push('--add-dir', dir);
      }
      if (!useStdin) {
        args.push('-p', prompt);
      }

      const child = spawn(bin, args, {
        cwd: workingDir,
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });

      if (useStdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      let partialText = '';
      let finalResponse = '';
      let rawStdout = '';
      let rawStderr = '';
      let lineBuffer = '';

      const timers = attachDualTimeoutTimers({
        child,
        cliLabel: 'Antigravity CLI (agy)',
        timeoutMs,
        inactivityTimeoutMs,
        onReject: reject,
      });

      const processAgyJsonLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.event === 'init') {
            onStreamUpdate?.({
              phase: 'Antigravity (agy) initialized — analyzing code and diff…',
              partialText,
            });
          } else if (evt.event === 'step_update' && evt.step_update) {
            const su = evt.step_update;
            if (su.step_type === 'tool_call' || su.tool_name) {
              const toolLabel = su.tool_name || 'tool';
              onStreamUpdate?.({
                phase: `Inspecting (${toolLabel})…`,
                partialText,
                toolName: toolLabel,
              });
            } else if (su.step_type === 'agent_response' && typeof su.text_delta === 'string') {
              partialText += su.text_delta;
              onStreamUpdate?.({
                phase: fastChatMode ? 'Streaming response…' : 'Generating review report…',
                partialText,
              });
            }
          } else if (evt.event === 'result' && evt.result) {
            if (typeof evt.result.response === 'string' && evt.result.response.trim()) {
              finalResponse = evt.result.response.trim();
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      };

      const failIfAuthPrompt = () => {
        if (timers.isSettled()) return true;
        if (
          /Authentication required\. Please visit|Waiting for authentication|Please sign in/i.test(
            `${rawStdout}\n${rawStderr}`
          )
        ) {
          timers.clearAll();
          try {
            child.stdin?.destroy();
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          reject(
            new Error(
              'Antigravity CLI (agy) authentication required. Click "Sign in to Antigravity (agy)" to reconnect.'
            )
          );
          return true;
        }
        return false;
      };

      child.stdout.on('data', (chunk) => {
        timers.resetHeartbeat();
        const str = chunk.toString('utf8');
        rawStdout += str;
        if (failIfAuthPrompt()) return;
        lineBuffer += str;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const l of lines) {
          processAgyJsonLine(l);
        }
      });

      child.stderr.on('data', (chunk) => {
        timers.resetHeartbeat();
        rawStderr += chunk.toString('utf8');
        failIfAuthPrompt();
      });

      child.on('error', (err) => {
        if (timers.isSettled()) return;
        timers.clearAll();
        reject(err);
      });

      child.on('close', (code) => {
        if (timers.isSettled()) return;
        timers.clearAll();
        if (lineBuffer) processAgyJsonLine(lineBuffer);
        const out = finalResponse || partialText.trim();
        if (out) {
          resolve(out);
        } else if (code === 0 && rawStdout.trim()) {
          resolve(rawStdout.trim());
        } else {
          const errSnippet = rawStderr.trim().slice(-400) || rawStdout.trim().slice(-400);
          reject(
            new Error(
              `Antigravity CLI (agy) exited with code ${code}${errSnippet ? `: ${errSnippet}` : ''}`
            )
          );
        }
      });
    });
  }

  if (cli === 'claude') {
    return new Promise((resolve, reject) => {
      const useStdin = prompt.length > 4000;
      const args = [
        '-p',
        useStdin
          ? 'Follow the instructions provided on stdin and output the requested response.'
          : prompt,
      ];
      if (approvalMode === 'yolo' || approvalMode === 'auto_edit') {
        args.push('--dangerously-skip-permissions');
      }
      for (const dir of validIncludeDirs) {
        args.push('--add-dir', dir);
      }

      const child = spawn(bin, args, {
        cwd: workingDir,
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const timers = attachDualTimeoutTimers({
        child,
        cliLabel: 'Claude CLI',
        timeoutMs,
        inactivityTimeoutMs,
        onReject: reject,
      });

      if (useStdin && child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      child.stdout.on('data', (chunk) => {
        timers.resetHeartbeat();
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        timers.resetHeartbeat();
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        if (timers.isSettled()) return;
        timers.clearAll();
        reject(err);
      });
      child.on('close', (code) => {
        if (timers.isSettled()) return;
        timers.clearAll();
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(
            new Error(
              `Claude CLI exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`
            )
          );
        }
      });
    });
  }

  // Gemini CLI (both review and interactive Q&A use stream-json + --skip-trust + no slow MCP servers)
  return new Promise((resolve, reject) => {
    const useStdin = prompt.length > 4000;
    const args = [
      '-p',
      useStdin
        ? 'Execute the instructions provided on stdin and output the full response.'
        : prompt,
      '--skip-trust',
      '--approval-mode',
      approvalMode,
      '-o',
      'stream-json',
      '--allowed-mcp-server-names',
      'none',
      '-e',
      'none',
    ];
    for (const dir of validIncludeDirs) {
      args.push('--include-directories', dir);
    }

    const child = spawn(bin, args, {
      cwd: workingDir,
      stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (useStdin && child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    let partialText = '';
    let rawStdout = '';
    let rawStderr = '';
    let lineBuffer = '';

    const timers = attachDualTimeoutTimers({
      child,
      cliLabel: 'Gemini CLI',
      timeoutMs,
      inactivityTimeoutMs,
      onReject: reject,
    });

    const processJsonLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === 'init') {
          onStreamUpdate?.({
            phase: 'Model initialized — analyzing code and diff…',
            partialText,
          });
        } else if (evt.type === 'tool_use' || evt.tool_name) {
          const toolLabel = evt.tool_name || evt.name || 'tool';
          onStreamUpdate?.({
            phase: `Inspecting (${toolLabel})…`,
            partialText,
            toolName: toolLabel,
          });
        } else if (
          evt.type === 'message' &&
          evt.role === 'assistant' &&
          typeof evt.content === 'string'
        ) {
          if (evt.delta) {
            partialText += evt.content;
          } else {
            partialText = evt.content;
          }
          onStreamUpdate?.({
            phase: fastChatMode ? 'Streaming response…' : 'Generating review report…',
            partialText,
          });
        }
      } catch {
        // Ignore non-JSON warning lines
      }
    };

    child.stdout.on('data', (chunk) => {
      timers.resetHeartbeat();
      const str = chunk.toString('utf8');
      rawStdout += str;
      lineBuffer += str;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const l of lines) {
        processJsonLine(l);
      }
    });

    child.stderr.on('data', (chunk) => {
      timers.resetHeartbeat();
      rawStderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (timers.isSettled()) return;
      timers.clearAll();
      reject(err);
    });

    child.on('close', (code) => {
      if (timers.isSettled()) return;
      timers.clearAll();
      if (lineBuffer) processJsonLine(lineBuffer);
      if (partialText.trim()) {
        resolve(partialText.trim());
      } else if (code === 0 && rawStdout.trim()) {
        resolve(rawStdout.trim());
      } else {
        const errSnippet = rawStderr.trim().slice(-400) || rawStdout.trim().slice(-400);
        reject(
          new Error(
            `Gemini CLI exited with code ${code}${errSnippet ? `: ${errSnippet}` : ''}`
          )
        );
      }
    });
  });
}

async function fetchPrContextFromGithub(cfg, pr, repoPath = '') {
  if (customAgentRunner) {
    return {
      headSha: pr.headRefOid || pr.lastReviewedSha || 'HEAD',
      prBody: '',
      diffText: '',
      changedFilesList: [],
    };
  }
  const repoSlug = `${cfg.githubOrg}/${pr.repo}`;
  const [viewRes, diffRes] = await Promise.all([
    execFileAsync(
      'gh',
      [
        'pr',
        'view',
        String(pr.number),
        '--repo',
        repoSlug,
        '--json',
        'title,body,baseRefName,headRefName,headRefOid,author,files',
      ],
      { maxBuffer: 15 * 1024 * 1024, timeout: 25000 }
    ).catch(() => ({ stdout: '{}' })),
    execFileAsync('gh', ['pr', 'diff', String(pr.number), '--repo', repoSlug], {
      maxBuffer: 25 * 1024 * 1024,
      timeout: 45000,
    }).catch(() => ({ stdout: '' })),
  ]);

  let parsed = {};
  try {
    parsed = JSON.parse(viewRes.stdout || '{}');
  } catch {
    parsed = {};
  }

  const headSha = parsed.headRefOid || pr.headRefOid || pr.lastReviewedSha || 'HEAD';
  const prBody = String(parsed.body || '').trim();
  const changedFilesList = Array.isArray(parsed.files)
    ? parsed.files.map((f) => `${f.path} (+${f.additions || 0}/-${f.deletions || 0})`)
    : [];
  let diffText = String(diffRes.stdout || '').trim();

  // Fallback 1: Reconstruct unified diff from GitHub REST /files patches if `gh pr diff` timed out
  if (!diffText) {
    try {
      const filesRes = await execFileAsync(
        'gh',
        ['api', `repos/${repoSlug}/pulls/${pr.number}/files?per_page=100`],
        { maxBuffer: 20 * 1024 * 1024, timeout: 25000 }
      );
      const filesArr = JSON.parse(filesRes.stdout || '[]');
      if (Array.isArray(filesArr) && filesArr.length > 0) {
        diffText = filesArr
          .filter((f) => f && f.filename && f.patch)
          .map(
            (f) =>
              `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`
          )
          .join('\n\n');
      }
    } catch {
      // ignore REST fallback failure
    }
  }

  // Fallback 2: Local git branch range or commit diff if available on disk
  const baseBranch = parsed.baseRefName || pr.baseRefName || '';
  if (!diffText && repoPath && fs.existsSync(repoPath) && headSha && headSha !== 'HEAD') {
    if (baseBranch) {
      try {
        const rangeDiffRes = await execFileAsync(
          'git',
          ['-C', repoPath, 'diff', '--unified=3', `origin/${baseBranch}...${headSha}`],
          { maxBuffer: 20 * 1024 * 1024, timeout: 15000 }
        );
        diffText = String(rangeDiffRes.stdout || '').trim();
      } catch {
        // ignore un-fetched ref
      }
    }
    if (!diffText) {
      try {
        const localDiffRes = await execFileAsync(
          'git',
          ['-C', repoPath, 'show', '--format=', '--unified=3', headSha],
          { maxBuffer: 20 * 1024 * 1024, timeout: 15000 }
        );
        diffText = String(localDiffRes.stdout || '').trim();
      } catch {
        // ignore local git fallback failure
      }
    }
  }

  if (!customAgentRunner && !diffText && changedFilesList.length === 0) {
    throw new Error(
      'GitHub diff unavailable (API 502 or network error) — will retry automatically on next sync'
    );
  }

  return {
    headSha,
    prBody,
    diffText,
    changedFilesList,
  };
}

async function loadTargetRepoRuleContext(cfg, pr, repoPath = '', headSha = '') {
  const codeownersCandidates = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
  let codeownersContent = '';
  let repoAgentReviewDir = '';
  let repoLayerMarkdown = '';

  if (repoPath && fs.existsSync(repoPath)) {
    const hasGit = fs.existsSync(path.join(repoPath, '.git'));
    if (hasGit && headSha && headSha !== 'HEAD') {
      for (const relPath of codeownersCandidates) {
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['-C', repoPath, 'show', `${headSha}:${relPath}`],
            { timeout: 2500, maxBuffer: 1024 * 1024 }
          );
          if (stdout && stdout.trim()) {
            codeownersContent = stdout;
            break;
          }
        } catch {
          // try next candidate
        }
      }
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', repoPath, 'show', `${headSha}:.agent-review/_layer.md`],
          { timeout: 2500, maxBuffer: 512 * 1024 }
        );
        if (stdout && stdout.trim()) {
          repoLayerMarkdown = stdout;
        }
      } catch {
        // optional
      }
    }

    if (!codeownersContent) {
      for (const relPath of codeownersCandidates) {
        const diskFile = path.join(repoPath, relPath);
        if (fs.existsSync(diskFile)) {
          try {
            codeownersContent = fs.readFileSync(diskFile, 'utf8');
            if (codeownersContent.trim()) break;
          } catch {
            // ignore
          }
        }
      }
    }

    const diskAgentReviewDir = path.join(repoPath, '.agent-review');
    if (fs.existsSync(diskAgentReviewDir)) {
      repoAgentReviewDir = diskAgentReviewDir;
    }
  }

  if (!codeownersContent && !customAgentRunner && cfg?.githubOrg && pr?.repo) {
    const repoSlug = `${cfg.githubOrg}/${pr.repo}`;
    for (const relPath of ['.github/CODEOWNERS', 'CODEOWNERS']) {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['api', `repos/${repoSlug}/contents/${relPath}`, '--jq', '.content'],
          { timeout: 5000 }
        );
        const b64 = String(stdout || '').replace(/\s+/g, '');
        if (b64) {
          codeownersContent = Buffer.from(b64, 'base64').toString('utf8');
          if (codeownersContent.trim()) break;
        }
      } catch {
        // ignore missing CODEOWNERS on remote
      }
    }
  }

  return {
    codeownersContent,
    repoAgentReviewDir,
    repoLayerMarkdown,
  };
}

function formatFindingMarkdownBlock(finding, index) {
  const numId = `#${index + 1}`;
  const dom = inferDomainForFinding(finding);
  const title = String(finding.title || 'Finding').trim();
  const pathRef = finding.filePath
    ? finding.startLine
      ? `${finding.filePath}#L${finding.startLine}${
          finding.endLine && finding.endLine !== finding.startLine ? `-L${finding.endLine}` : ''
        }`
      : finding.filePath
    : '';
  const heading = pathRef
    ? `#### \`${numId}\` — [${title}](${pathRef})`
    : `#### \`${numId}\` — ${title}`;

  const cleanExplanation = String(finding.explanation || '')
    .replace(/^- \*\*Domain:\*\*\s*.+$/gim, '')
    .replace(/^- \*\*Rules?(?:\s+IDs?)?:\*\*\s*.+$/gim, '')
    .replace(/\*\*Ready-to-paste GitHub comment[\s\S]*$/i, '')
    .replace(/#{3,4}\s*Ready-to-paste GitHub comment[\s\S]*$/i, '')
    .trim();

  const lines = [heading, `- **Domain:** ${dom}`];
  const ruleIdsList =
    Array.isArray(finding.ruleIds) && finding.ruleIds.length > 0
      ? finding.ruleIds
      : finding.ruleId
      ? [finding.ruleId]
      : [];
  if (ruleIdsList.length > 0) {
    lines.push(`- **Rule:** ${ruleIdsList.map((id) => `\`${id}\``).join(', ')}`);
  }
  if (cleanExplanation) {
    if (/^- \*\*/.test(cleanExplanation)) {
      lines.push(cleanExplanation);
    } else {
      lines.push(`- **Why it matters:** ${cleanExplanation}`);
    }
  }
  if (finding.comment) {
    lines.push(`- **Ready-to-paste GitHub comment:**`);
    lines.push('````markdown');
    lines.push(String(finding.comment).trim());
    lines.push('````');
  }
  return lines.join('\n');
}

function rebuildReviewFindingsSection(baseMarkdown = '', mergedFindings = []) {
  const groups = [
    { emoji: '🔴', heading: '### 🔴 Blockers, Bugs & Functional Gaps', items: [] },
    { emoji: '🟠', heading: '### 🟠 Architecture, Security & Major Issues', items: [] },
    { emoji: '🟡', heading: '### 🟡 Clean Code, Strong Typing & Testing', items: [] },
    { emoji: '🔵', heading: '### 🔵 Nitpicks & Micro-Optimizations', items: [] },
    { emoji: '❓', heading: '### ❓ Domain / Edge-Case Questions', items: [] },
  ];
  const groupByEmoji = new Map(groups.map((g) => [g.emoji, g]));

  mergedFindings.forEach((f, idx) => {
    const sev = groupByEmoji.has(f.severity) ? f.severity : '🟡';
    groupByEmoji.get(sev).items.push(formatFindingMarkdownBlock(f, idx));
  });

  const nonEmptySections = groups
    .filter((g) => g.items.length > 0)
    .map((g) => `${g.heading}\n\n${g.items.join('\n\n---\n\n')}`);

  const replacementBody =
    nonEmptySections.length > 0
      ? `## 2. Review Findings\n\n${nonEmptySections.join('\n\n---\n\n')}\n`
      : `## 2. Review Findings\n\nNo findings detected across active domain agents.\n`;

  const cleanBase = String(baseMarkdown || '')
    .replace(/<!--\s*SCORECARD_JSON\s*[\s\S]*?\s*-->\r?\n?/gi, '')
    .trim();

  const hasSection2 = /^##\s+(?:2\.\s*)?(?:Review Findings|Detailed Findings)\b/im.test(cleanBase);
  if (hasSection2) {
    const lines = cleanBase.split(/\r?\n/);
    const out = [];
    let inSec2 = false;
    let replaced = false;
    for (const line of lines) {
      if (!replaced && /^##\s+(?:2\.\s*)?(?:Review Findings|Detailed Findings)\b/i.test(line)) {
        inSec2 = true;
        replaced = true;
        out.push(replacementBody.trim());
        continue;
      }
      if (inSec2 && /^##\s+(?:[3-9]\.|Debrief|Positives|Summary)\b/i.test(line)) {
        inSec2 = false;
        out.push('', line);
        continue;
      }
      if (!inSec2) {
        out.push(line);
      }
    }
    return `${out.join('\n').trim()}\n`;
  }

  return `${cleanBase}\n\n---\n\n${replacementBody}\n`;
}

export function createQueuedReviewJob({ pr, scope = 'shared', domain = '' }) {
  const prKey = `${pr.repo}#${pr.number}`;
  const normalizedScope = scope === 'personal' ? 'personal' : 'shared';
  const targetDomain = normalizeDomainId(domain) || '';
  const existing = [...activeJobs.values()].find(
    (j) =>
      j.prKey === prKey &&
      j.type === 'review' &&
      j.scope === normalizedScope &&
      (j.domain || '') === targetDomain &&
      (j.status === 'running' || j.status === 'queued')
  );
  if (existing) return existing;

  const jobId = `review-${pr.repo}-${pr.number}-${targetDomain || 'all'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id: jobId,
    prKey,
    repo: pr.repo,
    number: Number(pr.number),
    scope: normalizedScope,
    domain: targetDomain || null,
    type: 'review',
    status: 'queued',
    phase: targetDomain
      ? `Queued (${targetDomain} agent deep pass)…`
      : 'Queued in worker (waiting for active review)…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  activeJobs.set(jobId, job);
  return job;
}

export async function runPrReviewJob({
  cfg,
  pr,
  scope = 'shared',
  targetDomain = '',
  existingJob = null,
}) {
  const normalizedScope = scope === 'personal' ? 'personal' : 'shared';
  const singleDomainId = normalizeDomainId(targetDomain) || '';
  const job =
    existingJob ||
    createQueuedReviewJob({ pr, scope: normalizedScope, domain: singleDomainId });
  job.domain = singleDomainId || null;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.phase = singleDomainId
    ? `Fetching PR diff for ${singleDomainId} deep pass…`
    : 'Fetching PR diff and metadata from GitHub…';
  job.error = null;

  try {
    const projectsDir = getProjectsDir(cfg);
    const repoPath = getLocalRepoPath(projectsDir, pr.repo);
    fs.mkdirSync(cfg.reviewsDir, { recursive: true });
    const reviewFileName = `review-${pr.repo}-${pr.number}.md`;
    const reviewFilePath = path.join(cfg.reviewsDir, reviewFileName);
    const jiraKey = extractJiraKey(pr) || '—';

    const { headSha, prBody, diffText, changedFilesList } = await fetchPrContextFromGithub(
      cfg,
      pr,
      repoPath
    );

    let effectiveWanreviewPath = cfg.wanreviewRepoPath || '';
    if (!effectiveWanreviewPath || !fs.existsSync(path.join(effectiveWanreviewPath, 'rules'))) {
      const syncWan = await ensureWanreviewRepoSynced(cfg, {
        pull: false,
        allowAutoClone: Boolean(!customAgentRunner),
      });
      if (syncWan.available && syncWan.repoPath) {
        effectiveWanreviewPath = syncWan.repoPath;
      }
    }

    const repoRuleContext = await loadTargetRepoRuleContext(cfg, pr, repoPath, headSha);
    const ruleResolveOptions = {
      ...repoRuleContext,
      ...(effectiveWanreviewPath ? { wanreviewRepoPath: effectiveWanreviewPath } : {}),
    };

    const rulesBundle =
      normalizedScope === 'personal'
        ? getPersonalReviewRulesBundle(cfg.teamProfile, ruleResolveOptions)
        : getSharedReviewRulesBundle(cfg.teamProfile, ruleResolveOptions);
    const {
      activeTeam,
      wanreview: resolvedWanreview,
      rulesMarkdown: combinedRulesText,
      falsePositivesMarkdown: fpRulesText,
    } = rulesBundle;

    const readSafe = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '');
    const checklistText = readSafe(path.join(SKILL_ROOT, 'references/review-checklist.md'));
    const templateText = readSafe(path.join(SKILL_ROOT, 'assets/review-artifact-template.md'));

    const wanreviewScopeBadge = resolvedWanreview?.available
      ? ` wanreview Rules: ${resolvedWanreview.rules.length} active (${resolvedWanreview.vertical} / ${resolvedWanreview.team}, via ${resolvedWanreview.resolutionSource}).`
      : '';
    const teamContextLine = activeTeam
      ? `Active Team Profile: "${activeTeam.name}" (${activeTeam.id}) [Scope: ${normalizedScope.toUpperCase()}].${wanreviewScopeBadge} Tech Stack: ${(activeTeam.techStack || []).join(', ') || 'General'}.${activeTeam.agentInstructions ? ` Team Agent Focus: ${activeTeam.agentInstructions}` : ''}`
      : '';

    const maxDiffChars = 110000;
    const truncatedDiff =
      diffText.length > maxDiffChars
        ? `${diffText.slice(0, maxDiffChars)}\n\n[... Diff truncated at ${maxDiffChars} characters ...]`
        : diffText;

    const agentCatalog = loadDomainAgentCatalog();
    const agentsConfig = normalizeDomainAgentsConfig(cfg.domainAgents);
    const activeAgents = singleDomainId
      ? agentCatalog.filter((a) => a.id === singleDomainId)
      : agentCatalog.filter((a) => agentsConfig[a.id]?.enabled !== false);

    const shouldLoadProductContext = activeAgents.some((a) => a.id === 'product');
    const productContext = shouldLoadProductContext
      ? await resolveProductContextForPr({
          cfg,
          pr: { ...pr, jiraKey },
          prBody,
        })
      : null;

    const domainRubricBlock = activeAgents
      .map(
        (a) =>
          `### Agent [${a.id}] — ${a.title} (Weight: ${agentsConfig[a.id]?.weight ?? a.defaultWeight}%)\n- **Mission:** ${a.mission}\n- **When N/A:** ${a.applicability}\n- **Rubric:**\n${a.rubric}`
      )
      .join('\n\n');

    const scorecardJsonExample = JSON.stringify(
      {
        domains: Object.fromEntries(
          activeAgents.map((a) => [
            a.id,
            {
              applicable: a.id === 'product' && productContext ? Boolean(productContext.applicableHint) : true,
              rawScore: 90,
              summary: `One-sentence English assessment for ${a.shortLabel}.`,
            },
          ])
        ),
      },
      null,
      2
    );

    const prompt = singleDomainId
      ? [
          `Execute a focused SINGLE-DOMAIN DEEP AUDIT solely for the "${singleDomainId.toUpperCase()}" agent (${activeAgents[0]?.title || singleDomainId}) on PR ${cfg.githubOrg}/${pr.repo}#${pr.number} ("${pr.title || ''}", author: ${pr.author || 'unknown'}, head SHA: ${headSha}).`,
          teamContextLine,
          `FAST ZERO-WASTE SINGLE-AGENT MODE (CRITICAL):`,
          `1. Evaluate EXCLUSIVELY the "${singleDomainId}" domain rubric below. Ignore unrelated domains (other agents handle them separately).`,
          `2. DO NOT run \`gh\`, \`git\`, \`docker\`, tests, or ANY shell command (\`run_command\` is FORBIDDEN), and DO NOT call file-writing tools.`,
          `3. Every finding you report MUST include \`- **Domain:** ${singleDomainId}\` (and \`- **Rule:** \`<exact-wanreview-rule-id>\`\` in the metadata bullets when tied to an active \`[rule-id]\` rule, e.g. \`wfwp-backend.tenant-isolation\`) plus a single natural English "Ready-to-paste GitHub comment:" block (keep the ready-to-paste comment 100% human — NEVER append \`Triggered Rules:\` or bot headers inside the ready-to-paste comment).`,
          `4. At the very end of your Markdown output, you MUST append an HTML comment \`<!-- SCORECARD_JSON ... -->\` grading "${singleDomainId}" (\`applicable\`: boolean, \`rawScore\`: integer 0-100 or null if N/A, \`summary\`: concise 1-sentence justification).`,
          `Output 100% English Markdown starting with "# ${activeAgents[0]?.title || singleDomainId} Deep Audit: ${pr.repo}#${pr.number}" and "## 2. Review Findings". Never publish any comment to GitHub.`,
          `\n--- Target Domain Agent Rubric ---\n${domainRubricBlock}`,
          `\n--- Required Trailing Scorecard Block Format ---\n<!-- SCORECARD_JSON\n${scorecardJsonExample}\n-->`,
          productContext ? `\n--- Product & Jira Context ---\n${productContext.formattedPromptBlock}` : '',
          combinedRulesText
            ? `\n--- Active ${normalizedScope === 'personal' ? 'Personal & Team' : 'Shared Team'} DNA Rules ---\n${combinedRulesText.slice(0, 18000)}`
            : '',
          fpRulesText
            ? `\n--- Known False Positives (DO NOT FLAG THESE) ---\n${fpRulesText.slice(0, 8000)}`
            : '',
          prBody ? `\n--- PR Description ---\n${prBody.slice(0, 6000)}` : '',
          changedFilesList.length > 0
            ? `\n--- Modified Files (${changedFilesList.length}) ---\n${changedFilesList.join('\n')}`
            : '',
          truncatedDiff ? `\n--- Full Unified Git Diff ---\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : [
          `Execute a Mode 1 Multi-Domain code review for PR ${cfg.githubOrg}/${pr.repo}#${pr.number} ("${pr.title || ''}", author: ${pr.author || 'unknown'}, head SHA: ${headSha}).`,
          teamContextLine,
          `FAST ZERO-WASTE MODE (CRITICAL):`,
          `1. All active review rules, domain agent rubrics, false positives, review checklist, output template, PR/Jira context, and the full unified Git diff are ALREADY embedded inline below.`,
          `2. DO NOT read SKILL.md, DO NOT read reference rule files from disk, DO NOT run \`gh\`, \`git\`, \`docker\`, tests, or ANY shell command (\`run_command\` is FORBIDDEN), and DO NOT call file-writing tools.`,
          `3. LOCAL BRANCH WARNING: The local workspace directory is checked out on the developer's own working branch, NOT on this PR's head commit (${headSha}). Newly added or modified files in this PR will NOT match on disk — rely directly on the inline Unified Git Diff below.`,
          `4. STRICT TOOL BUDGET (HARD MAX: 3 READ-ONLY CALLS TOTAL): Only read an existing unchanged base class/interface on disk if strictly required to confirm a Blocker/Major contract bug, and NEVER exceed 3 file reads total. Synthesize and return your complete Markdown review immediately.`,
          `5. MULTI-DOMAIN SCORING & RULE CITATIONS: Tag EVERY finding with \`- **Domain:** <security|product|quality|performance|testing>\` (and \`- **Rule:** \`<exact-wanreview-rule-id>\`\` in the metadata bullets whenever a finding matches an active \`[rule-id]\` rule from \`wanreview\`, e.g. \`wfwp-backend.tenant-isolation\`), keep the \`Ready-to-paste GitHub comment:\` fence 100% natural human prose (NO \`Triggered Rules:\` footer or bot branding inside the comment), and append a trailing \`<!-- SCORECARD_JSON ... -->\` block at the very end evaluating each active domain (\`applicable\`, \`rawScore\` 0-100, \`summary\`).`,
          `Output the complete Markdown review report in 100% English directly as your response text, starting with "# Code Review: ${pr.repo}#${pr.number} — ${pr.title || ''}" and "## 1. Task Summary & Functional Problem Solved" (Business & Functional Problem Solved, Technical & Feature Solution, Jira & Scope Compliance), and providing a single English "Ready-to-paste GitHub comment:" block per finding.`,
          `Never publish any comment to GitHub.`,
          templateText ? `\n--- Output Markdown Template ---\n${templateText}` : '',
          domainRubricBlock ? `\n--- Active Multi-Domain Scoring Agents ---\n${domainRubricBlock}` : '',
          `\n--- Required Trailing Scorecard Block Format ---\n<!-- SCORECARD_JSON\n${scorecardJsonExample}\n-->`,
          productContext ? `\n--- Product & Jira Context ---\n${productContext.formattedPromptBlock}` : '',
          combinedRulesText
            ? `\n--- Active ${normalizedScope === 'personal' ? 'Personal & Team' : 'Shared Team'} DNA Rules ---\n${combinedRulesText.slice(0, 18000)}`
            : '',
          fpRulesText
            ? `\n--- Known False Positives (DO NOT FLAG THESE) ---\n${fpRulesText.slice(0, 8000)}`
            : '',
          checklistText ? `\n--- Review Checklist ---\n${checklistText}` : '',
          prBody ? `\n--- PR Description ---\n${prBody.slice(0, 6000)}` : '',
          changedFilesList.length > 0
            ? `\n--- Modified Files (${changedFilesList.length}) ---\n${changedFilesList.join('\n')}`
            : '',
          truncatedDiff ? `\n--- Full Unified Git Diff ---\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` : '',
        ]
          .filter(Boolean)
          .join('\n');

    const resolvedCliLabel = (() => {
      try {
        return resolveAgentBinary(cfg.agentCli || 'agy').cli;
      } catch {
        return cfg.agentCli || 'agy';
      }
    })();
    job.cli = resolvedCliLabel;
    job.phase = singleDomainId
      ? `Running ${singleDomainId} deep audit (${resolvedCliLabel})…`
      : `Running AI audit (${resolvedCliLabel})…`;

    // Snapshot previous mtime if file existed so a stale file on disk isn't mistaken for fresh output
    const prevMtimeMs = fs.existsSync(reviewFilePath) ? fs.statSync(reviewFilePath).mtimeMs : 0;

    const out = await runCliPrompt({
      prompt,
      cwd: repoPath,
      agentCli: cfg.agentCli || 'agy',
      approvalMode: 'yolo',
      timeoutMs: 420000,
      inactivityTimeoutMs: 60000,
      maxRetries: 1,
      includeDirs: [cfg.reviewsDir, repoPath].filter(Boolean),
      onStreamUpdate: ({ phase }) => {
        if (phase) job.phase = phase;
      },
    });

    let md = '';
    const cleanedOut = cleanReviewMarkdownOutput(out);
    if (cleanedOut && cleanedOut.includes('#')) {
      md = `${cleanedOut}\n`;
    } else if (fs.existsSync(reviewFilePath) && fs.statSync(reviewFilePath).mtimeMs > prevMtimeMs) {
      const diskContent = cleanReviewMarkdownOutput(fs.readFileSync(reviewFilePath, 'utf8'));
      if (diskContent) {
        md = `${diskContent}\n`;
      }
    }

    if (!md) {
      throw new Error(
        'AI CLI finished without producing a Markdown review report. Check your AGY / Gemini / Claude CLI authentication.'
      );
    }

    const nowIso = new Date().toISOString();
    const rulesLookup = buildRulesLookupMap(activeTeam?.id || cfg.teamProfile, ruleResolveOptions);
    const parsedScorecardBlock = parseScorecardBlockFromMarkdown(md);
    let finalFindings = [];
    let rawDomains = {};
    let previousScorecard = null;
    let effectiveProductMeta = productContext
      ? {
          source: productContext.source,
          jiraKey: productContext.jiraKey,
          jiraAvailable: productContext.jiraAvailable,
          ticketSummary: productContext.ticketSummary,
          manualNote: productContext.manualNote,
          applicableHint: productContext.applicableHint,
        }
      : null;

    if (singleDomainId) {
      const prevArtifact = getReviewArtifact({
        cfg,
        repo: pr.repo,
        number: Number(pr.number),
        headSha,
        teamProfile: activeTeam?.id || cfg.teamProfile,
      });

      const newDomainFindings = parseFindingsFromMarkdown(md, pr.repo).map((f) => ({
        ...f,
        domain: singleDomainId,
      }));

      if (prevArtifact?.markdown) {
        const prevFindings = parseFindingsFromMarkdown(prevArtifact.markdown, pr.repo);
        const preservedOtherDomains = prevFindings.filter(
          (f) => inferDomainForFinding(f) !== singleDomainId
        );
        finalFindings = [...preservedOtherDomains, ...newDomainFindings].map((f, idx) => ({
          ...f,
          id: `#${idx + 1}`,
        }));
        md = rebuildReviewFindingsSection(prevArtifact.markdown, finalFindings);
        const prevBlock =
          prevArtifact.metadata?.scorecard ||
          parseScorecardBlockFromMarkdown(prevArtifact.markdown);
        previousScorecard = prevBlock || null;
        if (prevBlock?.domains) {
          rawDomains = { ...prevBlock.domains };
        }
        if (!effectiveProductMeta && prevArtifact.metadata?.productContext) {
          effectiveProductMeta = prevArtifact.metadata.productContext;
        }
      } else {
        finalFindings = newDomainFindings.map((f, idx) => ({ ...f, id: `#${idx + 1}` }));
        for (const a of agentCatalog) {
          if (a.id !== singleDomainId) {
            rawDomains[a.id] = {
              applicable: false,
              rawScore: null,
              summary: 'Not run yet (single-domain pass only).',
              lastRunMode: 'pending',
            };
          }
        }
      }

      const incomingDom = parsedScorecardBlock?.domains?.[singleDomainId] || {};
      rawDomains[singleDomainId] = {
        ...incomingDom,
        applicable:
          incomingDom.applicable !== undefined
            ? Boolean(incomingDom.applicable)
            : singleDomainId === 'product' && productContext && !productContext.applicableHint && newDomainFindings.length === 0
            ? false
            : true,
        lastRunMode: 'deep',
        updatedAt: nowIso,
        source:
          singleDomainId === 'product' && productContext
            ? productContext.source
            : incomingDom.source || null,
      };
    } else {
      finalFindings = parseFindingsFromMarkdown(md, pr.repo);
      const incomingDomains = parsedScorecardBlock?.domains || {};
      for (const a of agentCatalog) {
        const d = incomingDomains[a.id] || {};
        const hasProductFindings =
          a.id === 'product' &&
          finalFindings.some((f) => inferDomainForFinding(f) === 'product');
        const defaultApplicable =
          a.id === 'product' && productContext && !productContext.applicableHint && !hasProductFindings
            ? false
            : true;
        rawDomains[a.id] = {
          ...d,
          applicable: d.applicable !== undefined ? Boolean(d.applicable) : defaultApplicable,
          lastRunMode: 'orchestrated',
          updatedAt: nowIso,
          source:
            a.id === 'product' && productContext ? productContext.source : d.source || null,
        };
      }
    }

    const scorecard = computeBoundedScorecard({
      rawDomains,
      findings: finalFindings,
      agentsConfig,
      rulesById: rulesLookup,
      previousScorecard,
    });
    md = upsertScorecardInMarkdown(md, scorecard);

    const summary = summarizeFindings(finalFindings);
    const verdict = inferVerdictFromFindings(finalFindings, md);

    saveReviewArtifact({
      cfg,
      repo: pr.repo,
      number: Number(pr.number),
      headSha,
      teamProfile: activeTeam?.id || cfg.teamProfile,
      scope: normalizedScope,
      markdown: md,
      verdict,
      findingsSummary: summary,
      jiraKey,
      reviewedBy: cfg.githubUser || 'worker',
      scorecard,
      productContext: effectiveProductMeta,
      wanreview: resolvedWanreview?.available
        ? {
            repoPath: resolvedWanreview.repoPath,
            commitSha: resolvedWanreview.commitSha || null,
            branch: resolvedWanreview.branch || 'master',
            vertical: resolvedWanreview.vertical || null,
            team: resolvedWanreview.team || null,
            resolutionSource: resolvedWanreview.resolutionSource || 'teamProfile',
            count: (resolvedWanreview.rules || []).length,
          }
        : null,
    });

    const defaultSyncScript = path.join(SKILL_ROOT, 'scripts', 'sync-queue.sh');
    if (
      cfg.syncScript &&
      path.resolve(cfg.syncScript) !== path.resolve(defaultSyncScript) &&
      fs.existsSync(cfg.syncScript)
    ) {
      await execFileAsync(cfg.syncScript, [
        'record',
        pr.repo,
        String(pr.number),
        headSha,
        verdict,
        summary,
        jiraKey,
        reviewFileName,
      ]).catch(() => {});
    }

    if (normalizedScope === 'shared' && cfg.sharedStoreRepo) {
      job.phase = 'Pushing shared review artifact…';
      await pushSharedStore(
        cfg,
        `chore(ReviewHub): N/A - Store shared review for ${pr.repo}#${pr.number} (${String(headSha).slice(0, 7)})`
      );
    }

    job.phase = 'Completed';
    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    return job;
  } catch (err) {
    job.phase = 'Failed';
    job.status = 'failed';
    job.error = err.message || String(err);
    job.finishedAt = new Date().toISOString();
    throw err;
  }
}

export function triggerPrReview({ cfg, pr, scope = 'shared', domain = '' }) {
  const prKey = `${pr.repo}#${pr.number}`;
  const normalizedScope = scope === 'personal' ? 'personal' : 'shared';
  const targetDomain = normalizeDomainId(domain) || '';
  const existing = [...activeJobs.values()].find(
    (j) =>
      j.prKey === prKey &&
      j.type === 'review' &&
      j.scope === normalizedScope &&
      (j.domain || '') === targetDomain &&
      (j.status === 'running' || j.status === 'queued')
  );
  if (existing) return existing;

  const job = createQueuedReviewJob({ pr, scope: normalizedScope, domain: targetDomain });
  job.status = 'running';
  job.phase = targetDomain
    ? `Fetching PR diff for ${targetDomain} deep pass…`
    : 'Fetching PR diff and metadata from GitHub…';

  runPrReviewJob({
    cfg,
    pr,
    scope: normalizedScope,
    targetDomain,
    existingJob: job,
  }).catch(() => {
    // job.status and job.error already populated by runPrReviewJob
  });

  return job;
}

export async function sendPrChatMessage({
  cfg,
  pr,
  message,
  findingContext = null,
  fileContext = null,
  action = 'ask',
}) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) {
    throw new Error('Empty message');
  }

  const prKey = `${pr.repo}#${pr.number}`;
  const userMsg = appendPrChatMessage(cfg.reviewsDir, pr.repo, pr.number, {
    role: 'user',
    text: cleanMessage,
    findingId: findingContext?.id || null,
    filePath: fileContext?.filePath || findingContext?.filePath || null,
    action,
  });

  const streamState = {
    prKey,
    status: 'running',
    startedAt: new Date().toISOString(),
    phase: 'Starting AI agent…',
    partialText: '',
    activeFile: fileContext?.filePath || findingContext?.filePath || null,
    toolCalls: [],
  };
  activeChatStreams.set(prKey, streamState);

  try {
    const projectsDir = getProjectsDir(cfg);
    const repoPath = getLocalRepoPath(projectsDir, pr.repo);
    const reviewFile = pr.reviewFile || `review-${pr.repo}-${pr.number}.md`;
    let reviewMd = '';
    const activeReviewPath = path.join(cfg.reviewsDir, reviewFile);
    if (fs.existsSync(activeReviewPath)) {
      reviewMd = fs.readFileSync(activeReviewPath, 'utf8');
    }

    syncCombinedReferenceFiles(cfg.teamProfile);
    const refPaths = getReferencePaths(cfg.teamProfile);
    const dnaPath = refPaths.combinedDnaPath;
    const fpPath = refPaths.fpPath;
    const dnaText = fs.existsSync(dnaPath) ? fs.readFileSync(dnaPath, 'utf8') : '';
    const fpText = fs.existsSync(fpPath) ? fs.readFileSync(fpPath, 'utf8') : '';
    const reviewerName = cfg.githubUser || 'Reviewer';
    const activeTeam = refPaths.activeTeam;

    const history = getPrChatHistory(cfg.reviewsDir, pr.repo, pr.number).slice(-8);
    const historyTranscript = history
      .map((m) => `${m.role === 'user' ? reviewerName : 'Agent'}: ${m.text}`)
      .join('\n\n');

    const promptParts = [
      `You are ${reviewerName}'s personal code review agent inside PR Review Hub${activeTeam ? ` (Active Team Profile: ${activeTeam.name})` : ''}.`,
      `Answer concisely, directly, technically, and WITHOUT decorative emojis in English.`,
      activeTeam?.agentInstructions ? `Team Agent Instructions: ${activeTeam.agentInstructions}` : '',
      `Prefer answering immediately from the diff and audit report provided below without running unnecessary shell commands, unless the user explicitly asks to edit a file.`,
      `PR Context: ${pr.repo}#${pr.number} — "${pr.title || ''}" (author: ${pr.author || ''}, branch: ${pr.headRefName || ''} -> ${pr.baseRefName || 'develop'}, SHA: ${pr.headRefOid || ''}).`,
    ].filter(Boolean);

    if (fileContext?.filePath) {
      promptParts.push(
        `--- File Currently Displayed on Screen ("here") ---\nFile: ${fileContext.filePath}${fileContext.line ? ` (line ${fileContext.line})` : ''}\n${fileContext.patch ? `File diff:\n\`\`\`diff\n${String(fileContext.patch).slice(0, 10000)}\n\`\`\`` : ''}`
      );
    }

    if (findingContext) {
      promptParts.push(
        `Targeted Finding: ${findingContext.id} (${findingContext.title || ''}) on ${findingContext.filePath || 'the PR'}:${findingContext.startLine || ''}.\nProposed comment:\n${findingContext.customComment || findingContext.comment || ''}`
      );
    }

    if (action === 'debrief') {
      promptParts.push(
        `Mode 2 Debrief active: if ${reviewerName} dismisses a finding or teaches you a project rule, update ${fpPath} or ${refPaths.dnaPath} and update ${activeReviewPath} if relevant.`
      );
    }

    if (reviewMd) {
      promptParts.push(`--- Current Audit Report ---\n${reviewMd.slice(0, 12000)}`);
    }

    if (fpText) {
      promptParts.push(`--- Known Exceptions & False Positives ---\n${fpText.slice(0, 3500)}`);
    }

    if (dnaText) {
      promptParts.push(`--- Review DNA (${reviewerName}) ---\n${dnaText.slice(0, 3500)}`);
    }

    promptParts.push(`--- Discussion History ---\n${historyTranscript}`);
    promptParts.push(`Now reply to ${reviewerName}'s latest request:`);

    const replyText = await runCliPrompt({
      prompt: promptParts.join('\n\n'),
      cwd: repoPath,
      agentCli: cfg.agentCli || 'agy',
      approvalMode: action === 'debrief' ? 'auto_edit' : 'plan',
      timeoutMs: 120000,
      fastChatMode: true,
      includeDirs: [SKILL_ROOT, cfg.reviewsDir, repoPath],
      onStreamUpdate: ({ phase, partialText, toolName }) => {
        if (phase) streamState.phase = phase;
        if (typeof partialText === 'string') streamState.partialText = partialText;
        if (toolName && !streamState.toolCalls.includes(toolName)) {
          streamState.toolCalls.push(toolName);
        }
      },
    });

    const assistantMsg = appendPrChatMessage(cfg.reviewsDir, pr.repo, pr.number, {
      role: 'assistant',
      text: replyText || 'Response recorded.',
      findingId: findingContext?.id || null,
      filePath: fileContext?.filePath || null,
    });

    return { userMsg, assistantMsg };
  } finally {
    activeChatStreams.delete(prKey);
  }
}

export function dismissFindingAsFalsePositive({
  cfg,
  pr,
  finding,
  reason = '',
  scope = 'team',
  actor = '',
  uiStateFile,
}) {
  const refPaths = getReferencePaths(cfg?.teamProfile || '');
  const hasExplicitTeamFp = Boolean(process.env.REVIEW_HUB_TEAM_FP_FILE);
  const usePersonalFp =
    Boolean(process.env.REVIEW_HUB_FP_FILE) || scope === 'personal' || !hasExplicitTeamFp;
  const fpPath = process.env.REVIEW_HUB_FP_FILE
    ? process.env.REVIEW_HUB_FP_FILE
    : usePersonalFp
    ? refPaths.fpPath
    : refPaths.teamFpPath;

  const cleanReason =
    String(reason || '').trim() ||
    `Dismissed from PR Review Hub on ${pr.repo}#${pr.number} as intentional / non-issue.`;
  const cleanActor = String(actor || cfg?.githubUser || 'reviewer').trim();
  const dateStr = new Date().toISOString().slice(0, 10);

  const block = [
    ``,
    `- **${finding.title || finding.id} (\`${pr.repo}#${pr.number}\` — ${dateStr}):**`,
    `  - *Location:* \`${finding.filePath || 'General'}\``,
    `  - *Reason:* ${cleanReason}`,
    `  - *Rule:* Do not flag this pattern in future reviews.`,
  ].join('\n');

  if (!fs.existsSync(fpPath)) {
    fs.mkdirSync(path.dirname(fpPath), { recursive: true });
    const header = usePersonalFp
      ? '# Known False Positives & Exceptions\n\n---\n'
      : `# Team False Positives & Intentional Exceptions — ${refPaths.activeTeam?.name || 'Team'}\n\n---\n`;
    fs.writeFileSync(fpPath, header, 'utf8');
  }
  fs.appendFileSync(fpPath, `${block}\n`, 'utf8');
  syncCombinedReferenceFiles(cfg?.teamProfile || '');

  const cid = finding.cid || `${pr.repo}#${pr.number}::${finding.id}`;
  const nowIso = new Date().toISOString();

  if (uiStateFile) {
    let uiState = { comments: {} };
    try {
      if (fs.existsSync(uiStateFile)) {
        uiState = JSON.parse(fs.readFileSync(uiStateFile, 'utf8'));
      }
    } catch {
      // ignore
    }
    if (!uiState.comments) uiState.comments = {};
    uiState.comments[cid] = {
      ...(uiState.comments[cid] || {}),
      dismissed: true,
      dismissedBy: cleanActor,
      dismissedAt: nowIso,
      dismissReason: cleanReason,
    };
    fs.writeFileSync(uiStateFile, JSON.stringify(uiState, null, 2), 'utf8');
  }

  if (cfg && scope !== 'personal') {
    recordSharedFindingAction({
      cfg,
      cid,
      action: 'dismissed',
      actor: cleanActor,
      reason: cleanReason,
    });
    if (cfg.sharedStoreRepo) {
      pushSharedStore(
        cfg,
        `chore(ReviewHub): N/A - Dismiss finding ${cid} by ${cleanActor}`
      ).catch(() => {});
    }
  }

  const targetLabel = usePersonalFp
    ? 'references/false-positives.local.md'
    : `references/teams/${refPaths.activeTeam?.id || 'team'}/false-positives.md`;
  appendPrChatMessage(cfg.reviewsDir, pr.repo, pr.number, {
    role: 'assistant',
    text: `Finding ${finding.id} marked as false positive by @${cleanActor} and added to ${targetLabel} (${cleanReason}).`,
    findingId: finding.id,
  });

  return { ok: true, fpPath, scope: usePersonalFp ? 'personal' : 'team', dismissedBy: cleanActor };
}
