import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPullRequestReview,
  fetchPullRequestDiff,
  findExistingBotComment,
  findExistingBotReview,
  postOrUpdateComment,
} from '../src/github.js';

const BOT_BODY = '<!-- normahub-code-review-bot -->\nreport';

test('createPullRequestReview formats inline comments and suggestions correctly', async () => {
  let interceptedUrl = '';
  let interceptedPayload = null;

  // Mock fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    interceptedUrl = url;
    interceptedPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 998877 }),
    };
  };

  try {
    const findings = [
      {
        file: 'src/auth.ts',
        line: 42,
        severity: 'CRITICAL',
        title: 'SQL Injection Vulnerability',
        description: 'Raw string concatenation in SQL query.',
        suggestion: 'const q = db.prepare("SELECT * FROM users WHERE id = ?").bind(userId);',
      },
      {
        file: 'src/utils.ts',
        line: 15,
        severity: 'WARNING',
        title: 'Missing null check',
        description: 'Object may be undefined.',
        suggestion: '```suggestion\nif (!obj) return null;\n```',
      },
      {
        // Ignored: missing line
        file: 'README.md',
        title: 'Typo',
        description: 'Spelling error',
      },
    ];

    const result = await createPullRequestReview(
      'https://api.github.com',
      'normahubcc/test-repo',
      123,
      'commit123sha',
      'Overall Summary Body',
      findings,
      'fake-token'
    );

    assert.equal(result.action, 'review_created');
    assert.equal(result.id, 998877);
    assert.equal(result.inlineCount, 2);

    assert.equal(interceptedUrl, 'https://api.github.com/repos/normahubcc/test-repo/pulls/123/reviews');
    assert.equal(interceptedPayload.commit_id, 'commit123sha');
    assert.equal(interceptedPayload.event, 'COMMENT');
    assert.equal(interceptedPayload.body, 'Overall Summary Body');
    assert.equal(interceptedPayload.comments.length, 2);

    // Check first inline comment
    const c1 = interceptedPayload.comments[0];
    assert.equal(c1.path, 'src/auth.ts');
    assert.equal(c1.line, 42);
    assert.equal(c1.side, 'RIGHT');
    assert.ok(c1.body.includes('🔴 SQL Injection Vulnerability'));
    assert.ok(c1.body.includes('```suggestion\nconst q = db.prepare'));

    // Check second inline comment strips redundant outer ```suggestion fence
    const c2 = interceptedPayload.comments[1];
    assert.equal(c2.path, 'src/utils.ts');
    assert.equal(c2.line, 15);
    assert.ok(c2.body.includes('🟡 Missing null check'));
    assert.ok(c2.body.includes('```suggestion\nif (!obj) return null;\n```'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createPullRequestReview only comments on lines present in the diff', async () => {
  const originalFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ id: 1 }) };
  };

  try {
    const lineIndex = new Map([
      ['src/auth.ts', new Set([40, 41, 42, 43])],
    ]);
    const findings = [
      { file: 'src/auth.ts', line: 42, severity: 'CRITICAL', title: 'in diff', description: 'd' },
      { file: 'src/auth.ts', line: 999, severity: 'CRITICAL', title: 'outside hunk', description: 'd' },
      { file: 'src/not-in-diff.ts', line: 1, severity: 'WARNING', title: 'hallucinated file', description: 'd' },
      { file: 'src/auth.ts', line: 0, severity: 'WARNING', title: 'line zero', description: 'd' },
    ];

    const result = await createPullRequestReview(
      'https://api.github.com',
      'owner/repo',
      1,
      'sha',
      'body',
      findings,
      'token',
      { lineIndex }
    );

    assert.equal(result.inlineCount, 1);
    assert.equal(payload.comments.length, 1);
    assert.equal(payload.comments[0].line, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findExistingBotComment identifies bot comment by signature', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { id: 1, body: 'Just a normal developer comment' },
      { id: 2, body: 'Review from user <!-- normahub-code-review-bot -->\nDetailed report' },
    ],
  });

  try {
    const id = await findExistingBotComment('https://api.github.com', 'owner/repo', 1, 'token');
    assert.equal(id, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findExistingBotComment paginates and prefers bot-authored comments', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (urls.length === 1) {
      return {
        ok: true,
        json: async () => Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}`, user: { type: 'User' } })),
        headers: {
          get: (name) => (String(name).toLowerCase() === 'link'
            ? '<https://api.github.com/repos/owner/repo/issues/1/comments?per_page=100&page=2>; rel="next"'
            : null),
        },
      };
    }
    return {
      ok: true,
      json: async () => [
        { id: 999, body: BOT_BODY, user: { type: 'Bot' } },
        { id: 1000, body: BOT_BODY, user: { type: 'User' } },
      ],
      headers: { get: () => null },
    };
  };

  try {
    const id = await findExistingBotComment('https://api.github.com', 'owner/repo', 1, 'token');
    assert.equal(urls.length, 2, 'a PR with >100 comments must be paginated');
    assert.equal(id, 999);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findExistingBotReview detects a review previously published by the action', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => [
        { id: 10, body: 'human review' },
        { id: 11, body: BOT_BODY, user: { type: 'Bot' } },
      ],
      headers: { get: () => null },
    };
  };

  try {
    const id = await findExistingBotReview('https://api.github.com', 'owner/repo', 5, 'token');
    assert.equal(id, 11);
    assert.equal(requestedUrl, 'https://api.github.com/repos/owner/repo/pulls/5/reviews?per_page=100');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postOrUpdateComment falls back to a new comment when editing is forbidden', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    if ((options.method || 'GET') === 'GET') {
      return {
        ok: true,
        json: async () => [{ id: 77, body: BOT_BODY, user: { type: 'User' } }],
      };
    }
    if (options.method === 'PATCH') {
      return { ok: false, status: 403, text: async () => 'Resource not accessible by integration' };
    }
    return { ok: true, status: 201, json: async () => ({ id: 88 }) };
  };

  try {
    const result = await postOrUpdateComment('https://api.github.com', 'owner/repo', 3, 'body', 'token');
    assert.deepEqual(result, { action: 'created', id: 88 });
    assert.deepEqual(requests.map((r) => r.method), ['GET', 'PATCH', 'POST']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPullRequestDiff reports oversized PR diffs with a typed error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 406,
    text: async () => 'Sorry, the diff exceeded the maximum number of files (300).',
  });

  try {
    await assert.rejects(
      fetchPullRequestDiff('https://api.github.com', 'owner/repo', 1, 'token'),
      (err) => err.code === 'DIFF_TOO_LARGE' && /300/.test(err.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
