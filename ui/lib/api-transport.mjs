import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_API_MODEL = 'gemini-2.5-flash';
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const MAX_FILE_READ_LINES = 300;
const MAX_FILE_READ_BYTES = 25 * 1024;

/**
 * Resolves which AI transport to use (`vertex`, `gemini-api`, or `cli`)
 * from config and environment variables without requiring static GCP keys locally.
 */
export function resolveApiTransportConfig(cfg = {}, env = process.env) {
  const requestedMode = String(
    env.REVIEW_HUB_RUNNER_MODE || cfg.agentRunnerMode || 'auto'
  )
    .trim()
    .toLowerCase();
  const projectId = String(env.GCP_PROJECT_ID || cfg.gcpProjectId || '').trim();
  const location = String(env.GCP_LOCATION || cfg.gcpLocation || 'global').trim() || 'global';
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const configuredModel = String(env.REVIEW_HUB_MODEL || cfg.agentModel || '').trim();

  let transport = 'cli';
  if (requestedMode === 'vertex') {
    transport = 'vertex';
  } else if (requestedMode === 'gemini-api') {
    transport = 'gemini-api';
  } else if (requestedMode === 'cli') {
    transport = 'cli';
  } else {
    // auto: prefer Vertex AI when GCP_PROJECT_ID is present, then GEMINI_API_KEY, else local CLI
    if (projectId) {
      transport = 'vertex';
    } else if (apiKey) {
      transport = 'gemini-api';
    } else {
      transport = 'cli';
    }
  }

  return {
    transport,
    modelId:
      configuredModel || (transport === 'cli' ? '' : DEFAULT_API_MODEL),
    projectId,
    location,
    apiKey,
  };
}

