/**
 * NormaHub AI Code Review Analyzer.
 * Communicates with NormaHub API, instructs models with senior review guidelines,
 * and parses structured JSON findings.
 */

const NORMAHUB_ENDPOINT = 'https://api.normahub.cc/v1/chat/completions';

export const SEVERITY_RANK = { SUGGESTION: 0, WARNING: 1, CRITICAL: 2 };
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];

const SYSTEM_PROMPT = `You are a Principal Software Engineer and Application Security Auditor performing an automated code review on a GitHub Pull Request.

Your goal is to provide high-signal, actionable feedback that developers actually appreciate.

GUIDELINES:
1. DO NOT comment on code formatting, whitespace, indentations, or semicolon placement. Linters (ESLint, Prettier, Ruff) handle style.
2. FOCUS STRICTLY ON:
   - Security Vulnerabilities: injection flaws, unescaped inputs, hardcoded secrets/tokens, SSRF, IDOR, auth bypass.
   - Critical Bugs & Logic Errors: unhandled null/undefined, race conditions, unhandled async promise rejections, off-by-one errors.
   - Resource & Memory Leaks: unclosed database/HTTP connections, unclosed file descriptors, dangling event listeners.
   - Performance Regressions: N+1 query loops, unintended O(N^2) complexity on large collections.
3. If the code is well-written and contains no critical flaws, set "risk_level" to "LOW" and keep "findings" empty. DO NOT invent fake issues.
4. Always provide concrete, minimal replacement code snippets in "suggestion" when pointing out a bug.

REQUIRED JSON OUTPUT FORMAT:
Output ONLY a single valid JSON object, enclosed inside a \`\`\`json markdown fence, with this exact schema:
{
  "summary": "1-2 sentences summarizing the PR change",
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "findings": [
    {
      "file": "path/to/file.ext",
      "line": 42,
      "severity": "CRITICAL" | "WARNING" | "SUGGESTION",
      "title": "Short descriptive title",
      "description": "Precise explanation of what could go wrong and why",
      "suggestion": "Clean replacement code snippet or pattern"
    }
  ],
  "positives": ["Optional bullet points highlighting good practices or clean architecture"]
}`;

const EMPTY_ANALYSIS = {
  summary: 'Automated review completed.',
  risk_level: 'LOW',
  findings: [],
  positives: [],
};

/**
 * Normalizes a model-provided severity to the CRITICAL/WARNING/SUGGESTION enum.
 * Models frequently answer in lowercase or use synonyms; without this mapping
 * such findings were silently downgraded to SUGGESTION and escaped
 * `fail_on_critical`.
 * @param {unknown} value
 * @returns {'CRITICAL'|'WARNING'|'SUGGESTION'}
 */
export function normalizeSeverity(value) {
  const severity = String(value ?? '').trim().toUpperCase();
  if (['CRITICAL', 'BLOCKER', 'ERROR', 'HIGH', 'SEVERE'].includes(severity)) return 'CRITICAL';
  if (['WARNING', 'WARN', 'MEDIUM', 'MODERATE', 'MAJOR'].includes(severity)) return 'WARNING';
  return 'SUGGESTION';
}

/**
 * Normalizes the findings array: coerces types, validates line numbers and
 * drops entries that cannot be rendered.
 * @param {unknown} findings
 * @returns {Array<{file: string, line: number|null, severity: string, title: string, description: string, suggestion: string}>}
 */
export function normalizeFindings(findings) {
  if (!Array.isArray(findings)) return [];

  const normalized = [];
  for (const item of findings) {
    if (!item || typeof item !== 'object') continue;

    const file = typeof item.file === 'string' ? item.file.trim() : '';
    const rawLine = Number(item.line);
    const line = Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;

    const description = typeof item.description === 'string' ? item.description : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!file && !description && !title) continue;

    normalized.push({
      file: file || 'General',
      line,
      severity: normalizeSeverity(item.severity),
      title: title || 'Code Finding',
      description,
      suggestion: typeof item.suggestion === 'string' ? item.suggestion : '',
    });
  }

  return normalized;
}

/**
 * Drops findings below the configured minimum severity.
 * @param {Array<object>} findings
 * @param {string} [minSeverity='SUGGESTION']
 * @returns {Array<object>}
 */
export function filterByMinSeverity(findings, minSeverity = 'SUGGESTION') {
  const threshold = SEVERITY_RANK[String(minSeverity || '').toUpperCase()];
  if (threshold === undefined) return Array.isArray(findings) ? findings : [];
  return (Array.isArray(findings) ? findings : []).filter(
    (finding) => (SEVERITY_RANK[finding.severity] ?? 0) >= threshold
  );
}

/**
 * Turns a parsed JSON object into the canonical analysis shape.
 * @param {object} parsed
 * @returns {object}
 */
