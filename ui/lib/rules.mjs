import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKILL_ROOT, loadConfig } from './config.mjs';

export function getTeamsDir() {
  const dir = process.env.REVIEW_HUB_TEAMS_DIR || path.join(SKILL_ROOT, 'references', 'teams');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeTeamProfileId(rawId = '') {
  return String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function listTeamProfiles() {
  const teamsDir = getTeamsDir();
  if (!fs.existsSync(teamsDir)) return [];
  const entries = fs.readdirSync(teamsDir, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const profilePath = path.join(teamsDir, id, 'profile.json');
    const dnaPath = path.join(teamsDir, id, 'team-dna.md');
    let meta = {
      id,
      name: id,
      description: '',
      githubTeams: [],
      repos: [],
      techStack: [],
      agentSkills: [],
      agentInstructions: '',
    };
    if (fs.existsSync(profilePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        meta = { ...meta, ...parsed, id };
      } catch {
        // ignore malformed profile.json
      }
    }
    profiles.push({
      ...meta,
      dnaPath,
      hasDnaFile: fs.existsSync(dnaPath),
    });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function getActiveTeamProfile(requestedProfileId = '') {
  const profiles = listTeamProfiles();
  const cfg = loadConfig();
  const targetId = sanitizeTeamProfileId(requestedProfileId || cfg.teamProfile || 'popcorn-back');
  const found = profiles.find((p) => p.id === targetId);
  if (found) return found;
  if (profiles.length > 0) return profiles[0];
  const fallbackDir = path.join(getTeamsDir(), targetId || 'default-team');
  fs.mkdirSync(fallbackDir, { recursive: true });
  const dnaPath = path.join(fallbackDir, 'team-dna.md');
  if (!fs.existsSync(dnaPath)) {
    fs.writeFileSync(dnaPath, `# Team Reviewer DNA (${targetId || 'default-team'})\n\n---\n`, 'utf8');
  }
  return {
    id: targetId || 'default-team',
    name: targetId || 'Default Team',
    description: '',
    githubTeams: [],
    repos: [],
    techStack: [],
    agentSkills: [],
    agentInstructions: '',
    dnaPath,
    hasDnaFile: true,
  };
}

export function saveTeamProfile({
  id,
  name,
  description = '',
  githubTeams = [],
  repos = [],
  techStack = [],
  agentSkills = [],
  agentInstructions = '',
}) {
  const cleanId = sanitizeTeamProfileId(id || name);
  if (!cleanId) {
    throw new Error('Team profile ID or name is required');
  }
  const teamDir = path.join(getTeamsDir(), cleanId);
  fs.mkdirSync(teamDir, { recursive: true });
  const profilePath = path.join(teamDir, 'profile.json');
  const dnaPath = path.join(teamDir, 'team-dna.md');

  const normalizeList = (val) =>
    Array.isArray(val)
      ? val.map((s) => String(s).trim()).filter(Boolean)
      : String(val || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  const profileData = {
    id: cleanId,
    name: String(name || cleanId).trim(),
    description: String(description || '').trim(),
    githubTeams: normalizeList(githubTeams),
    repos: normalizeList(repos),
    techStack: normalizeList(techStack),
    agentSkills: normalizeList(agentSkills),
    agentInstructions: String(agentInstructions || '').trim(),
  };

  fs.writeFileSync(profilePath, JSON.stringify(profileData, null, 2) + '\n', 'utf8');
  if (!fs.existsSync(dnaPath)) {
    const initialDna = [
      `# Team Reviewer DNA — ${profileData.name}`,
      '',
      profileData.description || `Shared team-level code review rules for ${profileData.name}.`,
      '',
      '---',
      '',
      '## 1. Architecture, Serialization & Clean Code',
      '',
    ].join('\n');
    fs.writeFileSync(dnaPath, initialDna, 'utf8');
  }

  syncCombinedReferenceFiles();
  return getActiveTeamProfile(cleanId);
}

export function getReferencePaths(teamProfileId = '') {
  const refDir = path.join(SKILL_ROOT, 'references');
  fs.mkdirSync(refDir, { recursive: true });

  const legacyDnaPath = path.join(refDir, 'reviewer-dna.md');
  const legacyFpPath = path.join(refDir, 'false-positives.md');
  const legacyChangelogPath = path.join(refDir, 'changelog.md');

  const localDnaDefault = path.join(refDir, 'reviewer-dna.local.md');
  const localFpDefault = path.join(refDir, 'false-positives.local.md');
  const localChangelogDefault = path.join(refDir, 'changelog.local.md');

  // Auto-migrate or bootstrap .local.md files if missing
  if (!process.env.REVIEW_HUB_DNA_FILE && !fs.existsSync(localDnaDefault)) {
    const src = fs.existsSync(legacyDnaPath)
      ? legacyDnaPath
      : path.join(refDir, 'reviewer-dna.example.md');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, localDnaDefault);
    }
  }
  if (!process.env.REVIEW_HUB_FP_FILE && !fs.existsSync(localFpDefault)) {
    const src = fs.existsSync(legacyFpPath)
      ? legacyFpPath
      : path.join(refDir, 'false-positives.example.md');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, localFpDefault);
    }
  }
  if (!process.env.REVIEW_HUB_CHANGELOG_FILE && !fs.existsSync(localChangelogDefault)) {
    if (fs.existsSync(legacyChangelogPath)) {
      fs.copyFileSync(legacyChangelogPath, localChangelogDefault);
    } else {
      fs.writeFileSync(localChangelogDefault, '# Reviewer DNA Changelog\n\n---\n', 'utf8');
    }
  }

  const activeTeam = getActiveTeamProfile(teamProfileId);
  const commonDnaPath =
    process.env.REVIEW_HUB_COMMON_DNA_FILE || path.join(refDir, 'common-dna.md');
  const teamDnaPath = process.env.REVIEW_HUB_TEAM_DNA_FILE || activeTeam.dnaPath;
  const dnaPath = process.env.REVIEW_HUB_DNA_FILE || localDnaDefault;
  const fpPath = process.env.REVIEW_HUB_FP_FILE || localFpDefault;
  const changelogPath = process.env.REVIEW_HUB_CHANGELOG_FILE || localChangelogDefault;
  const candidatesPath =
    process.env.REVIEW_HUB_CANDIDATES_FILE || path.join(refDir, 'candidate-rules.local.json');

  return {
    commonDnaPath,
    teamDnaPath,
    activeTeam,
    dnaPath,
    combinedDnaPath: legacyDnaPath,
    fpPath,
    changelogPath,
    candidatesPath,
    legacyDnaPath,
    legacyFpPath,
  };
}

/**
 * Keeps legacy `references/reviewer-dna.md` and `references/false-positives.md` synchronized
 * on disk (both gitignored) by combining `common-dna.md` + `teams/<team>/team-dna.md` + `reviewer-dna.local.md`
 * so any external skill invocation reading `references/reviewer-dna.md` automatically gets all 3 layers.
 */
export function syncCombinedReferenceFiles(teamProfileId = '') {
  if (process.env.REVIEW_HUB_DNA_FILE || process.env.REVIEW_HUB_FP_FILE) return;
  const { commonDnaPath, teamDnaPath, dnaPath, fpPath, legacyDnaPath, legacyFpPath } =
    getReferencePaths(teamProfileId);
  try {
    const commonMd = fs.existsSync(commonDnaPath) ? fs.readFileSync(commonDnaPath, 'utf8').trim() : '';
    const teamMd = fs.existsSync(teamDnaPath) ? fs.readFileSync(teamDnaPath, 'utf8').trim() : '';
    const localMd = fs.existsSync(dnaPath) ? fs.readFileSync(dnaPath, 'utf8').trim() : '';
    const combinedDna = [commonMd, teamMd, localMd].filter(Boolean).join('\n\n---\n\n') + '\n';
    if (combinedDna.trim()) {
      fs.writeFileSync(legacyDnaPath, combinedDna, 'utf8');
    }
    if (fs.existsSync(fpPath)) {
      fs.copyFileSync(fpPath, legacyFpPath);
    }
  } catch {
    // ignore sync errors
  }
}

function computeRuleId(source, section, title, index) {
  const hash = crypto
    .createHash('sha1')
    .update(`${source}::${section}::${title}::${index}`)
    .digest('hex')
    .slice(0, 10);
  return `${source}-${hash}`;
}

/**
 * Parses a Markdown reference file (reviewer-dna.local.md, common-dna.md, or false-positives.local.md)
 * into top-level bullet rules grouped by `## Section`.
 */
export function parseRulesMarkdown(markdown, source = 'dna') {
  if (!markdown || typeof markdown !== 'string') {
    return { sections: [], rules: [] };
  }

  const lines = markdown.split(/\r?\n/);
  const sections = [];
  const rules = [];

  let currentSection = 'General';
  let activeRule = null;
  let inCodeFence = false;

  const flushRule = () => {
    if (!activeRule) return;
    const rawBlock = activeRule.lines.join('\n').replace(/\s+$/, '');
    const firstLine = activeRule.lines[0] || '';
    const titleMatch = firstLine.match(/^-\s+\*\*([^*]+)\*\*:?\s*(.*)$/);
    const title = titleMatch
      ? titleMatch[1].replace(/:$/, '').trim()
      : firstLine.replace(/^-\s+/, '').slice(0, 90).trim();

    const bodyLines = [];
    if (titleMatch && titleMatch[2]) {
      bodyLines.push(titleMatch[2]);
    }
    for (let k = 1; k < activeRule.lines.length; k++) {
      bodyLines.push(activeRule.lines[k].replace(/^ {2}/, ''));
    }

    const body = bodyLines.join('\n').trim();
    const id = computeRuleId(source, activeRule.section, title, rules.length);

    rules.push({
      id,
      source,
      target: source,
      section: activeRule.section,
      title,
      body,
      rawBlock,
      rawMarkdown: rawBlock,
      startLine: activeRule.startLineIndex + 1,
      startLineIndex: activeRule.startLineIndex,
      endLineIndex: activeRule.endLineIndex,
    });
    activeRule = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^`{3,4}/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      if (activeRule) {
        activeRule.lines.push(line);
        activeRule.endLineIndex = i;
      }
      continue;
    }

    if (!inCodeFence) {
      const secMatch = line.match(/^##\s+(.+)$/);
      if (secMatch) {
        flushRule();
        currentSection = secMatch[1].trim();
        if (!sections.includes(currentSection)) {
          sections.push(currentSection);
        }
        continue;
      }

      if (/^---+\s*$/.test(line)) {
        flushRule();
        continue;
      }

      if (/^-\s+/.test(line)) {
        flushRule();
        if (!sections.includes(currentSection)) {
          sections.push(currentSection);
        }
        activeRule = {
          section: currentSection,
          startLineIndex: i,
          endLineIndex: i,
          lines: [line],
        };
        continue;
      }
    }

    if (activeRule) {
      if (inCodeFence || /^\s+/.test(line) || line.trim() === '') {
        activeRule.lines.push(line);
        if (line.trim() !== '') {
          activeRule.endLineIndex = i;
        }
      } else {
        flushRule();
      }
    }
  }

  flushRule();
  return { sections, rules };
}

function logChangelogEntry(changelogPath, actionLabel, target, title, prKey = '') {
  if (!changelogPath || !fs.existsSync(changelogPath)) return;
  const dateStr = new Date().toISOString().slice(0, 10);
  const prSuffix = prKey ? ` (from \`${prKey}\`)` : '';
  const line = `- **[${dateStr}] ${actionLabel} (${target}):** **${title}**${prSuffix}\n`;
  const existing = fs.readFileSync(changelogPath, 'utf8');
  const marker = '---\n';
  const idx = existing.indexOf(marker);
  if (idx !== -1) {
    const updated =
      existing.slice(0, idx + marker.length) + '\n' + line + existing.slice(idx + marker.length);
    fs.writeFileSync(changelogPath, updated, 'utf8');
  } else {
    fs.appendFileSync(changelogPath, `\n${line}`, 'utf8');
  }
}

export function loadCandidateRules() {
  const { candidatesPath } = getReferencePaths();
  try {
    if (!fs.existsSync(candidatesPath)) return [];
    const data = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    return Array.isArray(data.candidates) ? data.candidates : [];
  } catch {
    return [];
  }
}

export function saveCandidateRules(candidates = []) {
  const { candidatesPath } = getReferencePaths();
  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  fs.writeFileSync(
    candidatesPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), candidates }, null, 2),
    'utf8'
  );
  return candidates;
}

