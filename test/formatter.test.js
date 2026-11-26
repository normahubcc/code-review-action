import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReviewComment,
  BOT_SIGNATURE,
  sanitizeText,
  fencedCode,
  codeSpan,
} from '../src/formatter.js';

test('formatReviewComment produces valid markdown with signature', () => {
  const analysis = {
    summary: 'Refactored user authentication service.',
    risk_level: 'LOW',
    findings: [],
    positives: ['Clean architecture', 'Added unit tests'],
  };

  const md = formatReviewComment(analysis, {
    model: 'deepseek-v4.1-flash',
    commitSha: 'a1b2c3d4e5',
    reviewedFiles: ['src/auth.ts', 'src/user.ts'],
    ignoredFiles: ['pnpm-lock.yaml'],
  });

  assert.ok(md.includes(BOT_SIGNATURE));
  assert.ok(md.includes('🟢 **Risk Level: LOW**'));
  assert.ok(md.includes('No critical bugs or security vulnerabilities found'));
  assert.ok(md.includes('Filtered Non-Code Files'));
  assert.ok(md.includes('deepseek-v4.1-flash'));
});

test('formatReviewComment groups critical findings and suggestions', () => {
  const analysis = {
    summary: 'Added payment webhook handler.',
    risk_level: 'HIGH',
    findings: [
      {
        file: 'src/webhook.ts',
        line: 88,
        severity: 'CRITICAL',
        title: 'Unverified Webhook Signature',
        description: 'Requests are processed without verifying cryptographic HMAC.',
        suggestion: 'verifySignature(req.headers["x-signature"]);',
      },
      {
        file: 'src/webhook.ts',
        line: 120,
        severity: 'WARNING',
        title: 'Unhandled error on db failure',
        description: 'Missing catch block around db call.',
        suggestion: 'try { ... } catch (e) { ... }',
      },
    ],
    positives: [],
  };

  const md = formatReviewComment(analysis, {
    model: 'claude-sonnet-5-5',
    commitSha: '1234567890',
    reviewedFiles: ['src/webhook.ts'],
    ignoredFiles: [],
  });

  assert.ok(md.includes('🔴 **Risk Level: HIGH**'));
  assert.ok(md.includes('Critical & Security Issues (1)'));
  assert.ok(md.includes('Warnings & Edge Cases (1)'));
  assert.ok(md.includes('Unverified Webhook Signature'));
  assert.ok(md.includes('Suggested fix'));
  assert.ok(md.includes('claude-sonnet-5-5'));
});

test('formatReviewComment escapes HTML coming from the model', () => {
  const analysis = {
    summary: 'Summary </details> with markup',
    risk_level: 'MEDIUM',
    findings: [
      {
        file: 'src/a.js',
        line: 3,
        severity: 'WARNING',
        title: '<img src=x onerror=alert(1)>',
        description: '</details><script>alert(1)</script>',
        suggestion: 'const safe = 1;',
      },
    ],
    positives: ['<details>injected</details>'],
  };

  const md = formatReviewComment(analysis, { reviewedFiles: ['src/a.js'] });

  assert.ok(!md.includes('<script'), 'raw <script> must never reach the comment');
  assert.ok(!md.includes('<img '), 'raw <img> must never reach the comment');
  assert.ok(!md.includes('</details><script'), 'model text must not close our <details> wrapper');
  assert.ok(md.includes('&lt;script>'));
  assert.ok(md.includes('&lt;/details>'));
  assert.ok(md.includes('&lt;img'));
  // Our own structural markup is still present.
  assert.ok(md.includes('<details><summary>💡 Suggested fix</summary>'));
});

test('formatReviewComment keeps an embedded ``` from breaking the suggestion fence', () => {
  const analysis = {
    summary: 'Review',
    risk_level: 'HIGH',
    findings: [
      {
        file: 'src/a.js',
        line: 1,
        severity: 'CRITICAL',
        title: 'Broken fence',
        description: 'Suggestion contains a triple backtick.',
        suggestion: 'const a = 1;\n```\nmalicious markdown',
      },
    ],
    positives: [],
  };

  const md = formatReviewComment(analysis, { reviewedFiles: ['src/a.js'] });

  assert.ok(md.includes('````suggestion'), 'fence must be longer than any run inside the code');
  assert.ok(md.trimEnd().endsWith('</sub>'));
});

test('formatReviewComment escalates the risk badge when critical findings exist', () => {
  const md = formatReviewComment(
    {
      summary: 'Looks harmless.',
      risk_level: 'LOW',
      findings: [
        { file: 'src/a.js', line: 1, severity: 'CRITICAL', title: 'SQLi', description: 'd', suggestion: '' },
      ],
      positives: [],
    },
    { reviewedFiles: ['src/a.js'] }
  );

  assert.ok(md.includes('🔴 **Risk Level: HIGH**'));
  assert.ok(!md.includes('🟢 **Risk Level: LOW**'));
  assert.ok(md.includes('Verdict: Blocked'));
});

test('formatReviewComment indents multi-line model text inside list items', () => {
  const md = formatReviewComment(
    {
      summary: 'first line\nsecond line',
      risk_level: 'MEDIUM',
      findings: [
        {
          file: 'src/a.js',
          line: 1,
          severity: 'WARNING',
          title: 'T',
          description: 'line one\nline two',
          suggestion: '',
        },
      ],
      positives: [],
    },
    { reviewedFiles: ['src/a.js'] }
  );

  assert.ok(md.includes('first line\n  second line'));
  assert.ok(md.includes('line one\n  line two'));
});

test('codeSpan survives backticks in file paths', () => {
  const md = formatReviewComment(
    {
      summary: 's',
      risk_level: 'HIGH',
      findings: [
        { file: 'src/we`ird.js', line: 2, severity: 'CRITICAL', title: 't', description: 'd', suggestion: '' },
      ],
      positives: [],
    },
    { reviewedFiles: ['src/we`ird.js'] }
  );

  assert.ok(md.includes('``src/we`ird.js``'));
});

test('sanitizeText and fencedCode are exported helpers with stable behaviour', () => {
  assert.equal(sanitizeText('<script>x</script>'), '&lt;script>x&lt;/script>');
  assert.equal(sanitizeText('Array<T> stays readable'), 'Array<T> stays readable');
  assert.equal(fencedCode('const a = 1;'), '```suggestion\nconst a = 1;\n```');
  assert.equal(codeSpan('src/a.js'), '`src/a.js`');
});
