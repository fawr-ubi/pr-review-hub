import path from 'node:path';

/**
 * Strips any local workspace prefix (file:///.../projects/<repo>/), markdown link wrapper,
 * or backticks, and extracts startLine / endLine.
 */
export function parseRepoRelativePath(rawPath, repoHint = '') {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let cleaned = rawPath.trim();

  // Unwrap markdown link [label](url) if passed directly
  const mdLinkMatch = cleaned.match(/^\[[^\]]*\]\(([^)]+)\)$/);
  if (mdLinkMatch) {
    cleaned = mdLinkMatch[1].trim();
  }

  // Strip surrounding backticks
  cleaned = cleaned.replace(/^`+|`+$/g, '').trim();

  // Strip file:// protocol and known workspace/repo root prefixes portably
  cleaned = cleaned
    .replace(/^file:\/\/\/Users\/[^/]+\/[^/]+\/projects\/[^/]+\//i, '')
    .replace(/^file:\/\/\/[^/]+\/[^/]+\/projects\/[^/]+\//i, '')
    .replace(/^file:\/\/.*\/projects\/(?:2cloud-services|2cloud|interop-service)(?:-[^/]+)?\//i, '');

  if (repoHint) {
    const escapedRepo = repoHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repoRegex = new RegExp(`^file:\\/\\/.*\\/${escapedRepo}(?:-[^/]+)?\\/`, 'i');
    cleaned = cleaned.replace(repoRegex, '');
  }

  // Fallback for common worktree naming patterns (e.g. 2cloud-services-*, 2cloud-*)
  cleaned = cleaned
    .replace(/^file:\/\/.*\/2cloud-services(?:-[^/]+)?\//i, '')
    .replace(/^file:\/\/.*\/2cloud(?:-[^/]+)?\//i, '')
    .replace(/^file:\/\//i, '')
    .replace(/^\/+/, '');

  let startLine = null;
  let endLine = null;

  const hashMatch = cleaned.match(/#L(\d+)(?:-L?(\d+))?$/i);
  if (hashMatch) {
    startLine = Number(hashMatch[1]);
    endLine = hashMatch[2] ? Number(hashMatch[2]) : startLine;
    cleaned = cleaned.slice(0, hashMatch.index);
  }

  const colonMatch = cleaned.match(/:(\d+)(?:-(\d+))?$/);
  if (colonMatch) {
    startLine = Number(colonMatch[1]);
    endLine = colonMatch[2] ? Number(colonMatch[2]) : startLine;
    cleaned = cleaned.slice(0, colonMatch.index);
  }

  return {
    path: cleaned,
    startLine,
    endLine: endLine || startLine,
  };
}

/**
 * Detects finding severity from emojis or standalone keywords (word-boundary safe).
 */
export function detectSeverity(text, fallback = '🟡') {
  if (!text) return fallback;
  if (text.includes('🔴')) return '🔴';
  if (text.includes('🟠')) return '🟠';
  if (text.includes('🟡')) return '🟡';
  if (text.includes('🟢')) return '🟢';
  if (text.includes('🔵')) return '🔵';
  if (text.includes('❓')) return '❓';
  if (/\b(blocker|blockers|blocking|critical)\b/i.test(text)) return '🔴';
  if (/\b(major|important)\b/i.test(text)) return '🟠';
  if (/\b(suggestion|suggestions|improvement|improvements)\b/i.test(text)) return '🟡';
  if (/\b(nitpick|nitpicks|nit|nits|minor)\b/i.test(text)) return '🔵';
  if (/\b(question|questions)\b/i.test(text)) return '❓';
  return fallback;
}

/**
 * Extracts explicit line ranges like "(line 65)" or "(lines 180–344)" from text.
 */
function extractExplicitLineRangeFromText(text) {
  if (!text) return null;
  const m = text.match(/\(?\bline(?:s)?\s+`?(\d+)(?:\s*[-–—]\s*(\d+))?`?\)?/i);
  if (!m) return null;
  const startLine = Number(m[1]);
  const endLine = m[2] ? Number(m[2]) : startLine;
  return { startLine, endLine };
}

/**
 * Extracts optional leading bracket tag (e.g. "[Clean Code]") and cleans redundant severity prefixes
 * ("🔴 Blocking:", "Major:", "Nit:") from finding titles.
 */
function sanitizeFindingTitle(rawTitle) {
  let cleaned = String(rawTitle || '')
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\s]+/gu, '')
    .replace(/^(?:blocking|blocker|major|minor|suggestion|nitpick|nit|question)\s*(?::|—|-)\s*/i, '')
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\s]+/gu, '')
    .trim();

  // Strip leading [`path/to/file.ext`] if followed by actual title text
  const strippedPathPrefix = cleaned.replace(/^\[`[^`]+\.[a-z0-9]+`\]\s*(?:—|-|:)?\s*/i, '').trim();
  if (strippedPathPrefix) {
    cleaned = strippedPathPrefix;
  }

  // Strip leading [Category / Rule] tag if followed by actual title text
  const strippedCategoryPrefix = cleaned.replace(/^\[[^\]]{2,60}\]\s*(?:—|-|:)?\s*/, '').trim();
  if (strippedCategoryPrefix) {
    cleaned = strippedCategoryPrefix;
  }

  return cleaned;
}

function extractLeadingBracketCategory(rawTitle) {
  const cleaned = String(rawTitle || '')
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\s]+/gu, '')
    .trim();
  if (/^\[`[^`]+\.[a-z0-9]+`\]/i.test(cleaned)) return null;
  const m = cleaned.match(/^\[([^\]]{2,60})\]\s*/);
  return m ? m[1].trim() : null;
}

/**
 * Extracts structured findings and ready-to-paste comments from a review markdown document.
 * Always prioritizes English ready-to-paste blocks over French translations.
 */
export function parseFindingsFromMarkdown(markdown, repoHint = '') {
  if (!markdown || typeof markdown !== 'string') return [];
  const findings = [];
  const lines = markdown.split(/\r?\n/);

  let currentSectionSeverity = '🟡';
  let currentFinding = null;
  let inFence = false;
  let fenceTicks = '';
  let nestedFenceDepth = 0;
  let fenceBuffer = [];
  let capturingReadyToPaste = false;
  let ignoreNextReadyFence = false;
  let standaloneReadySection = false;

  const flushFinding = () => {
    if (!currentFinding) return;
    const rawBody = currentFinding.bodyLines.join('\n').trim();

    if (!currentFinding.filePath) {
      const fileLinkMatch = rawBody.match(
        /\[[^\]]+\]\((file:\/\/[^)]+|[^)\s]+\.(?:php|ts|js|yaml|yml|json|twig|feature|xml|md)(?:#L\d+(?:-L?\d+)?)?)\)/i
      );
      if (fileLinkMatch) {
        const parsed = parseRepoRelativePath(fileLinkMatch[1], repoHint);
        if (parsed) {
          currentFinding.filePath = parsed.path;
          currentFinding.startLine = parsed.startLine;
          currentFinding.endLine = parsed.endLine;
        }
      } else {
        const inlineCodePath = rawBody.match(
          /`((?:projects\/|src\/|tests\/|features\/|config\/)[^`\s]+\.[a-z0-9]+(?::\d+(?:-\d+)?)?)`/i
        );
        if (inlineCodePath) {
          const parsed = parseRepoRelativePath(inlineCodePath[1], repoHint);
          if (parsed) {
            currentFinding.filePath = parsed.path;
            currentFinding.startLine = parsed.startLine;
            currentFinding.endLine = parsed.endLine;
          }
        }
      }
    }

    // Fallback: if filePath was found without #Lxx, look for "(lines 180–344)" or "(line 65)" in body
    if (currentFinding.filePath && !currentFinding.startLine) {
      const range = extractExplicitLineRangeFromText(rawBody);
      if (range) {
        currentFinding.startLine = range.startLine;
        currentFinding.endLine = range.endLine;
      }
    }

    if (!currentFinding.comment) {
      const cleaned = rawBody
        .replace(/^- \*\*Why it matters:\*\*\s*/gim, '')
        .replace(/^- \*\*Context:\*\*\s*/gim, '')
        .replace(/^- \*\*Suggestion:\*\*\s*/gim, '\n**Suggestion:** ')
        .trim();
      currentFinding.comment = cleaned || currentFinding.title;
    }

    const bodyCategoryMatch = rawBody.match(/^- \*\*Category:\*\*\s*(.+)$/im);
    const bodyDomainMatch = rawBody.match(/^- \*\*Domain:\*\*\s*([a-zA-Z0-9_-]+)/im);
    const bodyRuleLineMatch = rawBody.match(/^- \*\*Rules?(?:\s+IDs?)?:\*\*\s*(.+)$/im);
    const category =
      (bodyCategoryMatch ? bodyCategoryMatch[1].trim() : null) ||
      currentFinding.category ||
      null;

    const parseRuleTokens = (rawText = '') => {
      const ignored = new Set([
        'none',
        'n/a',
        'na',
        'null',
        'general',
        'custom',
        'triggered',
        'rule',
        'rules',
        'wanreview',
        'http',
        'https',
        'github.com',
        'blob',
        'master',
        'main',
      ]);
      const withoutLinks = String(rawText || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      const cleaned = withoutLinks.replace(/<!--[\s\S]*?-->/g, '');
      const matches = cleaned.match(/[a-z0-9]+(?:[._-][a-z0-9]+)+/gi) || [];
      const seen = new Set();
      const out = [];
      for (const tok of matches) {
        const norm = tok.replace(/^[.-]+|[.-]+$/g, '');
        if (!norm || ignored.has(norm.toLowerCase())) continue;
        if (!seen.has(norm)) {
          seen.add(norm);
          out.push(norm);
        }
      }
      return out;
    };

    // Strip any accidental bot/Triggered Rules footer from the ready-to-paste human comment
    let sanitizedComment = String(currentFinding.comment || '').trim();
    const triggeredLineMatch = sanitizedComment.match(/\*\*Triggered Rules?:\*\*\s*([^\r\n]+)/i);
    const footerRuleIds = triggeredLineMatch ? parseRuleTokens(triggeredLineMatch[1]) : [];
    const triggeredFooterMatch = sanitizedComment.match(
      /(?:\r?\n)*\*\*Triggered Rules?:\*\*[\s\S]*$/i
    );
    if (triggeredFooterMatch) {
      sanitizedComment = sanitizedComment.slice(0, triggeredFooterMatch.index).trim();
    }
    sanitizedComment = sanitizedComment
      .replace(/^🤖\s*Wanreview[^\r\n]*\r?\n*/i, '')
      .replace(/\r?\n*🤖\s*Wanreview[^\r\n]*$/i, '')
      .trim();

    let explicitDomain = bodyDomainMatch ? bodyDomainMatch[1].trim().toLowerCase() : null;
    const mergedRuleIds = [];
    for (const rid of [
      ...(bodyRuleLineMatch ? parseRuleTokens(bodyRuleLineMatch[1]) : []),
      ...footerRuleIds,
    ]) {
      if (!mergedRuleIds.includes(rid)) mergedRuleIds.push(rid);
    }
    const parsedRuleIds = mergedRuleIds;
    if (category) {
      const catParts = category.split(/[:/·|]/).map((s) => s.trim()).filter(Boolean);
      const firstToken = (catParts[0] || '').toLowerCase();
      if (
        !explicitDomain &&
        ['security', 'product', 'quality', 'performance', 'testing'].includes(firstToken)
      ) {
        explicitDomain = firstToken;
        if (parsedRuleIds.length === 0 && catParts[1] && /^[a-z0-9_.-]+$/i.test(catParts[1])) {
          parsedRuleIds.push(catParts[1]);
        }
      }
    }
    const uniqueRuleIds = [...new Set(parsedRuleIds)];
    const explicitRuleId = uniqueRuleIds[0] || null;

    findings.push({
      id: currentFinding.id,
      title: sanitizeFindingTitle(currentFinding.title) || currentFinding.title,
      category,
      domain: explicitDomain || null,
      ruleId: explicitRuleId,
      ruleIds: uniqueRuleIds,
      severity: currentFinding.severity,
      filePath: currentFinding.filePath,
      startLine: currentFinding.startLine,
      endLine: currentFinding.endLine,
      explanation: rawBody,
      comment: sanitizedComment || currentFinding.title,
    });
    currentFinding = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check code fence transitions (supports 3 or 4 backticks, including nested ```suggestion / ```php fences)
    const fenceMatch = line.match(/^(`{3,4})([^\s`]*)\s*$/);
    if (!inFence && fenceMatch) {
      inFence = true;
      fenceTicks = fenceMatch[1];
      nestedFenceDepth = 0;
      fenceBuffer = [];
      if (currentFinding && !capturingReadyToPaste && !ignoreNextReadyFence && !standaloneReadySection) {
        currentFinding.bodyLines.push(line);
      }
      continue;
    }

    if (inFence) {
      const nestedOpenRegex = new RegExp(`^${fenceTicks}[^\\s\`]+\\s*$`);
      const closeRegex = new RegExp(`^${fenceTicks}\\s*$`);
      if (nestedOpenRegex.test(line)) {
        nestedFenceDepth++;
        fenceBuffer.push(line);
        continue;
      }
      if (closeRegex.test(line)) {
        if (nestedFenceDepth > 0) {
          nestedFenceDepth--;
          fenceBuffer.push(line);
          continue;
        }
        inFence = false;
        const blockContent = fenceBuffer.join('\n').trim();
        if (ignoreNextReadyFence) {
          ignoreNextReadyFence = false;
          capturingReadyToPaste = false;
        } else if ((capturingReadyToPaste || standaloneReadySection) && currentFinding) {
          if (!currentFinding.comment || currentFinding.commentIsEnglish !== true) {
            currentFinding.comment = blockContent;
            if (currentFinding.pendingEnglishLock) {
              currentFinding.commentIsEnglish = true;
              currentFinding.pendingEnglishLock = false;
            }
          }
          capturingReadyToPaste = false;
        } else if (standaloneReadySection && blockContent) {
          findings.push({
            id: `#ready-${findings.length + 1}`,
            title: sanitizeFindingTitle(standaloneReadySection) || standaloneReadySection,
            severity: '💬',
            filePath: null,
            startLine: null,
            endLine: null,
            explanation: '',
            comment: blockContent,
          });
        } else if (currentFinding) {
          currentFinding.bodyLines.push(...fenceBuffer, line);
        }
        fenceTicks = '';
        nestedFenceDepth = 0;
        fenceBuffer = [];
        continue;
      }
      fenceBuffer.push(line);
      continue;
    }

    // Top-level ## headers
    if (/^##\s+/.test(line)) {
      flushFinding();
      standaloneReadySection = false;
      if (/ready-to-paste/i.test(line) && !/detailed findings/i.test(line)) {
        standaloneReadySection = line.replace(/^##\s+/, '').trim();
      } else if (/🔴|🟠|🟡|🟢|🔵|❓/.test(line)) {
        currentSectionSeverity = detectSeverity(line, currentSectionSeverity);
      }
      continue;
    }

    // ### or #### headers
    const subHeaderMatch = line.match(/^(#{3,4})\s+(.+)$/);
    if (subHeaderMatch) {
      const level = subHeaderMatch[1].length;
      const headingText = subHeaderMatch[2].trim();

      if (/ready-to-paste/i.test(headingText)) {
        if (/\((?:fr|french|français)\)/i.test(headingText)) {
          ignoreNextReadyFence = true;
          capturingReadyToPaste = false;
        } else {
          ignoreNextReadyFence = false;
          capturingReadyToPaste = true;
          if (currentFinding && /\((?:en|english)\)/i.test(headingText)) {
            currentFinding.pendingEnglishLock = true;
          }
        }
        continue;
      }

      const isFindingHeader =
        /(?:^|`|\bcomment\s+)(?:#?\d+)(?:`|\.|\s*—|\s*-|\s*:)/i.test(headingText) ||
        (level === 4 && !/ready-to-paste/i.test(headingText));

      if (isFindingHeader) {
        flushFinding();
        capturingReadyToPaste = Boolean(standaloneReadySection);
        ignoreNextReadyFence = false;

        const idMatch = headingText.match(/`?(#[0-9]+|[0-9]+)`?/);
        const findingId = idMatch
          ? idMatch[1].startsWith('#')
            ? idMatch[1]
            : `#${idMatch[1]}`
          : `#${findings.length + 1}`;

        let filePath = null;
        let startLine = null;
        let endLine = null;

        const linkMatch = headingText.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          const parsed = parseRepoRelativePath(linkMatch[2], repoHint);
          if (parsed && parsed.path) {
            filePath = parsed.path;
            startLine = parsed.startLine;
            endLine = parsed.endLine;
          }
        }
        const bracketPathMatch =
          headingText.match(/\[`([^`]+)`\]/) ||
          headingText.match(/`([^`]+\.[a-z0-9]+(?::\d+(?:-\d+)?)?(?:#L\d+(?:-L?\d+)?)?)`/i);
        if (!filePath && bracketPathMatch) {
          const parsed = parseRepoRelativePath(bracketPathMatch[1], repoHint);
          if (parsed && parsed.path) {
            filePath = parsed.path;
            startLine = parsed.startLine;
            endLine = parsed.endLine;
          }
        }

        const rawTitle = headingText
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/^(?:comment\s+)?`?#?\d+`?\s*(?:—|-|\.|:)\s*/i, '')
          .trim();
        const cleanTitle = sanitizeFindingTitle(rawTitle);
        const headerCategory = extractLeadingBracketCategory(rawTitle);

        currentFinding = {
          id: findingId,
          title: cleanTitle || rawTitle || headingText,
          category: headerCategory,
          severity: detectSeverity(headingText, currentSectionSeverity),
          filePath,
          startLine,
          endLine,
          bodyLines: [],
          comment: null,
          commentIsEnglish: false,
          pendingEnglishLock: false,
        };
      } else {
        flushFinding();
        currentSectionSeverity = detectSeverity(headingText, currentSectionSeverity);
      }
      continue;
    }

    if (currentFinding) {
      if (/ready-to-paste github comment/i.test(line)) {
        if (/\((?:fr|french|français)\)/i.test(line)) {
          ignoreNextReadyFence = true;
          capturingReadyToPaste = false;
        } else {
          ignoreNextReadyFence = false;
          capturingReadyToPaste = true;
          if (/\((?:en|english)\)/i.test(line)) {
            currentFinding.pendingEnglishLock = true;
          }
        }
        continue;
      }
      currentFinding.bodyLines.push(line);
    }
  }

  // Recover gracefully if an unclosed code fence reached EOF
  if (inFence && fenceBuffer.length > 0 && currentFinding) {
    const blockContent = fenceBuffer.join('\n').trim();
    if (capturingReadyToPaste || standaloneReadySection) {
      if (!currentFinding.comment) currentFinding.comment = blockContent;
    } else {
      currentFinding.bodyLines.push(...fenceBuffer);
    }
  }

  flushFinding();
  return findings;
}

/**
 * Parses unified diff patch hunk headers to extract valid RIGHT-side line numbers
 * and per-hunk line sets (for validating GitHub multi-line comments).
 */
export function parsePatchRightLines(patch) {
  const validRightLines = new Set();
  if (!patch || typeof patch !== 'string') return validRightLines;
  const lines = patch.split('\n');
  let rightLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      rightLine = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      validRightLines.add(rightLine);
      rightLine++;
    } else if (line.startsWith('-')) {
      // deleted line on LEFT side, rightLine does not advance
    } else if (line.startsWith(' ')) {
      validRightLines.add(rightLine);
      rightLine++;
    }
  }
  return validRightLines;
}

export function parsePatchRightHunks(patch) {
  const hunks = [];
  if (!patch || typeof patch !== 'string') return hunks;
  const lines = patch.split('\n');
  let rightLine = 0;
  let currentSet = null;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      rightLine = Number(hunkMatch[1]);
      currentSet = new Set();
      hunks.push(currentSet);
      continue;
    }
    if (!currentSet) continue;
    if (line.startsWith('+') || line.startsWith(' ')) {
      currentSet.add(rightLine);
      rightLine++;
    }
  }
  return hunks;
}