export function listAllRules(teamProfileId = '') {
  const { commonDnaPath, teamDnaPath, activeTeam, dnaPath, fpPath } =
    getReferencePaths(teamProfileId);
  const commonMd = fs.existsSync(commonDnaPath) ? fs.readFileSync(commonDnaPath, 'utf8') : '';
  const teamMd = fs.existsSync(teamDnaPath) ? fs.readFileSync(teamDnaPath, 'utf8') : '';
  const dnaMd = fs.existsSync(dnaPath) ? fs.readFileSync(dnaPath, 'utf8') : '';
  const fpMd = fs.existsSync(fpPath) ? fs.readFileSync(fpPath, 'utf8') : '';

  const commonParsed = parseRulesMarkdown(commonMd, 'common');
  const teamParsed = parseRulesMarkdown(teamMd, 'team');
  const dnaParsed = parseRulesMarkdown(dnaMd, 'dna');
  const fpParsed = parseRulesMarkdown(fpMd, 'false-positive');
  const candidateRules = loadCandidateRules();
  const teamProfiles = listTeamProfiles();

  return {
    teamProfiles,
    activeTeamProfile: activeTeam,
    commonSections: commonParsed.sections,
    teamSections: teamParsed.sections,
    dnaSections: dnaParsed.sections,
    fpSections: fpParsed.sections,
    commonRules: commonParsed.rules,
    teamRules: teamParsed.rules,
    dnaRules: dnaParsed.rules,
    falsePositives: fpParsed.rules,
    candidateRules,
    candidates: candidateRules,
    rules: [...dnaParsed.rules, ...teamParsed.rules, ...commonParsed.rules, ...fpParsed.rules],
  };
}

