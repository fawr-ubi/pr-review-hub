import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { SKILL_ROOT, findCliBinaryPath } from './config.mjs';
import { parseFindingsFromMarkdown } from './parser.mjs';
import { extractJiraKey } from './metadata.mjs';
import { getLocalRepoPath, getProjectsDir } from './worktree.mjs';
import { getReferencePaths, syncCombinedReferenceFiles } from './rules.mjs';
import { recordPrReview } from './sync.mjs';

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

const MODEL_FALLBACKS = {
  'gemini-4-argon-high': 'gemini-3.8-flash-high',
  'gemini-4-argon-medium': 'gemini-3.8-flash-medium',
  'gemini-4-argon-low': 'gemini-3.8-flash-low',
  'gemini-3.1-pro-high': 'gemini-3.8-flash-high',
  'gemini-3.1-pro-low': 'gemini-3.8-flash-low',
  'gemini-2.5-pro': 'gemini-2.5-flash',
  'gemini-2.0-pro-exp-02-05': 'gemini-2.5-flash',
  'claude-3-7-sonnet-20250219': 'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20241022': 'claude-3-5-haiku-20241022',
};

function isRetryableModelError(errMsg) {
  const e = String(errMsg).toLowerCase();
  return (
    e.includes('not recognized') ||
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

async function runCliPrompt(args) {
  try {
    return await _runCliPromptInternal(args);
  } catch (err) {
    if (args.model && MODEL_FALLBACKS[args.model] && isRetryableModelError(err.message)) {
      const fallbackModel = MODEL_FALLBACKS[args.model];
      if (args.onStreamUpdate) {
        args.onStreamUpdate({ phase: `⚠️ Model ${args.model} unavailable. Retrying with fallback: ${fallbackModel}...`, partialText: '' });
      }
      return await _runCliPromptInternal({ ...args, model: fallbackModel });
    }
    throw err;
  }
}

async function _runCliPromptInternal({

  prompt,
  cwd,
  agentCli = 'agy',
  approvalMode = 'yolo',
  timeoutMs = 240000,
  fastChatMode = false,
  includeDirs = [],
  onStreamUpdate = null,
  model = '',
}) {
  if (customAgentRunner) {
    if (onStreamUpdate) {
      onStreamUpdate({ phase: 'Running agent…', partialText: '' });
    }
    return customAgentRunner({ prompt, cwd, approvalMode, agentCli });
  }

  const { cli, bin } = resolveAgentBinary(agentCli);
  const workingDir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const validIncludeDirs = includeDirs.filter((d) => d && fs.existsSync(d));

  // Antigravity CLI (`agy`) — first-class default agent runner
  if (cli === 'agy') {
    return new Promise((resolve, reject) => {
      let tempPromptFile = null;
      let effectivePrompt = prompt;
      const dirsToAdd = [...validIncludeDirs];

      if (prompt.length > 32000) {
        tempPromptFile = path.join(
          os.tmpdir(),
          `prh-agy-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.md`
        );
        fs.writeFileSync(tempPromptFile, prompt, 'utf8');
        if (!dirsToAdd.includes(os.tmpdir())) {
          dirsToAdd.push(os.tmpdir());
        }
        effectivePrompt = `Read the complete review instructions and diff in the file "${tempPromptFile}" and output ONLY the requested Markdown response.`;
      }

      const args = [
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        '--output-format',
        'stream-json',
      ];
      if (model) {
        args.push('--model', model);
      }
      for (const dir of dirsToAdd) {
        args.push('--add-dir', dir);
      }
      args.push('-p', effectivePrompt);

      const child = spawn(bin, args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let partialText = '';
      let finalResponse = '';
      let rawStdout = '';
      let rawStderr = '';
      let lineBuffer = '';

      const cleanupTemp = () => {
        if (tempPromptFile && fs.existsSync(tempPromptFile)) {
          try {
            fs.unlinkSync(tempPromptFile);
          } catch {
            // ignore
          }
        }
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        cleanupTemp();
        reject(new Error(`Antigravity CLI (agy) timeout exceeded (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

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

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        rawStdout += str;
        lineBuffer += str;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const l of lines) {
          processAgyJsonLine(l);
        }
      });

      child.stderr.on('data', (chunk) => {
        rawStderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        cleanupTemp();
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        cleanupTemp();
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
      if (model) {
        args.push('--model', model);
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
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Claude CLI timeout exceeded (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      if (useStdin && child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
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
    if (model) {
      args.push('--model', model);
    }
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

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Gemini CLI timeout exceeded (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

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
      rawStderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
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

async function fetchPrContextFromGithub(cfg, pr) {
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
      { maxBuffer: 15 * 1024 * 1024, timeout: 20000 }
    ).catch(() => ({ stdout: '{}' })),
    execFileAsync('gh', ['pr', 'diff', String(pr.number), '--repo', repoSlug], {
      maxBuffer: 25 * 1024 * 1024,
      timeout: 30000,
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
  const diffText = String(diffRes.stdout || '').trim();

  return {
    headSha,
    prBody,
    diffText,
    changedFilesList,
  };
}

export function triggerPrReview({ cfg, pr }) {
  const prKey = `${pr.repo}#${pr.number}`;
  const existing = [...activeJobs.values()].find(
    (j) => j.prKey === prKey && j.type === 'review' && j.status === 'running'
  );
  if (existing) return existing;

  const jobId = `review-${pr.repo}-${pr.number}-${Date.now()}`;
  const job = {
    id: jobId,
    prKey,
    repo: pr.repo,
    number: Number(pr.number),
    type: 'review',
    status: 'running',
    phase: 'Fetching PR diff and metadata from GitHub…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  activeJobs.set(jobId, job);

  (async () => {
    try {
      const projectsDir = getProjectsDir(cfg);
      const repoPath = getLocalRepoPath(projectsDir, pr.repo);
      fs.mkdirSync(cfg.reviewsDir, { recursive: true });
      const reviewFileName = `review-${pr.repo}-${pr.number}.md`;
      const reviewFilePath = path.join(cfg.reviewsDir, reviewFileName);
      const jiraKey = extractJiraKey(pr) || '—';

      const { headSha, prBody, diffText, changedFilesList } = await fetchPrContextFromGithub(
        cfg,
        pr
      );

      syncCombinedReferenceFiles(cfg.teamProfile);
      const { commonDnaPath, teamDnaPath, activeTeam, dnaPath, fpPath, combinedDnaPath } =
        getReferencePaths(cfg.teamProfile);

      const readSafe = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '');
      const combinedRulesText =
        readSafe(combinedDnaPath) ||
        [readSafe(commonDnaPath), readSafe(teamDnaPath), readSafe(dnaPath)]
          .filter(Boolean)
          .join('\n\n');
      const fpRulesText = readSafe(fpPath);
      const checklistText = readSafe(path.join(SKILL_ROOT, 'references/review-checklist.md'));
      const templateText = readSafe(path.join(SKILL_ROOT, 'assets/review-artifact-template.md'));

      const teamContextLine = activeTeam
        ? `Active Team Profile: "${activeTeam.name}" (${activeTeam.id}). Tech Stack: ${(activeTeam.techStack || []).join(', ') || 'General'}.${activeTeam.agentInstructions ? ` Team Agent Focus: ${activeTeam.agentInstructions}` : ''}`
        : '';

      const maxDiffChars = 110000;
      const truncatedDiff =
        diffText.length > maxDiffChars
          ? `${diffText.slice(0, maxDiffChars)}\n\n[... Diff truncated at ${maxDiffChars} characters ...]`
          : diffText;

      const prompt = [
        `Execute a Mode 1 code review using the skill at ${path.join(SKILL_ROOT, 'SKILL.md')} for PR ${cfg.githubOrg}/${pr.repo}#${pr.number} ("${pr.title || ''}", author: ${pr.author || 'unknown'}, head SHA: ${headSha}).`,
        teamContextLine,
        `Read ${commonDnaPath}, ${teamDnaPath}, ${dnaPath}, ${path.join(SKILL_ROOT, 'references/review-checklist.md')}, and ${fpPath}.`,
        `Write the full Markdown review report in 100% English to ${reviewFilePath} (or output the complete Markdown report directly as your response), starting with "# Code Review: ${pr.repo}#${pr.number} — ${pr.title || ''}" and "## 1. Task Summary & Functional Problem Solved" (Business & Functional Problem Solved, Technical & Feature Solution, Jira & Scope Compliance), and providing a single English "Ready-to-paste GitHub comment:" block per finding.`,
        `Never publish any comment to GitHub.`,
        templateText ? `\n--- Output Markdown Template ---\n${templateText}` : '',
        combinedRulesText
          ? `\n--- Active Reviewer & Team DNA Rules ---\n${combinedRulesText.slice(0, 18000)}`
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
      job.phase = `Running AI audit (${resolvedCliLabel})…`;

      const out = await runCliPrompt({
        prompt,
        cwd: repoPath,
        agentCli: cfg.agentCli || 'agy',
        approvalMode: 'yolo',
        timeoutMs: 300000,
        includeDirs: [SKILL_ROOT, cfg.reviewsDir, repoPath],
        model: cfg.model || '',
        onStreamUpdate: ({ phase }) => {
          if (phase) job.phase = phase;
        },
      });

      const cleanedOut = cleanReviewMarkdownOutput(out);
      if (cleanedOut && cleanedOut.includes('#')) {
        fs.writeFileSync(reviewFilePath, `${cleanedOut}\n`, 'utf8');
      } else if (fs.existsSync(reviewFilePath)) {
        const diskContent = cleanReviewMarkdownOutput(fs.readFileSync(reviewFilePath, 'utf8'));
        if (diskContent) {
          fs.writeFileSync(reviewFilePath, `${diskContent}\n`, 'utf8');
        }
      }

      if (!fs.existsSync(reviewFilePath)) {
        throw new Error(
          'AI CLI finished without producing a Markdown review report. Check your AGY / Gemini / Claude CLI authentication.'
        );
      }

      const md = fs.readFileSync(reviewFilePath, 'utf8');
      const findings = parseFindingsFromMarkdown(md, pr.repo);
      const summary = summarizeFindings(findings);
      const verdict = inferVerdictFromFindings(findings, md);

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
      } else {
        try {
          recordPrReview({
            cfg,
            repo: pr.repo,
            number: Number(pr.number),
            headSha,
            reviewStatus: verdict,
            findingsSummary: summary,
            jiraKey,
            reviewFile: reviewFileName,
          });
        } catch {
          // ignore state update error
        }
      }

      job.phase = 'Completed';
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.phase = 'Failed';
      job.status = 'failed';
      job.error = err.message || String(err);
      job.finishedAt = new Date().toISOString();
    }
  })();

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
      model: cfg.model || '',
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
  uiStateFile,
}) {
  const refPaths = getReferencePaths();
  const fpPath = process.env.REVIEW_HUB_FP_FILE || refPaths.fpPath;
  const cleanReason =
    String(reason || '').trim() ||
    `Dismissed from PR Review Hub on ${pr.repo}#${pr.number} as intentional / non-issue.`;
  const dateStr = new Date().toISOString().slice(0, 10);

  const block = [
    ``,
    `- **${finding.title || finding.id} (\`${pr.repo}#${pr.number}\` — ${dateStr}):**`,
    `  - *Location:* \`${finding.filePath || 'General'}\``,
    `  - *Reason:* ${cleanReason}`,
    `  - *Rule:* Do not flag this pattern in future reviews.`,
  ].join('\n');

  if (fs.existsSync(fpPath)) {
    fs.appendFileSync(fpPath, `${block}\n`, 'utf8');
    syncCombinedReferenceFiles();
  }

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
    const cid = finding.cid || `${pr.repo}#${pr.number}::${finding.id}`;
    uiState.comments[cid] = {
      ...(uiState.comments[cid] || {}),
      dismissed: true,
      dismissedAt: new Date().toISOString(),
      dismissReason: cleanReason,
    };
    fs.writeFileSync(uiStateFile, JSON.stringify(uiState, null, 2), 'utf8');
  }

  appendPrChatMessage(cfg.reviewsDir, pr.repo, pr.number, {
    role: 'assistant',
    text: `Finding ${finding.id} marked as false positive and added to references/false-positives.md (${cleanReason}).`,
    findingId: finding.id,
  });

  return { ok: true, fpPath };
}
