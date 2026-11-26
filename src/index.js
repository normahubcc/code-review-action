#!/usr/bin/env node

/**
 * NormaHub AI Code Review Action - Main Entrypoint
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { analyzeDiff, filterByMinSeverity } from './analyzer.js';
import { buildLineIndex, parseAndFilterDiff } from './diff.js';
import { BOT_SIGNATURE, formatReviewComment } from './formatter.js';
import {
  createPullRequestReview,
  fetchPullRequestDiff,
  findExistingBotReview,
  postOrUpdateComment,
} from './github.js';
import { isUnresolvedExpression, loadReviewConfig, readInputs } from './config.js';

const DEFAULT_GITHUB = {
  fetchPullRequestDiff,
  postOrUpdateComment,
  createPullRequestReview,
  findExistingBotReview,
};

/**
 * Formats a GitHub Actions workflow command with the required escaping,
 * so multi-line API errors do not break the annotation.
 * @param {'error'|'warning'|'notice'} level
 * @param {string} message
 * @returns {string}
 */
export function annotation(level, message) {
  const escaped = String(message ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  return `::${level}::${escaped}`;
}

/**
 * Runs the review. Returns the process exit code instead of exiting, which
 * keeps the flow testable.
 * @param {object} [params]
 * @param {Record<string,string|undefined>} [params.env=process.env]
 * @param {object} [params.deps] Injectable collaborators for tests
 * @returns {Promise<number>} exit code
 */
export async function run({ env = process.env, deps = {} } = {}) {
  const log = deps.log || console;
  const github = { ...DEFAULT_GITHUB, ...(deps.github || {}) };
  const analyze = deps.analyze || analyzeDiff;
  const loadConfig = deps.loadConfig || loadReviewConfig;
  const workspaceDir = deps.workspaceDir || process.cwd();

  const inputs = readInputs(env);
  const startTime = Date.now();

  if (!inputs.apiKey) {
    log.error(annotation('error', 'NORMAHUB_API_KEY is missing. Please provide it in secrets.'));
    return 1;
  }

  if (!inputs.githubToken) {
    log.error(
      annotation(
        'error',
        'GITHUB_TOKEN is missing. Pass github_token: ${{ secrets.GITHUB_TOKEN }} or grant the job permissions: pull-requests: write.'
      )
    );
    return 1;
  }

  if (isUnresolvedExpression(inputs.githubToken)) {
    log.error(
      annotation(
        'error',
        `GITHUB_TOKEN was not resolved (received "${inputs.githubToken}"). Pass github_token: \${{ secrets.GITHUB_TOKEN }} explicitly.`
      )
    );
    return 1;
  }

  if (!inputs.prNumber || !inputs.repo) {
    log.log('No pull request detected in context. Skipping code review.');
    return 0;
  }

  log.log('🚀 Starting NormaHub Code Review');
  const repoConfig = loadConfig(workspaceDir);
  const effectiveModel = repoConfig.model || inputs.model;
  const effectiveIgnorePatterns = [...inputs.ignorePatterns, ...(repoConfig.ignore_patterns || [])];

  log.log(`Repository: ${inputs.repo}#${inputs.prNumber}`);
  log.log(`Model: ${effectiveModel}`);
  log.log(`Language: ${repoConfig.language}`);
  log.log(`Minimum severity: ${repoConfig.min_severity || 'SUGGESTION'}`);
  if (repoConfig.custom_rules?.length) {
    log.log(`Custom Rules Active: ${repoConfig.custom_rules.length} rule(s)`);
  }

  // 1. Fetch raw diff
  log.log('📥 Fetching pull request diff from GitHub...');
  let rawDiff;
  try {
    rawDiff = await github.fetchPullRequestDiff(inputs.apiUrl, inputs.repo, inputs.prNumber, inputs.githubToken);
  } catch (err) {
    if (err?.code === 'DIFF_TOO_LARGE') {
      log.warn(annotation('warning', err.message));
      const skippedBody = [
        BOT_SIGNATURE,
        '### 🤖 NormaHub AI Code Review',
        '',
        '⚠️ **Review skipped:** GitHub refused to produce this diff (HTTP 406).',
        'The Pull Request exceeds the GitHub API diff limits (**300 changed files** or **20,000 lines**).',
        'Split the PR into smaller ones (or push fewer files at once) and the review will run on the next push.',
      ].join('\n');
      await github.postOrUpdateComment(inputs.apiUrl, inputs.repo, inputs.prNumber, skippedBody, inputs.githubToken);
      return 0;
    }
    throw err;
  }

  // 2. Filter noise
  const parsed = parseAndFilterDiff(rawDiff, {
    maxDiffLength: inputs.maxDiffLength,
    extraIgnorePatterns: effectiveIgnorePatterns,
  });

  for (const pattern of parsed.invalidPatterns) {
    log.warn(annotation('warning', `Ignoring invalid ignore pattern (not a valid regex): ${pattern}`));
  }

  log.log('📊 Diff Statistics:');
  log.log(`- Reviewed files: ${parsed.reviewedFiles.length}`);
  log.log(`- Filtered files: ${parsed.ignoredFiles.length}`);
  log.log(`- Total diff size: ${parsed.includedDiff.length} characters`);

  if (!parsed.includedDiff.trim()) {
    log.log('✨ All files in this PR were filtered out (assets, lockfiles, or vendor files). Skipping AI analysis.');
    return 0;
  }

  // 3. Analyze diff via NormaHub API
  log.log(`🧠 Invoking NormaHub API with model ${effectiveModel}...`);
  const analysis = await analyze(parsed.includedDiff, {
    apiKey: inputs.apiKey,
    model: effectiveModel,
    customRules: repoConfig.custom_rules,
    language: repoConfig.language,
  });

  const findings = filterByMinSeverity(analysis.findings, repoConfig.min_severity);
  const skippedFindings = (analysis.findings || []).length - findings.length;
  log.log(`🔍 Analysis finished. Risk Level: ${analysis.risk_level}, Findings: ${findings.length}`);
  if (skippedFindings > 0) {
    log.log(`- ${skippedFindings} finding(s) below min_severity=${repoConfig.min_severity} were omitted.`);
  }

  // 4. Format comment markdown
  const commentMarkdown = formatReviewComment(
    { ...analysis, findings },
    {
      model: effectiveModel,
      commitSha: inputs.commitSha,
      reviewedFiles: parsed.reviewedFiles,
      ignoredFiles: parsed.ignoredFiles,
      isTruncated: parsed.isTruncated,
    }
  );

  // 5. Post review to GitHub
  log.log('💬 Publishing review to PR...');
  const lineIndex = buildLineIndex(parsed.includedDiff);
  const inlineCandidates = findings.filter(
    (finding) => finding.line && lineIndex.get(finding.file)?.has(finding.line)
  );
  let reviewPublished = false;

  if (inputs.inlineComments && inputs.commitSha && inlineCandidates.length > 0) {
    let existingReviewId = null;
    try {
      existingReviewId = await github.findExistingBotReview(
        inputs.apiUrl,
        inputs.repo,
        inputs.prNumber,
        inputs.githubToken
      );
    } catch (lookupErr) {
      log.warn(annotation('warning', `Could not check existing reviews: ${lookupErr.message}`));
    }

    if (existingReviewId) {
      // A review cannot be edited in place; publishing another one would duplicate
      // every inline comment on each push.
      log.log(
        `ℹ️ Inline suggestions already published for this PR (review #${existingReviewId}); updating the summary comment instead.`
      );
    } else {
      try {
        log.log(`💡 Creating Pull Request Review with ${inlineCandidates.length} inline suggestion(s)...`);
        const rev = await github.createPullRequestReview(
          inputs.apiUrl,
          inputs.repo,
          inputs.prNumber,
          inputs.commitSha,
          commentMarkdown,
          inlineCandidates,
          inputs.githubToken,
          { lineIndex }
        );
        log.log(`✅ GitHub PR Review created (Review ID: ${rev.id}) with ${rev.inlineCount} inline comment(s)!`);
        reviewPublished = true;
      } catch (inlineErr) {
        log.warn(annotation('warning', `Inline review failed (${inlineErr.message}). Falling back to PR summary comment.`));
      }
    }
  }

  if (!reviewPublished) {
    const result = await github.postOrUpdateComment(
      inputs.apiUrl,
      inputs.repo,
      inputs.prNumber,
      commentMarkdown,
      inputs.githubToken
    );
    log.log(`✅ Review comment successfully ${result.action} (comment ID: ${result.id})`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  log.log(`⏱️ Completed in ${duration}s!`);

  const hasCriticals = (analysis.findings || []).some((finding) => finding.severity === 'CRITICAL');
  if (inputs.failOnCritical && hasCriticals) {
    log.error(
      annotation(
        'error',
        'NormaHub Code Review detected critical security/logic vulnerabilities in PR. Failing CI check as requested.'
      )
    );
    return 1;
  }

  return 0;
}

/**
 * True when this file is executed as a script (composite action) rather than imported by tests.
 * @returns {boolean}
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return self === entry;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (isMainModule()) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(annotation('error', `Code review failed: ${err.message}`));
      process.exitCode = 1;
    });
}