function resolveTargetFilePath(target, teamProfileId = '') {
  const { commonDnaPath, teamDnaPath, activeTeam, dnaPath, fpPath } =
    getReferencePaths(teamProfileId);
  if (target === 'common') return { filePath: commonDnaPath, label: 'common-dna.md' };
  if (target === 'team')
    return { filePath: teamDnaPath, label: `teams/${activeTeam.id}/team-dna.md` };
  if (target === 'false-positive') return { filePath: fpPath, label: 'false-positives.md' };
  return { filePath: dnaPath, label: 'reviewer-dna.md' };
}

export function addRule({
  target = 'dna',
  teamProfile = '',
  section = '',
  title = '',
  body = '',
  description = '',
  source = '',
  prKey = '',
}) {
  const cleanTitle = String(title || '').trim();
  const cleanDesc = String(body || description || '').trim();
  const cleanPrKey = String(source || prKey || '').trim();
  if (!cleanTitle || !cleanDesc) {
    throw new Error('Rule title and description are required');
  }

  const { changelogPath } = getReferencePaths(teamProfile);
  const { filePath, label } = resolveTargetFilePath(target, teamProfile);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  const formattedBody = cleanDesc
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => (line.trim().startsWith('-') ? `  ${line.trim()}` : `  - ${line.trim()}`))
    .join('\n');

  const newRuleBlock = `- **${cleanTitle}:**\n${formattedBody}`;

  const lines = existing ? existing.split(/\r?\n/) : [];
  const cleanSection = String(section || '').trim();
  let inserted = false;

  if (cleanSection) {
    const secIdx = lines.findIndex(
      (l) => l.startsWith('## ') && l.slice(3).trim().toLowerCase() === cleanSection.toLowerCase()
    );
    if (secIdx !== -1) {
      let insertAt = lines.length;
      for (let i = secIdx + 1; i < lines.length; i++) {
        if (/^##\s+/.test(lines[i]) || /^---+\s*$/.test(lines[i])) {
          insertAt = i;
          break;
        }
      }
      while (insertAt > secIdx + 1 && lines[insertAt - 1].trim() === '') {
        insertAt--;
      }
      lines.splice(insertAt, 0, ...newRuleBlock.split('\n'), '');
      inserted = true;
    }
  }

  if (!inserted) {
    const secHeader =
      cleanSection || (target === 'false-positive' ? 'Custom Exceptions' : 'Custom Rules');
    lines.push('', '---', '', `## ${secHeader}`, '', ...newRuleBlock.split('\n'));
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');
  syncCombinedReferenceFiles(teamProfile);
  logChangelogEntry(
    changelogPath,
    target === 'false-positive'
      ? 'Added False Positive'
      : target === 'common'
      ? 'Added Common DNA rule'
      : target === 'team'
      ? 'Added Team DNA rule'
      : 'Added DNA rule',
    label,
    cleanTitle,
    cleanPrKey
  );

  return listAllRules(teamProfile);
}