function normalizeAnalysis(parsed) {
  const risk = String(parsed.risk_level ?? '').trim().toUpperCase();
  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary
      : 'Code review completed.',
    risk_level: RISK_LEVELS.includes(risk) ? risk : 'LOW',
    findings: normalizeFindings(parsed.findings),
    positives: Array.isArray(parsed.positives)
      ? parsed.positives.filter((p) => typeof p === 'string' && p.trim())
      : [],
  };
}

/**
 * Parses and sanitizes JSON from model response text.
 * @param {string} rawText
 * @returns {object}
 */
export function extractJsonFromResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { ...EMPTY_ANALYSIS };
  }

  // Prefer explicitly labelled ```json fences, then any fence, then raw text,
  // then the outermost brace pair. A model that explains itself before the
  // payload (e.g. prints a diff snippet fence first) used to break parsing.
  const candidates = [];
  for (const match of rawText.matchAll(/```json\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
  for (const match of rawText.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)) candidates.push(match[1]);
  candidates.push(rawText.trim());

  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(rawText.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const text = candidate.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeAnalysis(parsed);
      }
    } catch {
      // try the next candidate
    }
  }

  // Fallback: If not valid JSON, treat as unstructured summary
  return {
    summary: rawText.substring(0, 500),
    risk_level: 'MEDIUM',
    findings: [
      {
        file: 'General',
        line: null,
        severity: 'SUGGESTION',
        title: 'Review Summary',
        description: rawText,
        suggestion: '',
      },
    ],
    positives: [],
  };
}

/**
 * Builds an Error carrying the HTTP status for retry classification.
 * @param {number} status
 * @param {string} body
 * @returns {Error & { status?: number }}
 */
function httpError(status, body) {
  const snippet = String(body || '').slice(0, 300);
  const err = new Error(`NormaHub API HTTP ${status}: ${snippet}`);
  err.status = status;
  return err;
}

/**
 * Reads a Retry-After value (seconds or HTTP date) in milliseconds.
 * @param {string|null} header
 * @returns {number|null}
 */
function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Invokes NormaHub API to analyze the given git diff.
 * Retries only transient failures (429, 5xx, network); client errors such as
 * 400/401/403 fail immediately instead of burning three attempts.
 * @param {string} diff
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.model='deepseek-v4.1-flash']
 * @param {number} [options.temperature=0.1]
 * @param {number} [options.timeoutMs=60000]
 * @param {number} [options.maxAttempts=3]
 * @param {Function} [options.sleep]
 * @returns {Promise<object>}
 */
export async function analyzeDiff(diff, options = {}) {
  const apiKey = options.apiKey;
  const model = options.model || 'deepseek-v4.1-flash';
  const temperature = options.temperature !== undefined ? options.temperature : 0.1;
  const timeoutMs = options.timeoutMs || 60000;
  const maxAttempts = options.maxAttempts || 3;
  const sleep = options.sleep || defaultSleep;

  if (!apiKey) {
    throw new Error('NORMAHUB_API_KEY is required for analysis.');
  }

  let systemPrompt = SYSTEM_PROMPT;
  if (options.customRules && options.customRules.length > 0) {
    systemPrompt += `\n\nCUSTOM REPOSITORY GUIDELINES CONFIGURED BY TEAM:\n` +
      options.customRules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  }
  if (options.language === 'ru') {
    systemPrompt += `\n\nLANGUAGE REQUIREMENT:\nProvide the "summary", "title", "description", and "positives" strictly in professional Russian.`;
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Perform a code review on the following Pull Request diff:\n\n\`\`\`diff\n${diff}\n\`\`\``,
      },
    ],
    temperature,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryDelayMs = null;
    try {
      const response = await fetch(NORMAHUB_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });

      if (!response.ok) {
        const errBody = await response.text();
        const err = httpError(response.status, errBody);
        // Authentication/validation failures are not transient.
        if (response.status === 401 || response.status === 403) {
          err.message = `${err.message}. Check the normahub_api_key input.`;
          throw err;
        }
        if (response.status !== 429 && response.status !== 408 && response.status < 500) {
          throw err;
        }
        retryDelayMs = retryAfterMs(response.headers?.get?.('retry-after') ?? null);
        lastError = err;
      } else {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('NormaHub API returned empty message content.');
        }
        return extractJsonFromResponse(content);
      }
    } catch (err) {
      // A 4xx client error is final: rethrow instead of retrying.
      if (err?.status && err.status !== 429 && err.status !== 408 && err.status < 500) {
        throw err;
      }
      lastError = err;
    }

    if (attempt < maxAttempts) {
      const delay = retryDelayMs !== null ? Math.min(retryDelayMs, 30000) : 1000 * attempt;
      await sleep(delay);
    }
  }

  throw lastError;
}
