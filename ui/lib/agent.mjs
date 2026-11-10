import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { SKILL_ROOT } from './config.mjs';
import { parseFindingsFromMarkdown } from './parser.mjs';
import { extractJiraKey } from './metadata.mjs';
import { getLocalRepoPath, getProjectsDir } from './worktree.mjs';
import { getReferencePaths, syncCombinedReferenceFiles } from './rules.mjs';

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

function resolveAgentBinary(agentCli = 'gemini') {
  if (agentCli === 'claude') {
    if (fs.existsSync('/opt/homebrew/bin/claude')) return '/opt/homebrew/bin/claude';
    if (fs.existsSync('/usr/local/bin/claude')) return '/usr/local/bin/claude';
    return 'claude';
  }
  if (fs.existsSync('/opt/homebrew/bin/gemini')) return '/opt/homebrew/bin/gemini';
  if (fs.existsSync('/usr/local/bin/gemini')) return '/usr/local/bin/gemini';
  return 'gemini';
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

async function runCliPrompt({
  prompt,
  cwd,
  agentCli = 'gemini',
  approvalMode = 'yolo',
  timeoutMs = 240000,
  fastChatMode = false,
  onStreamUpdate = null,
}) {
  if (customAgentRunner) {
    if (onStreamUpdate) {
      onStreamUpdate({ phase: 'Running agent…', partialText: '' });
    }
    return customAgentRunner({ prompt, cwd, approvalMode, agentCli });
  }
  const bin = resolveAgentBinary(agentCli);
  const workingDir = fs.existsSync(cwd) ? cwd : process.cwd();

  if (agentCli === 'claude') {
    const args = ['-p', prompt];
    if (approvalMode === 'yolo' || approvalMode === 'auto_edit') {
      args.push('--dangerously-skip-permissions');
    }
    const { stdout } = await execFileAsync(bin, args, {
      cwd: workingDir,
      maxBuffer: 25 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout.trim();
  }

  if (!fastChatMode) {
    const { stdout } = await execFileAsync(bin, ['-p', prompt, '--approval-mode', approvalMode], {
      cwd: workingDir,
      maxBuffer: 25 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout.trim();
  }

  // Fast streaming mode for interactive Q&A: skip external MCP servers & extensions, stream JSON events
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      prompt,
      '--approval-mode',
      approvalMode,
      '-o',
      'stream-json',
      '--allowed-mcp-server-names',
      'none',
      '-e',
      'none',
    ];
    const child = spawn(bin, args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let partialText = '';
    let rawStdout = '';
    let lineBuffer = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timeout exceeded (${Math.round(timeoutMs / 1000)}s)`));
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
        } else if (evt.type === 'message' && evt.role === 'assistant' && typeof evt.content === 'string') {
          if (evt.delta) {
            partialText += evt.content;
          } else {
            partialText = evt.content;
          }
          onStreamUpdate?.({
            phase: 'Streaming response…',
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
        reject(new Error(`Gemini process exited with code ${code}`));
      }
    });
  });
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
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  activeJobs.set(jobId, job);

  (async () => {
    try {
      const projectsDir = getProjectsDir(cfg);
      const repoPath = getLocalRepoPath(projectsDir, pr.repo);
      const reviewFileName = `review-${pr.repo}-${pr.number}.md`;
      const reviewFilePath = path.join(cfg.reviewsDir, reviewFileName);
      const jiraKey = extractJiraKey(pr) || '—';

      let headSha = pr.headRefOid || pr.lastReviewedSha || '';
      if (!headSha) {
        try {
          const { stdout } = await execFileAsync('gh', [
            'pr',
            'view',
            String(pr.number),
            '--repo',
            `${cfg.githubOrg}/${pr.repo}`,
            '--json',
            'headRefOid',
            '--jq',
            '.headRefOid',
          ]);
          headSha = stdout.trim();
        } catch {
          headSha = 'HEAD';
        }
      }

      const { commonDnaPath, teamDnaPath, activeTeam, dnaPath, fpPath } = getReferencePaths(
        cfg.teamProfile
      );
      syncCombinedReferenceFiles(cfg.teamProfile);

      const teamContextLine = activeTeam
        ? `Active Team Profile: "${activeTeam.name}" (${activeTeam.id}). Tech Stack: ${(activeTeam.techStack || []).join(', ') || 'General'}.${activeTeam.agentInstructions ? ` Team Agent Focus: ${activeTeam.agentInstructions}` : ''}`
        : '';

      const prompt = [
        `Execute a Mode 1 code review using the skill at ${path.join(SKILL_ROOT, 'SKILL.md')} for PR ${cfg.githubOrg}/${pr.repo}#${pr.number} ("${pr.title || ''}", author: ${pr.author || 'unknown'}, head SHA: ${headSha}).`,
        teamContextLine,
        `Read ${commonDnaPath}, ${teamDnaPath}, ${dnaPath}, ${path.join(SKILL_ROOT, 'references/review-checklist.md')}, and ${fpPath}.`,
        `Write the full Markdown review report in 100% English to ${reviewFilePath}, starting with "## 1. Task Summary & Functional Problem Solved" (Business & Functional Problem Solved, Technical & Feature Solution, Jira & Scope Compliance), and providing a single English "Ready-to-paste GitHub comment:" block per finding.`,
        `Never publish any comment to GitHub.`,
      ]
        .filter(Boolean)
        .join('\n');

      const out = await runCliPrompt({
        prompt,
        cwd: repoPath,
        agentCli: cfg.agentCli || 'gemini',
        approvalMode: 'yolo',
        timeoutMs: 300000,
      });

      // Fallback if the CLI returned markdown on stdout instead of writing the file directly
      if (!fs.existsSync(reviewFilePath) && out && out.includes('#')) {
        fs.writeFileSync(reviewFilePath, out, 'utf8');
      }

      if (fs.existsSync(reviewFilePath)) {
        const md = fs.readFileSync(reviewFilePath, 'utf8');
        const findings = parseFindingsFromMarkdown(md, pr.repo);
        const summary = summarizeFindings(findings);
        const verdict = inferVerdictFromFindings(findings, md);

        if (cfg.syncScript && fs.existsSync(cfg.syncScript)) {
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
      }

      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
    } catch (err) {
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
    phase: 'Starting Gemini (without external MCP servers)…',
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
      agentCli: cfg.agentCli || 'gemini',
      approvalMode: action === 'debrief' ? 'auto_edit' : 'plan',
      timeoutMs: 120000,
      fastChatMode: true,
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