export function updateRule({ id, target = 'dna', teamProfile = '', title = '', body = '' }) {
  const cleanTitle = String(title || '').trim();
  const cleanBody = String(body || '').trim();
  if (!id || !cleanTitle) {
    throw new Error('Rule id and title are required');
  }

  const { changelogPath } = getReferencePaths(teamProfile);
  const { filePath, label } = resolveTargetFilePath(target, teamProfile);
  if (!fs.existsSync(filePath)) {
    throw new Error('Reference file not found');
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const parsed = parseRulesMarkdown(existing, target);
  const match = parsed.rules.find((r) => r.id === id);
  if (!match) {
    throw new Error(`Rule ${id} not found`);
  }

  const indentedBody = cleanBody
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) =>
      l.startsWith('  ') ? l : `  ${l.trim().startsWith('-') ? l.trim() : `- ${l.trim()}`}`
    )
    .join('\n');

  const replacementBlock = indentedBody
    ? `- **${cleanTitle}:**\n${indentedBody}`
    : `- **${cleanTitle}**`;

  const lines = existing.split(/\r?\n/);
  const removeCount = match.endLineIndex - match.startLineIndex + 1;
  lines.splice(match.startLineIndex, removeCount, ...replacementBlock.split('\n'));

  fs.writeFileSync(filePath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');
  syncCombinedReferenceFiles(teamProfile);
  logChangelogEntry(changelogPath, 'Updated Rule', label, cleanTitle);

  return listAllRules(teamProfile);
}