export function buildVertexGenerateUrl({ projectId, location = 'global', modelId }) {
  const cleanModel = String(modelId || DEFAULT_API_MODEL).replace(/^models\//, '');
  const loc = String(location || 'global').trim().toLowerCase();
  const host =
    loc === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${loc}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(cleanModel)}:generateContent`;
}

export function buildGeminiApiUrl({ modelId }) {
  const cleanModel = String(modelId || DEFAULT_API_MODEL).replace(/^models\//, '');
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
}

/**
 * Acquires a GCP OAuth2 Bearer token via GCE/Cloud Run metadata server first,
 * falling back to local `gcloud auth application-default print-access-token`.
 */
export async function fetchGcpAccessToken({
  fetchFn = globalThis.fetch,
  execFn = execFileAsync,
} = {}) {
  try {
    const res = await fetchFn(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(2500),
      }
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.access_token) {
        return String(data.access_token).trim();
      }
    }
  } catch {
    // Not running on GCE/Cloud Run metadata server; fall back to gcloud ADC
  }

  try {
    const { stdout } = await execFn('gcloud', ['auth', 'application-default', 'print-access-token'], {
      timeout: 5000,
    });
    const token = String(stdout || '').trim();
    if (token) return token;
  } catch (err) {
    throw new Error(
      `Unable to acquire GCP ADC token (metadata server unavailable and gcloud ADC failed): ${err?.message || err}`
    );
  }
  throw new Error('GCP ADC returned an empty access token.');
}

/**
 * Validates a repo-relative path and fetches its contents at `headSha` via GitHub API.
 */
export async function fetchRepoFileFromGithub({
  org,
  repo,
  filePath,
  headSha = 'HEAD',
  execFn = execFileAsync,
}) {
  const rawPath = String(filePath || '').trim().replace(/^\/+/, '');
  if (!rawPath || rawPath.includes('..') || path.isAbsolute(rawPath) || rawPath.includes('\0')) {
    return { ok: false, error: `Invalid or unsafe file path: "${filePath}"` };
  }
  if (!org || !repo) {
    return { ok: false, error: 'Missing GitHub org/repo context for read_repo_file.' };
  }

  const encodedPath = rawPath.split('/').map(encodeURIComponent).join('/');
  const refParam = headSha && headSha !== 'HEAD' ? `?ref=${encodeURIComponent(headSha)}` : '';
  const endpoint = `repos/${org}/${repo}/contents/${encodedPath}${refParam}`;

  try {
    const { stdout } = await execFn('gh', ['api', endpoint], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15000,
    });
    const data = JSON.parse(stdout || '{}');
    if (Array.isArray(data)) {
      return {
        ok: true,
        path: rawPath,
        type: 'directory',
        entries: data.slice(0, 50).map((e) => `${e.type}: ${e.path}`),
      };
    }
    if (data?.encoding === 'base64' && typeof data?.content === 'string') {
      const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      const truncatedBytes =
        decoded.length > MAX_FILE_READ_BYTES ? decoded.slice(0, MAX_FILE_READ_BYTES) : decoded;
      const lines = truncatedBytes.split('\n');
      const clippedLines =
        lines.length > MAX_FILE_READ_LINES
          ? `${lines.slice(0, MAX_FILE_READ_LINES).join('\n')}\n\n[... Truncated at ${MAX_FILE_READ_LINES} lines ...]`
          : truncatedBytes;
      return {
        ok: true,
        path: rawPath,
        type: 'file',
        content: clippedLines,
      };
    }
    return { ok: false, error: `Unsupported GitHub content encoding for "${rawPath}".` };
  } catch (err) {
    return {
      ok: false,
      error: `File "${rawPath}" not found or unreadable at ref ${headSha}: ${err?.message || err}`,
    };
  }
}

const READ_REPO_FILE_TOOL_DECL = {
  functionDeclarations: [
    {
      name: 'read_repo_file',
      description:
        'Read a single file from the PR target repository at the PR head commit to verify an interface, base class, DTO, or caller outside the diff. Maximum 3 calls per review.',
      parameters: {
        type: 'OBJECT',
        properties: {
          path: {
            type: 'STRING',
            description: 'Repository-relative path to the file (e.g., "src/Domain/UserInterface.php").',
          },
        },
        required: ['path'],
      },
    },
  ],
};

function extractTextAndFunctionCalls(responseJson) {
  const candidate = responseJson?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const texts = [];
  const calls = [];
  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.trim()) {
      texts.push(part.text);
    }
    if (part?.functionCall && part.functionCall.name) {
      calls.push(part.functionCall);
    }
  }
  return {
    content: candidate?.content || null,
    text: texts.join('\n').trim(),
    functionCalls: calls,
    finishReason: candidate?.finishReason || '',
  };
}

async function postJsonWithRetry(url, headers, body, { fetchFn = globalThis.fetch, timeoutMs = 180000 } = {}) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        return await res.json();
      }
      const errBody = await res.text().catch(() => '');
      if (TRANSIENT_HTTP_STATUSES.has(res.status) && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      throw new Error(`AI API HTTP ${res.status}: ${errBody.slice(0, 400)}`);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && !String(err?.message || '').startsWith('AI API HTTP 4')) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('AI API request failed.');
}

/**
 * Executes a prompt directly against Vertex AI or Gemini API HTTP endpoints,
 * with bounded lightweight Function Calling (`read_repo_file`, max 3 calls).
 */
export async function runGeminiApiPrompt({
  prompt,
  transport = 'gemini-api',
  modelId = DEFAULT_API_MODEL,
  projectId = '',
  location = 'global',
  apiKey = '',
  prContext = null,
  maxToolCalls = 3,
  timeoutMs = 180000,
  onStreamUpdate = null,
  fetchFn = globalThis.fetch,
  tokenProvider = null,
  githubFileFetcher = fetchRepoFileFromGithub,
}) {
  const isVertex = transport === 'vertex';
  let url = '';
  const headers = { 'Content-Type': 'application/json' };

  if (isVertex) {
    if (!projectId) {
      throw new Error('GCP_PROJECT_ID (gcpProjectId) is required for Vertex AI transport.');
    }
    const token = tokenProvider
      ? await tokenProvider()
      : await fetchGcpAccessToken({ fetchFn });
    url = buildVertexGenerateUrl({ projectId, location, modelId });
    headers.Authorization = `Bearer ${token}`;
  } else {
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required for Gemini API transport.');
    }
    url = buildGeminiApiUrl({ modelId });
    headers['x-goog-api-key'] = apiKey;
  }

  const toolsAllowed = Boolean(prContext?.org && prContext?.repo && maxToolCalls > 0);
  const contents = [{ role: 'user', parts: [{ text: String(prompt || '') }] }];
  let toolCallsUsed = 0;

  onStreamUpdate?.({
    phase: `Calling ${isVertex ? 'Vertex AI' : 'Gemini API'} (${modelId})…`,
    partialText: '',
  });

  // Allow up to `maxToolCalls` tool turns + 1 final synthesis turn
  for (let turn = 0; turn <= maxToolCalls; turn++) {
    const canOfferTools = toolsAllowed && toolCallsUsed < maxToolCalls;
    const payload = {
      contents,
      ...(canOfferTools ? { tools: [READ_REPO_FILE_TOOL_DECL] } : {}),
    };

    const json = await postJsonWithRetry(url, headers, payload, { fetchFn, timeoutMs });
    const { content, text, functionCalls } = extractTextAndFunctionCalls(json);

    if (!functionCalls.length || !canOfferTools) {
      if (!text) {
        throw new Error('AI API returned an empty response.');
      }
      return text;
    }

    if (content) {
      contents.push(content);
    }

    const responseParts = [];
    for (const fc of functionCalls) {
      if (fc.name !== 'read_repo_file' || toolCallsUsed >= maxToolCalls) {
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: {
              ok: false,
              error: `Tool call rejected (limit ${maxToolCalls} reached or unknown tool).`,
            },
          },
        });
        continue;
      }
      toolCallsUsed++;
      const requestedPath = String(fc.args?.path || '');
      onStreamUpdate?.({
        phase: `Inspecting repo file (${requestedPath}) [${toolCallsUsed}/${maxToolCalls}]…`,
        partialText: '',
        toolName: 'read_repo_file',
      });
      const result = await githubFileFetcher({
        org: prContext.org,
        repo: prContext.repo,
        filePath: requestedPath,
        headSha: prContext.headSha || 'HEAD',
      });
      responseParts.push({
        functionResponse: {
          name: 'read_repo_file',
          response: result,
        },
      });
    }

    contents.push({ role: 'user', parts: responseParts });
  }

  throw new Error('AI API exceeded maximum function-calling turns without final output.');
}
