import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isUnresolvedExpression,
  loadReviewConfig,
  parseBoolean,
  parsePositiveInt,
  parseSimpleYaml,
  readInputs,
  splitIgnorePatterns,
} from '../src/config.js';
import { compileIgnorePatterns } from '../src/diff.js';
import { formatReviewComment } from '../src/formatter.js';

test('parseSimpleYaml extracts custom rules, language, and ignore patterns', () => {
  const yamlContent = `
# NormaHub Review Configuration
language: ru
model: claude-sonnet-5-5
min_severity: WARNING

custom_rules:
  - "Verify all database queries use parameterized placeholders"
  - 'Ensure zero unhandled Promise rejections'

ignore_patterns:
  - "dist/**"
  - "*.generated.ts"
`;

  const parsed = parseSimpleYaml(yamlContent);
  assert.equal(parsed.language, 'ru');
  assert.equal(parsed.model, 'claude-sonnet-5-5');
  assert.equal(parsed.min_severity, 'WARNING');
  assert.equal(parsed.custom_rules.length, 2);
  assert.equal(parsed.custom_rules[0], 'Verify all database queries use parameterized placeholders');
  assert.equal(parsed.custom_rules[1], 'Ensure zero unhandled Promise rejections');
  assert.equal(parsed.ignore_patterns.length, 2);
  assert.equal(parsed.ignore_patterns[0], 'dist/**');
});

test('parseSimpleYaml strips inline comments from scalars but keeps quoted hashes', () => {
  const parsed = parseSimpleYaml(`
language: ru # 'ru' for Russian or 'en' for English
model: deepseek-v4.1-flash # Model to run review
min_severity: WARNING # CRITICAL, WARNING, SUGGESTION
custom_rules:
  - "Do not log secrets # even when debugging"
ignore_patterns:
  - "^dist/" # generated bundles
`);

  assert.equal(parsed.language, 'ru');
  assert.equal(parsed.model, 'deepseek-v4.1-flash');
  assert.equal(parsed.min_severity, 'WARNING');
  assert.equal(parsed.custom_rules[0], 'Do not log secrets # even when debugging');
  assert.deepEqual(parsed.ignore_patterns, ['^dist/']);
});

test('shipped example configuration is valid (model parsed, patterns compile)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'normahub-config-'));
  fs.copyFileSync(
    path.resolve('.normahub-review.example.yml'),
    path.join(dir, '.normahub-review.yml')
  );

  const config = loadReviewConfig(dir);
  assert.equal(config.model, 'deepseek-v4.1-flash');
  assert.equal(config.language, 'ru');
  assert.equal(config.min_severity, 'WARNING');
  assert.deepEqual(compileIgnorePatterns(config.ignore_patterns).invalid, []);
});

test('invalid min_severity and language values fall back to safe defaults', () => {
  const parsed = parseSimpleYaml('language: de\nmin_severity: BLOCKER_EVERYTHING');
  assert.equal(parsed.language, 'en');
  assert.equal(parsed.min_severity, 'SUGGESTION');
});

test('parseBoolean accepts the Actions spellings case-insensitively', () => {
  assert.equal(parseBoolean('true'), true);
  assert.equal(parseBoolean('True'), true);
  assert.equal(parseBoolean('TRUE'), true);
  assert.equal(parseBoolean('1'), true);
  assert.equal(parseBoolean('yes'), true);
  assert.equal(parseBoolean('False'), false);
  assert.equal(parseBoolean('0'), false);
  assert.equal(parseBoolean('', true), true);
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean('garbage', false), false);
});

test('parsePositiveInt rejects junk, zero and negative values', () => {
  assert.equal(parsePositiveInt('1234', 50000), 1234);
  assert.equal(parsePositiveInt('abc', 50000), 50000);
  assert.equal(parsePositiveInt('0', 50000), 50000);
  assert.equal(parsePositiveInt('-5', 50000), 50000);
  assert.equal(parsePositiveInt('', 50000), 50000);
});

test('readInputs normalizes booleans, diff budget and ignore patterns', () => {
  const inputs = readInputs({
    NORMAHUB_API_KEY: 'key',
    GITHUB_TOKEN: 'token',
    INPUT_FAIL_ON_CRITICAL: 'TRUE',
    INPUT_INLINE_COMMENTS: 'False',
    INPUT_MAX_DIFF_LENGTH: 'not-a-number',
    INPUT_IGNORE_PATTERNS: '^dist/,\n\\.gen\\.ts$',
    PR_NUMBER: '7',
    GITHUB_REPOSITORY: 'owner/repo',
  });

  assert.equal(inputs.failOnCritical, true);
  assert.equal(inputs.inlineComments, false);
  assert.equal(inputs.maxDiffLength, 50000);
  assert.deepEqual(inputs.ignorePatterns, ['^dist/', '\\.gen\\.ts$']);
  assert.equal(inputs.apiUrl, 'https://api.github.com');
  assert.deepEqual(splitIgnorePatterns(undefined), []);
});

test('isUnresolvedExpression detects a literal ${{ }} passed as a token', () => {
  assert.equal(isUnresolvedExpression('${{ github.token }}'), true);
  assert.equal(isUnresolvedExpression('ghs_real_token'), false);
  assert.equal(isUnresolvedExpression(undefined), false);
});

test('formatReviewComment outputs Summary Scorecard table', () => {
  const mockAnalysis = {
    summary: 'Refactored auth token refresh loop.',
    risk_level: 'HIGH',
    findings: [
      {
        file: 'src/auth.js',
        line: 45,
        severity: 'CRITICAL',
        title: 'Token race condition',
        description: 'Multiple requests trigger concurrent refresh.',
        suggestion: 'await mutex.lock();',
      },
      {
        file: 'src/api.js',
        line: 12,
        severity: 'WARNING',
        title: 'Missing timeout',
        description: 'Fetch call has no signal timeout.',
        suggestion: 'AbortSignal.timeout(5000)',
      },
    ],
    positives: ['Clean promise error handling'],
  };

  const md = formatReviewComment(mockAnalysis, { commitSha: 'abcdef123456' });

  assert.ok(md.includes('### 🤖 NormaHub AI Code Review'));
  assert.ok(md.includes('| Category | Findings | Status |'));
  assert.ok(md.includes('| 🛡️ Security & Critical | 1 | 🔴 Action Required |'));
  assert.ok(md.includes('| ⚠️ Warnings & Reliability | 1 | 🟡 Review Advised |'));
  assert.ok(md.includes('| 💡 Optimization & Suggestions | 0 | ℹ️ 0 Notes |'));
});
