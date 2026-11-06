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
    const category =
      (bodyCategoryMatch ? bodyCategoryMatch[1].trim() : null) ||
      currentFinding.category ||
      null;

    findings.push({
      id: currentFinding.id,
      title: sanitizeFindingTitle(currentFinding.title) || currentFinding.title,
      category,
      severity: currentFinding.severity,
      filePath: currentFinding.filePath,
      startLine: currentFinding.startLine,
      endLine: currentFinding.endLine,
      explanation: rawBody,
      comment: currentFinding.comment.trim(),
    });
    currentFinding = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check code fence transitions (supports 3 or 4 backticks)
    const fenceMatch = line.match(/^(`{3,4})([^\s`]*)\s*$/);
    if (!inFence && fenceMatch) {
      inFence = true;
      fenceTicks = fenceMatch[1];
      fenceBuffer = [];
      if (currentFinding && !capturingReadyToPaste && !ignoreNextReadyFence && !standaloneReadySection) {
        currentFinding.bodyLines.push(line);
      }
      continue;
    }

    if (inFence) {
      const closeRegex = new RegExp(`^${fenceTicks}\\s*$`);
      if (closeRegex.test(line)) {
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

  flushFinding();
  return findings;
}

/**
 * Parses unified diff patch hunk headers to extract valid RIGHT-side line numbers.
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

/**
 * Resolves a finding's file path and line number against the PR's changed files.
 */
export function resolveFindingAgainstDiff(finding, diffFiles) {
  const rawFilePath = finding?.filePath || finding?.path || null;
  const rawStartLine = finding?.startLine ?? finding?.lineStart ?? null;
  const rawEndLine = finding?.endLine ?? finding?.lineEnd ?? null;

  if (!rawFilePath || !Array.isArray(diffFiles) || diffFiles.length === 0) {
    return {
      resolvedPath: rawFilePath,
      resolvedLine: rawEndLine || rawStartLine || null,
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
      resolvedLine: rawEndLine || rawStartLine || null,
      inDiff: false,
    };
  }

  const validLines = parsePatchRightLines(matchedFile.patch || '');
  const desiredLine = rawEndLine || rawStartLine;

  if (!desiredLine || validLines.size === 0) {
    const firstLine = validLines.size > 0 ? [...validLines][0] : 1;
    return {
      resolvedPath: matchedFile.filename,
      resolvedLine: desiredLine || firstLine,
      inDiff: validLines.size > 0,
    };
  }

  if (validLines.has(desiredLine)) {
    return { resolvedPath: matchedFile.filename, resolvedLine: desiredLine, inDiff: true };
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
  return { resolvedPath: matchedFile.filename, resolvedLine: closest, inDiff: true, snappedFrom: desiredLine };
}