export function parsePatchLeftLines(patch) {
  const validLeftLines = new Set();
  if (!patch || typeof patch !== 'string') return validLeftLines;
  const lines = patch.split('\n');
  let leftLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunkMatch) {
      leftLine = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('-') || line.startsWith(' ')) {
      validLeftLines.add(leftLine);
      leftLine++;
    }
  }
  return validLeftLines;
}

export function parsePatchLeftHunks(patch) {
  const hunks = [];
  if (!patch || typeof patch !== 'string') return hunks;
  const lines = patch.split('\n');
  let leftLine = 0;
  let currentSet = null;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunkMatch) {
      leftLine = Number(hunkMatch[1]);
      currentSet = new Set();
      hunks.push(currentSet);
      continue;
    }
    if (!currentSet) continue;
    if (line.startsWith('-') || line.startsWith(' ')) {
      currentSet.add(leftLine);
      leftLine++;
    }
  }
  return hunks;
}

/**
 * Inspects whether a Markdown comment contains a GitHub ```suggestion block and whether a
 * multi-line [startLine..endLine] range would dangerously replace an oversized span of code.
 */
export function analyzeSuggestionBlockRange(body, startLine = null, endLine = null) {
  const text = String(body || '');
  const sugMatch = text.match(/`{3,}suggestion[^\r\n]*\r?\n([\s\S]*?)\r?\n`{3,}/i);
  if (!sugMatch) {
    return { hasSuggestion: false, suggestionLines: 0, spanLines: 1, oversizedRange: false };
  }
  const suggestionContent = sugMatch[1];
  const suggestionLines = suggestionContent === '' ? 0 : suggestionContent.split(/\r?\n/).length;
  const s = Number(startLine) || 0;
  const e = Number(endLine) || s;
  const spanLines = s > 0 && e >= s ? e - s + 1 : 1;
  const maxSafeSpan = Math.max(6, suggestionLines * 3 + 2);
  const oversizedRange = s > 0 && e > s && spanLines > maxSafeSpan;
  return {
    hasSuggestion: true,
    suggestionLines,
    spanLines,
    oversizedRange,
  };
}

