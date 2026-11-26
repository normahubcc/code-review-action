import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonFromResponse, filterByMinSeverity, analyzeDiff } from '../src/analyzer.js';

const originalFetch = globalThis.fetch;

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(calls.length, options);
  };
  return calls;
}

test('extractJsonFromResponse extracts valid JSON inside markdown block', () => {
  const modelText = `Here is my review:
\`\`\`json
{
  "summary": "Fixes race condition in checkout.",
  "risk_level": "HIGH",
  "findings": [
    {
      "file": "src/checkout.ts",
      "line": 15,
      "severity": "CRITICAL",
      "title": "Missing transaction lock",
      "description": "Double spend possible without lock.",
      "suggestion": "await lock.acquire();"
    }
  ],
  "positives": ["Good test coverage added."]
}
\`\`\`
Hope this helps!`;

  const parsed = extractJsonFromResponse(modelText);
  assert.equal(parsed.summary, 'Fixes race condition in checkout.');
  assert.equal(parsed.risk_level, 'HIGH');
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].severity, 'CRITICAL');
  assert.equal(parsed.positives.length, 1);
});

test('extractJsonFromResponse falls back cleanly on non-JSON text', () => {
  const rawText = 'I found a bug in line 42 of index.js: unhandled null pointer.';
  const parsed = extractJsonFromResponse(rawText);
  assert.equal(parsed.risk_level, 'MEDIUM');
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].description, rawText);
});

test('extractJsonFromResponse normalizes lowercase severity and string line numbers', () => {
  const modelText = `\`\`\`json
{"summary":"SQLi found.","risk_level":"high","findings":[{"file":"src/auth.js","line":"42","severity":"critical","title":"SQL Injection","description":"Concatenated query."},{"file":"src/x.js","line":"","severity":"nit","title":"Style","description":"nit"}]}
\`\`\``;

  const parsed = extractJsonFromResponse(modelText);
  assert.equal(parsed.risk_level, 'HIGH');
  assert.equal(parsed.findings[0].severity, 'CRITICAL');
  assert.equal(parsed.findings[0].line, 42);
  assert.equal(parsed.findings[1].severity, 'SUGGESTION');
  assert.equal(parsed.findings[1].line, null);
});

test('extractJsonFromResponse prefers the JSON fence even when another fence comes first', () => {
  const modelText = `Here is a snippet from the diff:
\`\`\`js
const a = 1;
\`\`\`
And the report:
\`\`\`json
{"summary":"Found SQL injection.","risk_level":"HIGH","findings":[]}
\`\`\``;

  const parsed = extractJsonFromResponse(modelText);
  assert.equal(parsed.summary, 'Found SQL injection.');
  assert.equal(parsed.risk_level, 'HIGH');
});

test('filterByMinSeverity drops findings below the configured threshold', () => {
  const findings = [
    { file: 'a', line: null, severity: 'CRITICAL' },
    { file: 'b', line: null, severity: 'WARNING' },
    { file: 'c', line: null, severity: 'SUGGESTION' },
  ];
  assert.equal(filterByMinSeverity(findings, 'WARNING').length, 2);
  assert.equal(filterByMinSeverity(findings, 'CRITICAL').length, 1);
  assert.equal(filterByMinSeverity(findings, 'SUGGESTION').length, 3);
});

test('analyzeDiff does not retry authentication/validation errors', async () => {
  const calls = mockFetch(() => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    text: async () => '{"error":"invalid api key"}',
  }));
  const sleeps = [];

  try {
    await assert.rejects(
      analyzeDiff('diff', { apiKey: 'bad', sleep: async (ms) => sleeps.push(ms) }),
      /normahub_api_key/
    );
    assert.equal(calls.length, 1, 'a 401 must be reported immediately, not retried');
    assert.equal(sleeps.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('analyzeDiff does not retry 400 responses', async () => {
  const calls = mockFetch(() => ({
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: async () => '{"error":"bad model"}',
  }));

  try {
    await assert.rejects(analyzeDiff('diff', { apiKey: 'k', sleep: async () => {} }), /HTTP 400/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('analyzeDiff honours Retry-After on 429 and retries', async () => {
  const calls = mockFetch((attempt) => {
    if (attempt === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '2' : null) },
        text: async () => 'rate limited',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: '```json\n{"summary":"ok","risk_level":"LOW","findings":[]}\n```' } }],
      }),
    };
  });
  const sleeps = [];

  try {
    const analysis = await analyzeDiff('diff', { apiKey: 'k', sleep: async (ms) => sleeps.push(ms) });
    assert.equal(analysis.summary, 'ok');
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('analyzeDiff sends a request timeout signal', async () => {
  const calls = mockFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: '{"summary":"ok","risk_level":"LOW","findings":[]}' } }],
    }),
  }));

  try {
    await analyzeDiff('diff', { apiKey: 'k', timeoutMs: 1500 });
    assert.ok(calls[0].options.signal, 'fetch must receive an AbortSignal so a hung request cannot block the job');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
