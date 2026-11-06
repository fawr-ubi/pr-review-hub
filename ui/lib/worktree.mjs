import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function getProjectsDir(cfg = {}) {
  if (cfg.projectsDir) return cfg.projectsDir;
  if (process.env.REVIEW_HUB_PROJECTS_DIR) return process.env.REVIEW_HUB_PROJECTS_DIR;
  return path.join(os.homedir(), 'Ubitransport', 'projects');
}

export function getLocalRepoPath(projectsDir, repo) {
  const safeRepo = path.basename(String(repo || ''));
  return path.join(projectsDir, safeRepo);
}

export function getWorktreePath(projectsDir, repo, number) {
  const safeRepo = path.basename(String(repo || ''));
  const safeNum = Number(number);
  return path.join(projectsDir, '.review-worktrees', `${safeRepo}-pr-${safeNum}`);
}

export async function commitExistsLocally(repoPath, sha) {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  try {
    await execFileAsync('git', ['-C', repoPath, 'cat-file', '-e', `${sha}^{commit}`], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function ensurePrCommitFetched(repoPath, number, headSha = '') {
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Local repository not found at ${repoPath}`);
  }

  if (headSha && (await commitExistsLocally(repoPath, headSha))) {
    return headSha;
  }

  const refName = `refs/review-hub/pr-${Number(number)}`;
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'fetch', '--no-tags', 'origin', `pull/${Number(number)}/head:${refName}`],
      { timeout: 45000 }
    );
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', refName], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch (err) {
    if (headSha && (await commitExistsLocally(repoPath, headSha))) {
      return headSha;
    }
    throw new Error(`Unable to fetch PR #${number} in ${repoPath}: ${err.message}`);
  }
}

export async function listTreeAtCommit(repoPath, commitRef, dirPath = '', recursive = false) {
  const cleanDir = String(dirPath || '').replace(/^\/+|\/+$/g, '');
  if (cleanDir.includes('..')) {
    throw new Error('Invalid directory path');
  }

  if (recursive) {
    const args = ['-C', repoPath, 'ls-tree', '-r', '--name-only', commitRef];
    if (cleanDir) args.push(cleanDir);
    const { stdout } = await execFileAsync('git', args, { maxBuffer: 15 * 1024 * 1024 });
    const files = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6000);
    return { recursive: true, files };
  }

  const targetArg = cleanDir ? `${cleanDir}/` : '';
  const args = ['-C', repoPath, 'ls-tree', commitRef];
  if (targetArg) args.push(targetArg);

  const { stdout } = await execFileAsync('git', args, { maxBuffer: 5 * 1024 * 1024 });
  const entries = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // format: <mode> <type> <sha>\t<path>
      const [meta, filePath] = line.split('\t');
      const [mode, type, sha] = (meta || '').trim().split(/\s+/);
      const name = path.posix.basename(filePath || '');
      return { mode, type, sha, path: filePath, name };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { recursive: false, dirPath: cleanDir, entries };
}

export async function readBlobAtCommit(repoPath, commitRef, filePath) {
  const cleanPath = String(filePath || '').replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('..')) {
    throw new Error('Invalid file path');
  }

  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'show', `${commitRef}:${cleanPath}`], {
    maxBuffer: 12 * 1024 * 1024,
  });

  return {
    filePath: cleanPath,
    content: stdout,
    lineCount: stdout.split('\n').length,
  };
}

export async function grepAtCommit(repoPath, commitRef, query, subPath = '') {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery || cleanQuery.length < 2) {
    return { query: cleanQuery, matches: [] };
  }

  const args = ['-C', repoPath, 'grep', '-n', '-I', '-i', '--max-count=25', '-e', cleanQuery, commitRef];
  const cleanSub = String(subPath || '').replace(/^\/+/, '');
  if (cleanSub && !cleanSub.includes('..')) {
    args.push('--', cleanSub);
  }

  try {
    const { stdout } = await execFileAsync('git', args, { maxBuffer: 8 * 1024 * 1024 });
    const prefix = `${commitRef}:`;
    const matches = [];
    for (const rawLine of stdout.split('\n')) {
      if (!rawLine) continue;
      const withoutRef = rawLine.startsWith(prefix) ? rawLine.slice(prefix.length) : rawLine;
      const firstColon = withoutRef.indexOf(':');
      if (firstColon === -1) continue;
      const secondColon = withoutRef.indexOf(':', firstColon + 1);
      if (secondColon === -1) continue;
      const filePath = withoutRef.slice(0, firstColon);
      const lineNum = Number(withoutRef.slice(firstColon + 1, secondColon));
      const text = withoutRef.slice(secondColon + 1).slice(0, 300);
      matches.push({ filePath, line: lineNum, text });
      if (matches.length >= 150) break;
    }
    return { query: cleanQuery, matches };
  } catch (err) {
    // git grep exits with code 1 when no matches are found
    if (err.code === 1) {
      return { query: cleanQuery, matches: [] };
    }
    throw err;
  }
}