/**
 * Resolves a finding's file path, side (RIGHT or LEFT), and line number (or multi-line range)
 * against the PR's changed files.
 */
export function resolveFindingAgainstDiff(finding, diffFiles) {
  const rawFilePath = finding?.filePath || finding?.path || null;
  const rawStartLine = Number(finding?.startLine ?? finding?.lineStart) || null;
  const rawEndLine = Number(finding?.endLine ?? finding?.lineEnd ?? finding?.line) || null;
  const requestedSide = String(finding?.side || finding?.diffSide || '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';

  if (!rawFilePath || !Array.isArray(diffFiles) || diffFiles.length === 0) {
    return {
      resolvedPath: rawFilePath,
      resolvedStartLine: rawStartLine && rawEndLine && rawStartLine < rawEndLine ? rawStartLine : null,
      resolvedLine: rawEndLine || rawStartLine || null,
      resolvedSide: requestedSide,
      inDiff: false,
    };
  }
  const target = rawFilePath.replace(/^\/+/, '');
  const basename = path.basename(target);

  let matchedFile = diffFiles.find((f) => f.filename === target);
  if (!matchedFile) {
    matchedFile = diffFiles.find(
      (f) => f.filename.endsWith('/' + target) || target.endsWith('/' + f.filename) || f.filename.endsWith(target)
    );
  }
  if (!matchedFile && basename && !basename.includes('*')) {
    const candidates = diffFiles.filter((f) => path.basename(f.filename) === basename);
    if (candidates.length === 1) matchedFile = candidates[0];
  }

  if (!matchedFile) {
    return {
      resolvedPath: rawFilePath,
      resolvedStartLine: rawStartLine && rawEndLine && rawStartLine < rawEndLine ? rawStartLine : null,
      resolvedLine: rawEndLine || rawStartLine || null,
      resolvedSide: requestedSide,
      inDiff: false,
    };
  }

  const patch = matchedFile.patch || '';
  const rightLines = parsePatchRightLines(patch);
  const rightHunks = parsePatchRightHunks(patch);
  const leftLines = parsePatchLeftLines(patch);
  const leftHunks = parsePatchLeftHunks(patch);

  // Use LEFT side if explicitly requested or if the file only has deleted lines (e.g. removed file)
  const useLeft =
    (requestedSide === 'LEFT' && leftLines.size > 0) ||
    (rightLines.size === 0 && leftLines.size > 0);
  const resolvedSide = useLeft ? 'LEFT' : 'RIGHT';
  const validLines = useLeft ? leftLines : rightLines;
  const hunks = useLeft ? leftHunks : rightHunks;
  const desiredLine = rawEndLine || rawStartLine;

  if (!desiredLine || validLines.size === 0) {
    const firstLine = validLines.size > 0 ? [...validLines][0] : 1;
    return {
      resolvedPath: matchedFile.filename,
      resolvedStartLine: null,
      resolvedLine: desiredLine || firstLine,
      resolvedSide,
      inDiff: validLines.size > 0,
    };
  }

  const commentBody = finding?.commentBody ?? finding?.customComment ?? finding?.comment ?? '';
  const sugCheck = analyzeSuggestionBlockRange(commentBody, rawStartLine, desiredLine);

  if (validLines.has(desiredLine)) {
    let resolvedStartLine = null;
    if (rawStartLine && rawStartLine < desiredLine && !sugCheck.oversizedRange) {
      const sameHunk = hunks.some((h) => h.has(rawStartLine) && h.has(desiredLine));
      if (sameHunk) {
        resolvedStartLine = rawStartLine;
      }
    }
    return {
      resolvedPath: matchedFile.filename,
      resolvedStartLine,
      resolvedLine: desiredLine,
      resolvedSide,
      inDiff: true,
      ...(sugCheck.oversizedRange ? { droppedOversizedSuggestionRange: `${rawStartLine}-${desiredLine}` } : {}),
    };
  }

  // Snap to closest line in the diff patch so GitHub API accepts inline comments
  let closest = [...validLines][0];
  let minDistance = Math.abs(desiredLine - closest);
  for (const l of validLines) {
    const d = Math.abs(desiredLine - l);
    if (d < minDistance) {
      minDistance = d;
      closest = l;
    }
  }
  return {
    resolvedPath: matchedFile.filename,
    resolvedStartLine: null,
    resolvedLine: closest,
    resolvedSide,
    inDiff: true,
    snappedFrom: desiredLine,
  };
}

/**
 * Computes GitHub-style intra-line diff character ranges [start, end) for a pair of modified lines.
 * Expects raw code content WITHOUT the leading '-' / '+' diff marker.
 */
export function computeIntraLineDiffRanges(oldCode, newCode) {
  const a = String(oldCode ?? '');
  const b = String(newCode ?? '');
  if (a === b || (!a.trim() && !b.trim())) {
    return { highlight: false, delRanges: [], addRanges: [] };
  }

  // Tokenize into identifier/word runs, whitespace runs, or single punctuation characters
  const tokenize = (str) => {
    const out = [];
    const re = /[A-Za-z0-9_]+|\s+|./gs;
    let m;
    while ((m = re.exec(str)) !== null) {
      out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return out;
  };

  const tokA = tokenize(a);
  const tokB = tokenize(b);

  // Trim identical leading and trailing tokens first (fast path)
  let prefixCount = 0;
  const minLen = Math.min(tokA.length, tokB.length);
  while (prefixCount < minLen && tokA[prefixCount].text === tokB[prefixCount].text) {
    prefixCount++;
  }

  let suffixCount = 0;
  while (
    suffixCount < minLen - prefixCount &&
    tokA[tokA.length - 1 - suffixCount].text === tokB[tokB.length - 1 - suffixCount].text
  ) {
    suffixCount++;
  }

  const midA = tokA.slice(prefixCount, tokA.length - suffixCount);
  const midB = tokB.slice(prefixCount, tokB.length - suffixCount);

  // Guard against overly huge lines where O(N*M) DP would be expensive
  if (midA.length * midB.length > 16000) {
    const delStart = midA.length > 0 ? midA[0].start : 0;
    const delEnd = midA.length > 0 ? midA[midA.length - 1].end : 0;
    const addStart = midB.length > 0 ? midB[0].start : 0;
    const addEnd = midB.length > 0 ? midB[midB.length - 1].end : 0;
    const unchangedChars =
      (prefixCount > 0 ? tokA[prefixCount - 1].end : 0) +
      (suffixCount > 0 ? a.length - tokA[tokA.length - suffixCount].start : 0);
    if (unchangedChars === 0) {
      return { highlight: false, delRanges: [], addRanges: [] };
    }
    return {
      highlight: true,
      delRanges: delEnd > delStart ? [[delStart, delEnd]] : [],
      addRanges: addEnd > addStart ? [[addStart, addEnd]] : [],
    };
  }

  // Token-level LCS on the middle slice
  const n = midA.length;
  const m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (midA[i].text === midB[j].text) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const keepA = new Uint8Array(tokA.length);
  const keepB = new Uint8Array(tokB.length);
  for (let k = 0; k < prefixCount; k++) {
    keepA[k] = 1;
    keepB[k] = 1;
  }
  for (let k = 0; k < suffixCount; k++) {
    keepA[tokA.length - 1 - k] = 1;
    keepB[tokB.length - 1 - k] = 1;
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i].text === midB[j].text) {
      keepA[prefixCount + i] = 1;
      keepB[prefixCount + j] = 1;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // Check similarity ratio: if two lines share zero non-whitespace tokens (completely different lines),
  // avoid highlighting the entire line unless they share a meaningful character prefix/suffix.
  let sharedNonWsChars = 0;
  for (let k = 0; k < tokA.length; k++) {
    if (keepA[k] && tokA[k].text.trim()) {
      sharedNonWsChars += tokA[k].text.length;
    }
  }
  const totalNonWsChars = Math.max(a.replace(/\s+/g, '').length, b.replace(/\s+/g, '').length, 1);

  const toMergedRanges = (tokens, keepFlags) => {
    const raw = [];
    for (let k = 0; k < tokens.length; k++) {
      if (!keepFlags[k]) {
        if (raw.length > 0 && raw[raw.length - 1][1] === tokens[k].start) {
          raw[raw.length - 1][1] = tokens[k].end;
        } else {
          raw.push([tokens[k].start, tokens[k].end]);
        }
      }
    }
    // Coalesce tiny whitespace-only gaps between two adjacent changed spans (GitHub readability polish)
    const coalesced = [];
    for (const r of raw) {
      if (coalesced.length > 0) {
        const prev = coalesced[coalesced.length - 1];
        const gapLen = r[0] - prev[1];
        if (gapLen > 0 && gapLen <= 2) {
          prev[1] = r[1];
          continue;
        }
      }
      coalesced.push([...r]);
    }
    return coalesced;
  };

  let delRanges = toMergedRanges(tokA, keepA);
  let addRanges = toMergedRanges(tokB, keepB);

  // Sub-token refinement when a single range changed on both sides (e.g. getZipCode -> getPostalCode)
  if (delRanges.length === 1 && addRanges.length === 1) {
    let [ds, de] = delRanges[0];
    let [as, ae] = addRanges[0];
    while (ds < de && as < ae && a[ds] === b[as]) {
      ds++;
      as++;
      sharedNonWsChars++;
    }
    while (de > ds && ae > as && a[de - 1] === b[ae - 1]) {
      de--;
      ae--;
      sharedNonWsChars++;
    }
    delRanges = de > ds ? [[ds, de]] : [];
    addRanges = ae > as ? [[as, ae]] : [];
  }

  // Only highlight intra-line changes when the two lines actually share context (>= 20% non-ws similarity,
  // or pure indentation/punctuation change where sharedNonWsChars > 0)
  if (sharedNonWsChars === 0 || sharedNonWsChars / totalNonWsChars < 0.18) {
    return { highlight: false, delRanges: [], addRanges: [] };
  }

  return {
    highlight: delRanges.length > 0 || addRanges.length > 0,
    delRanges,
    addRanges,
  };
}
