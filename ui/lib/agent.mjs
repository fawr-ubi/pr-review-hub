import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SKILL_ROOT } from './config.mjs';
import { parseFindingsFromMarkdown } from './parser.mjs';
import { extractJiraKey } from './metadata.mjs';
import { getLocalRepoPath, getProjectsDir } from './worktree.mjs';
import { getReferencePaths, syncCombinedReferenceFiles } from './rules.mjs';

const execFileAsync = promisify(execFile);

const activeJobs = new Map();
let customAgentRunner = null;

export function setCustomAgentRunnerForTests(fn) {
  customAgentRunner = fn;
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

function resolveGeminiBinary() {
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

async function runCliPrompt({ prompt, cwd, approvalMode = 'yolo', timeoutMs = 240000 }) {
  if (customAgentRunner) {
    return customAgentRunner({ prompt, cwd, approvalMode });
  }
  const bin = resolveGeminiBinary();
  const { stdout } = await execFileAsync(bin, ['-p', prompt, '--approval-mode', approvalMode], {
    cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
    maxBuffer: 25 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout.trim();
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

      const { commonDnaPath, dnaPath, fpPath } = getReferencePaths();
      syncCombinedReferenceFiles();

      const prompt = [
        `Execute a Mode 1 code review using the skill at ${path.join(SKILL_ROOT, 'SKILL.md')} for PR ${cfg.githubOrg}/${pr.repo}#${pr.number} ("${pr.title || ''}", author: ${pr.author || 'unknown'}, head SHA: ${headSha}).`,
        `Read ${commonDnaPath}, ${dnaPath}, ${path.join(SKILL_ROOT, 'references/review-checklist.md')}, and ${fpPath}.`,
        `Write the full Markdown review report in 100% English to ${reviewFilePath}, starting with "## 1. Task Summary & Functional Problem Solved" (Business & Functional Problem Solved, Technical & Feature Solution, Jira & Scope Compliance), and providing a single English "Ready-to-paste GitHub comment:" block per finding.`,
        `Never publish any comment to GitHub.`,
      ].join('\n');

      const out = await runCliPrompt({
        prompt,
        cwd: repoPath,
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
  action = 'ask',
}) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) {
    throw new Error('Empty message');
  }

  const userMsg = appendPrChatMessage(cfg.reviewsDir, pr.repo, pr.number, {
    role: 'user',
    text: cleanMessage,
    findingId: findingContext?.id || null,
    action,
  });

  const projectsDir = getProjectsDir(cfg);
  const repoPath = getLocalRepoPath(projectsDir, pr.repo);
  const reviewFile = pr.reviewFile || `review-${pr.repo}-${pr.number}.md`;
  let reviewMd = '';
  const activeReviewPath = path.join(cfg.reviewsDir, reviewFile);
  if (fs.existsSync(activeReviewPath)) {
    reviewMd = fs.readFileSync(activeReviewPath, 'utf8');
  }

  syncCombinedReferenceFiles();
  const refPaths = getReferencePaths();
  const dnaPath = refPaths.combinedDnaPath;
  const fpPath = refPaths.fpPath;
  const dnaText = fs.existsSync(dnaPath) ? fs.readFileSync(dnaPath, 'utf8') : '';
  const fpText = fs.existsSync(fpPath) ? fs.readFileSync(fpPath, 'utf8') : '';
  const reviewerName = cfg.githubUser || 'Reviewer';

  const history = getPrChatHistory(cfg.reviewsDir, pr.repo, pr.number).slice(-10);
  const historyTranscript = history
    .map((m) => `${m.role === 'user' ? reviewerName : 'Agent'}: ${m.text}`)
    .join('\n\n');

  const promptParts = [
    `Tu es l'agent personnel de code review de ${reviewerName} dans le PR Review Hub.`,
    `Réponds de façon concise, directe, technique et SANS emoji décoratif en français (code et identifiants en anglais).`,
    `Contexte PR : ${pr.repo}#${pr.number} — "${pr.title || ''}" (auteur: ${pr.author || ''}, branche: ${pr.headRefName || ''} -> ${pr.baseRefName || 'develop'}, SHA: ${pr.headRefOid || ''}).`,
  ];

  if (findingContext) {
    promptParts.push(
      `Finding ciblé : ${findingContext.id} (${findingContext.title || ''}) sur ${findingContext.filePath || 'la PR'}:${findingContext.startLine || ''}.\nCommentaire proposé :\n${findingContext.customComment || findingContext.comment || ''}`
    );
  }

  if (action === 'debrief') {
    promptParts.push(
      `Mode 2 Debrief actif : si ${reviewerName} rejette un finding ou t'enseigne une règle projet, mets à jour ${fpPath} ou ${refPaths.dnaPath} et adapte ${activeReviewPath} si pertinent.`
    );
  }

  if (reviewMd) {
    promptParts.push(`--- Rapport d'Audit Actuel ---\n${reviewMd.slice(0, 14000)}`);
  }

  if (fpText) {
    promptParts.push(`--- Exceptions & Faux Positifs Connus ---\n${fpText.slice(0, 4000)}`);
  }

  if (dnaText) {
    promptParts.push(`--- ADN de Review (${reviewerName}) ---\n${dnaText.slice(0, 4000)}`);
  }

  promptParts.push(`--- Historique de discussion ---\n${historyTranscript}`);
  promptParts.push(`Réponds maintenant à la dernière demande de ${reviewerName} :`);

  const replyText = await runCliPrompt({
    prompt: promptParts.join('\n\n'),
    cwd: repoPath,
    approvalMode: 'auto_edit',
    timeoutMs: 120000,
  });

  const assistantMsg = appendPrChatMessage(cfg.reviewsDir, pr.repo, pr.number, {
    role: 'assistant',
    text: replyText || 'Réponse enregistrée.',
    findingId: findingContext?.id || null,
  });

  return { userMsg, assistantMsg };
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
    text: `Finding ${finding.id} marqué comme faux positif et ajouté à references/false-positives.md (${cleanReason}).`,
    findingId: finding.id,
  });

  return { ok: true, fpPath };
}