export function deleteRule({ id, target = 'dna', teamProfile = '' }) {
  if (!id) throw new Error('Rule id is required');

  const { changelogPath } = getReferencePaths(teamProfile);
  const { filePath, label } = resolveTargetFilePath(target, teamProfile);
  if (!fs.existsSync(filePath)) {
    throw new Error('Reference file not found');
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const parsed = parseRulesMarkdown(existing, target);
  const match = parsed.rules.find((r) => r.id === id);
  if (!match) {
    throw new Error(`Rule ${id} not found`);
  }

  const lines = existing.split(/\r?\n/);
  const removeCount = match.endLineIndex - match.startLineIndex + 1;
  lines.splice(match.startLineIndex, removeCount);

  fs.writeFileSync(filePath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');
  syncCombinedReferenceFiles(teamProfile);
  logChangelogEntry(
    changelogPath,
    target === 'false-positive' ? 'Removed False Positive' : 'Removed DNA rule',
    label,
    match.title
  );

  return listAllRules(teamProfile);
}

/**
 * Validates ("approve") or rejects ("reject") a candidate rule extracted from the 1-year team PR history.
 */
export function decideCandidateRule({
  id,
  action = '',
  decision = 'approve',
  target = 'dna',
  teamProfile = '',
  section = '',
  title = '',
  body = '',
}) {
  const effectiveDecision = action || decision || 'approve';
  const candidates = loadCandidateRules();
  const idx = candidates.findIndex((c) => c.id === id);
  if (idx === -1) {
    throw new Error(`Candidate rule ${id} not found`);
  }

  const candidate = candidates[idx];
  candidates.splice(idx, 1);
  saveCandidateRules(candidates);

  if (effectiveDecision === 'approve') {
    const resolvedTarget =
      target === 'common'
        ? 'common'
        : target === 'team'
        ? 'team'
        : target === 'false-positive'
        ? 'false-positive'
        : 'dna';
    addRule({
      target: resolvedTarget,
      teamProfile,
      section: section || candidate.section || '1. Architecture, Serialization & Clean Code',
      title: title || candidate.title,
      body: body || candidate.body,
      source: (candidate.sourcePrs || []).slice(0, 3).join(', ') || '1-Year Team History Bootstrap',
    });
  }

  return listAllRules(teamProfile);
}

export function approveAllCandidateRules({ target = 'dna', teamProfile = '' } = {}) {
  const candidates = loadCandidateRules();
  const resolvedTarget = target === 'common' ? 'common' : target === 'team' ? 'team' : 'dna';
  for (const candidate of candidates) {
    addRule({
      target: resolvedTarget,
      teamProfile,
      section: candidate.section || '1. Architecture, Serialization & Clean Code',
      title: candidate.title,
      body: candidate.body,
      source: (candidate.sourcePrs || []).slice(0, 3).join(', ') || '1-Year Team History Bootstrap',
    });
  }
  saveCandidateRules([]);
  return listAllRules(teamProfile);
}
