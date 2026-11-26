import test from 'node:test';
import assert from 'node:assert/strict';
import { run, annotation } from '../src/index.js';
import { buildLineIndex } from '../src/diff.js';

const DIFF = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -40,4 +40,5 @@
+const x = 1;
`;

const CRITICAL_FINDING = {
  file: 'src/a.js',
  line: 42,
  severity: 'CRITICAL',
  title: 'SQL Injection',
  description: 'Raw concatenation.',
  suggestion: 'db.prepare(...)',
};

function baseEnv(overrides = {}) {
  return {
    NORMAHUB_API_KEY: 'api-key',
    GITHUB_TOKEN: 'gh-token',
    PR_NUMBER: '5',
    GITHUB_REPOSITORY: 'owner/repo',
    INPUT_COMMIT_SHA: 'abcdef1234567',
    ...overrides,
  };
}

function silentLog() {
  const lines = [];
  const push = (...args) => lines.push(args.join(' '));
  return { log: push, warn: push, error: push, lines };
}

function makeDeps({ analysis, github: githubOverrides, loadConfig, analyze } = {}) {
  const calls = { comments: [], reviews: [], lookups: 0, analyzed: [] };
  const effectiveAnalysis = analysis || {
    summary: 'Summary',
    risk_level: 'HIGH',
    findings: [CRITICAL_FINDING],
    positives: [],
  };
  const log = silentLog();

  const deps = {
    log,
    workspaceDir: '/tmp/normahub-workspace-does-not-exist',
    github: {
      fetchPullRequestDiff: async () => DIFF,
      findExistingBotReview: async () => {
        calls.lookups += 1;
        return null;
      },
      createPullRequestReview: async (apiUrl, repo, prNumber, commitSha, body, findings) => {
        calls.reviews.push({ body, findings });
        return { action: 'review_created', id: 2, inlineCount: findings.length };
      },
      postOrUpdateComment: async (apiUrl, repo, prNumber, body) => {
        calls.comments.push(body);
        return { action: 'created', id: 1 };
      },
      ...(githubOverrides || {}),
    },
    analyze: async (diff, options) => {
      calls.analyzed.push(options);
      return effectiveAnalysis;
    },
    loadConfig:
      loadConfig ||
      (() => ({
        custom_rules: [],
        ignore_patterns: [],
        language: 'en',
        min_severity: 'SUGGESTION',
      })),
    ...(analyze ? { analyze } : {}),
  };

  return { deps, calls };
}

test('annotation escapes newlines so workflow commands stay parseable', () => {
  assert.equal(annotation('error', 'line1\nline2'), '::error::line1%0Aline2');
  assert.equal(annotation('warning', '100%'), '::warning::100%25');
});

test('run fails with a clear message when the API key is missing', async () => {
  const { deps, calls } = makeDeps();
  const code = await run({ env: baseEnv({ NORMAHUB_API_KEY: '' }), deps });

  assert.equal(code, 1);
  assert.ok(deps.log.lines.some((line) => line.includes('NORMAHUB_API_KEY')));
  assert.equal(calls.comments.length, 0);
});

test('run fails when the github token is missing or unresolved', async () => {
  const missing = makeDeps();
  assert.equal(await run({ env: baseEnv({ GITHUB_TOKEN: '' }), deps: missing.deps }), 1);
  assert.ok(missing.deps.log.lines.some((line) => line.includes('GITHUB_TOKEN')));

  const unresolved = makeDeps();
  const code = await run({
    env: baseEnv({ GITHUB_TOKEN: '${{ github.token }}' }),
    deps: unresolved.deps,
  });
  assert.equal(code, 1);
  assert.ok(unresolved.deps.log.lines.some((line) => line.includes('not resolved')));
  assert.equal(unresolved.calls.comments.length, 0);
});

test('run skips without a pull request context', async () => {
  const { deps, calls } = makeDeps();
  const code = await run({ env: baseEnv({ PR_NUMBER: '', GITHUB_REPOSITORY: '' }), deps });

  assert.equal(code, 0);
  assert.equal(calls.analyzed.length, 0);
  assert.equal(calls.comments.length, 0);
});

test('run honours fail_on_critical regardless of boolean casing', async () => {
  for (const value of ['true', 'True', 'TRUE', '1']) {
    const { deps, calls } = makeDeps();
    const code = await run({ env: baseEnv({ INPUT_FAIL_ON_CRITICAL: value }), deps });

    assert.equal(code, 1, `fail_on_critical=${value} must fail the step`);
    assert.equal(calls.reviews.length + calls.comments.length, 1, 'the review is still published before failing');
  }

  const { deps, calls } = makeDeps();
  assert.equal(await run({ env: baseEnv({ INPUT_FAIL_ON_CRITICAL: 'false' }), deps }), 0);
  assert.equal(calls.reviews.length + calls.comments.length, 1);
});

test('run reports the model that was actually used in the footer', async () => {
  const { deps, calls } = makeDeps({
    analysis: { summary: 's', risk_level: 'LOW', findings: [], positives: [] },
    loadConfig: () => ({
      custom_rules: [],
      ignore_patterns: [],
      language: 'en',
      min_severity: 'SUGGESTION',
      model: 'claude-sonnet-5-5',
    }),
  });

  const code = await run({ env: baseEnv({ INPUT_MODEL: 'deepseek-v4.1-flash' }), deps });

  assert.equal(code, 0);
  assert.equal(calls.comments.length, 1);
  assert.ok(calls.comments[0].includes('claude-sonnet-5-5'));
  assert.ok(!calls.comments[0].includes('`deepseek-v4.1-flash`'));
  assert.equal(calls.analyzed[0].model, 'claude-sonnet-5-5');
});

test('run does not publish a second review on a PR that already has one', async () => {
  const { deps, calls } = makeDeps({
    github: { findExistingBotReview: async () => 4242 },
  });

  const code = await run({ env: baseEnv(), deps });

  assert.equal(code, 0);
  assert.equal(calls.reviews.length, 0, 'a new review would duplicate every inline comment');
  assert.equal(calls.comments.length, 1, 'the summary comment is updated instead');
  assert.ok(deps.log.lines.some((line) => line.includes('4242')));
});

test('run applies min_severity from the repository config', async () => {
  const { deps, calls } = makeDeps({
    analysis: {
      summary: 's',
      risk_level: 'MEDIUM',
      findings: [
        { ...CRITICAL_FINDING, severity: 'WARNING', title: 'Keep this warning' },
        { ...CRITICAL_FINDING, severity: 'SUGGESTION', title: 'Drop this suggestion' },
      ],
      positives: [],
    },
    loadConfig: () => ({
      custom_rules: [],
      ignore_patterns: [],
      language: 'en',
      min_severity: 'WARNING',
    }),
  });

  const code = await run({ env: baseEnv(), deps });

  assert.equal(code, 0);
  const body = calls.reviews[0]?.body || calls.comments[0];
  assert.ok(body.includes('Keep this warning'));
  assert.ok(!body.includes('Drop this suggestion'));
});

test('run skips review gracefully when GitHub refuses the diff (too large)', async () => {
  const tooLarge = new Error('GitHub API refused to generate the diff (HTTP 406). ');
  tooLarge.code = 'DIFF_TOO_LARGE';
  const { deps, calls } = makeDeps({
    github: {
      fetchPullRequestDiff: async () => {
        throw tooLarge;
      },
    },
  });

  const code = await run({ env: baseEnv(), deps });

  assert.equal(code, 0, 'an oversized PR must not fail the workflow');
  assert.equal(calls.analyzed.length, 0);
  assert.equal(calls.comments.length, 1);
  assert.ok(calls.comments[0].includes('300'));
});

test('run publishes inline comments only for lines present in the diff', async () => {
  const { deps, calls } = makeDeps({
    analysis: {
      summary: 's',
      risk_level: 'HIGH',
      // Line 900 is not part of the fetched hunk; GitHub would reject the whole review.
      findings: [{ ...CRITICAL_FINDING, line: 900 }],
      positives: [],
    },
  });

  const code = await run({ env: baseEnv(), deps });

  assert.equal(code, 0);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.comments.length, 1);
  assert.ok(calls.comments[0].includes('SQL Injection'));
});

test('run ignores invalid ignore patterns with a warning instead of crashing', async () => {
  const { deps, calls } = makeDeps({
    analysis: { summary: 's', risk_level: 'LOW', findings: [], positives: [] },
  });

  const code = await run({ env: baseEnv({ INPUT_IGNORE_PATTERNS: 'dist/**,^generated/' }), deps });

  assert.equal(code, 0);
  assert.ok(deps.log.lines.some((line) => line.includes('::warning::') && line.includes('dist/**')));
  assert.equal(calls.comments.length, 1);
});
test('buildLineIndex maps the new-file line numbers that inline comments may target', () => {
  const diff = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,5 @@
 context
+added
--- removed
+added2
diff --git a/src/b.js b/src/b.js
--- a/src/b.js
+++ b/src/b.js
@@ -10,2 +12 @@
-old
+new
`;

  const index = buildLineIndex(diff);
  assert.deepEqual([...index.get('src/a.js')].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.deepEqual([...index.get('src/b.js')], [12]);
  assert.equal(index.get('src/a.js').has(6), false);
  assert.equal(index.has('src/missing.js'), false);
});