export async function getWorktreeStatus(projectsDir, repo, number) {
  const repoPath = getLocalRepoPath(projectsDir, repo);
  const worktreePath = getWorktreePath(projectsDir, repo, number);
  const exists = fs.existsSync(worktreePath);

  if (!exists) {
    return {
      mounted: false,
      repoExists: fs.existsSync(repoPath),
      repoPath,
      worktreePath,
      headSha: null,
    };
  }

  let headSha = null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
      timeout: 3000,
    });
    headSha = stdout.trim();
  } catch {
    // ignore
  }

  return {
    mounted: true,
    repoExists: fs.existsSync(repoPath),
    repoPath,
    worktreePath,
    headSha,
  };
}

async function copyVendorApfsIfPresent(srcVendor, destVendor) {
  if (!fs.existsSync(srcVendor) || fs.existsSync(destVendor)) return false;
  fs.mkdirSync(path.dirname(destVendor), { recursive: true });
  try {
    // macOS APFS Copy-on-Write (-c) is instant and uses 0 disk blocks
    await execFileAsync('cp', ['-Rc', srcVendor, destVendor], { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

export async function mountWorktree({ projectsDir, repo, number, headSha, changedFiles = [] }) {
  const repoPath = getLocalRepoPath(projectsDir, repo);
  const worktreePath = getWorktreePath(projectsDir, repo, number);

  const resolvedSha = await ensurePrCommitFetched(repoPath, number, headSha);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  if (fs.existsSync(worktreePath)) {
    await execFileAsync('git', ['-C', worktreePath, 'checkout', '--detach', resolvedSha], {
      timeout: 20000,
    });
  } else {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 5000 }).catch(() => {});
    await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, resolvedSha],
      { timeout: 30000 }
    );
  }

  // Fast APFS Copy-on-Write vendor initialization
  const clonedVendors = [];
  if (await copyVendorApfsIfPresent(path.join(repoPath, 'vendor'), path.join(worktreePath, 'vendor'))) {
    clonedVendors.push('vendor');
  }
  if (
    await copyVendorApfsIfPresent(
      path.join(repoPath, 'projects', 'common', 'vendor'),
      path.join(worktreePath, 'projects', 'common', 'vendor')
    )
  ) {
    clonedVendors.push('projects/common/vendor');
  }

  const services = new Set();
  for (const f of changedFiles) {
    const filename = typeof f === 'string' ? f : f?.filename || '';
    const m = filename.match(/^projects\/services\/([^/]+)\//);
    if (m) services.add(m[1]);
  }
  for (const svc of services) {
    const relVendor = path.join('projects', 'services', svc, 'vendor');
    if (await copyVendorApfsIfPresent(path.join(repoPath, relVendor), path.join(worktreePath, relVendor))) {
      clonedVendors.push(relVendor);
    }
  }

  return {
    mounted: true,
    repoPath,
    worktreePath,
    headSha: resolvedSha,
    clonedVendors,
  };
}

export async function unmountWorktree({ projectsDir, repo, number }) {
  const repoPath = getLocalRepoPath(projectsDir, repo);
  const worktreePath = getWorktreePath(projectsDir, repo, number);

  if (!fs.existsSync(worktreePath)) {
    return { mounted: false, worktreePath };
  }

  try {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
      timeout: 15000,
    });
  } catch {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 5000 }).catch(() => {});
  }

  return { mounted: false, worktreePath };
}

export async function openWorktreeInIde({
  projectsDir,
  repo,
  number,
  headSha,
  ide = 'phpstorm',
  filePath = '',
  line = null,
  changedFiles = [],
}) {
  const status = await mountWorktree({ projectsDir, repo, number, headSha, changedFiles });
  const wtPath = status.worktreePath;
  const cleanRel = String(filePath || '').replace(/^\/+/, '');
  const fullTargetFile = cleanRel && !cleanRel.includes('..') ? path.join(wtPath, cleanRel) : null;

  if (ide === 'code' || ide === 'vscode') {
    const bin = fs.existsSync('/opt/homebrew/bin/code') ? '/opt/homebrew/bin/code' : 'code';
    const args = [wtPath];
    if (fullTargetFile && fs.existsSync(fullTargetFile)) {
      args.push('--goto', `${fullTargetFile}:${Number(line) || 1}`);
    }
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, ide: 'code', worktreePath: wtPath };
  }

  // Default: PhpStorm
  const bin = fs.existsSync('/opt/homebrew/bin/phpstorm') ? '/opt/homebrew/bin/phpstorm' : 'phpstorm';
  const args = [wtPath];
  if (fullTargetFile && fs.existsSync(fullTargetFile)) {
    if (line) args.push('--line', String(Number(line)));
    args.push(fullTargetFile);
  }
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, ide: 'phpstorm', worktreePath: wtPath };
}
