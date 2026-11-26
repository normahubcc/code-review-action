/**
 * NormaHub AI Code Review Markdown Formatter.
 * Renders structured review findings into a compact, collapsible GitHub PR dashboard.
 */

export const BOT_SIGNATURE = '<!-- normahub-code-review-bot -->';

const RISK_BADGES = {
  HIGH: '🔴 **Risk Level: HIGH**',
  MEDIUM: '🟡 **Risk Level: MEDIUM**',
  LOW: '🟢 **Risk Level: LOW**',
};

// Model output is untrusted input: a stray block-level tag closes our <details>
// sections or fakes structure. Escape only block-level/markup tags so ordinary
// prose such as `Array<T>` keeps rendering inside inline code.
const HTML_TAG_RE =
  /<(\/?)(details|summary|script|style|iframe|object|embed|img|svg|table|thead|tbody|tr|td|th|div|span|p|h[1-6]|br|hr|a|code|pre|blockquote|ul|ol|li|picture|source)\b/gi;

/**
 * Neutralizes HTML that could break the comment layout or inject markup.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeText(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n');
  text = text.replace(/<!--/g, '&lt;!--');
  text = text.replace(HTML_TAG_RE, (match, slash, tag) => `&lt;${slash}${tag}`);
  return text;
}

/**
 * Renders a value as a Markdown code span, picking a fence that survives
 * backticks inside the value (typical for paths such as `a`b.ts`).
 * @param {unknown} value
 * @returns {string}
 */
export function codeSpan(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  const runs = text.match(/`+/g) || [];
  const fenceLength = runs.reduce((max, run) => Math.max(max, run.length), 0) + 1;
  const fence = '`'.repeat(fenceLength);
  const needsPad = fenceLength > 1 && (text.startsWith('`') || text.endsWith('`'));
  const pad = needsPad ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Strips an outer ``` fence (with optional language tag) from model output.
 * @param {string} code
 * @returns {string}
 */
export function stripOuterFence(code) {
  const trimmed = String(code ?? '').replace(/\r\n?/g, '\n').trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*?)\n?```$/);
  return match ? match[1].replace(/\s+$/, '') : trimmed;
}

/**
 * Wraps code in a fence longer than any backtick run inside it, so an embedded
 * ``` cannot terminate the block and inject raw Markdown.
 * @param {string} code
 * @param {string} [lang='suggestion']
 * @returns {string}
 */
export function fencedCode(code, lang = 'suggestion') {
  const body = stripOuterFence(code);
  const runs = body.match(/`{3,}/g) || [];
  const fenceLength = Math.max(3, ...runs.map((run) => run.length + 1));
  const fence = '`'.repeat(fenceLength);
  return `${fence}${lang}\n${body}\n${fence}`;
}

/**
 * Indents continuation lines so multi-line model text stays inside its list item.
 * @param {unknown} value
 * @returns {string}
 */
function indentContinuation(value) {
  return sanitizeText(value).replace(/\n/g, '\n  ');
}

/**
 * Formats review data into production-grade GitHub PR markdown.
 * @param {object} analysis
 * @param {object} metadata
 * @param {string} [metadata.model='deepseek-v4.1-flash']
 * @param {string} [metadata.commitSha='']
 * @param {string[]} [metadata.reviewedFiles=[]]
 * @param {string[]} [metadata.ignoredFiles=[]]
 * @param {boolean} [metadata.isTruncated=false]
 * @returns {string}
 */
export function formatReviewComment(analysis, metadata = {}) {
  const model = metadata.model || 'deepseek-v4.1-flash';
  const commitSha = metadata.commitSha ? metadata.commitSha.substring(0, 7) : 'HEAD';
  const reviewedFiles = metadata.reviewedFiles || [];
  const ignoredFiles = metadata.ignoredFiles || [];
  const isTruncated = metadata.isTruncated || false;

  const findings = Array.isArray(analysis.findings) ? analysis.findings : [];
  const positives = Array.isArray(analysis.positives) ? analysis.positives : [];

  const criticals = findings.filter((f) => f.severity === 'CRITICAL');
  const warnings = findings.filter((f) => f.severity === 'WARNING');
  const suggestions = findings.filter((f) => f.severity === 'SUGGESTION' || !f.severity);

  // The badge must not contradict the verdict: critical findings always mean HIGH,
  // even if the model claims the overall risk is LOW.
  const declaredRisk = String(analysis.risk_level ?? '').toUpperCase();
  let riskLevel = RISK_BADGES[declaredRisk] ? declaredRisk : 'LOW';
  if (criticals.length > 0) {
    riskLevel = 'HIGH';
  } else if (warnings.length > 0 && riskLevel === 'LOW') {
    riskLevel = 'MEDIUM';
  }
  const riskBadge = RISK_BADGES[riskLevel];

  // Clear 1-second executive verdict
  let verdict = '✅ **Verdict: Clean to merge** (no blocking issues)';
  if (criticals.length > 0) {
    verdict = `🚨 **Verdict: Blocked** (${criticals.length} critical issue${criticals.length > 1 ? 's' : ''} require attention)`;
  } else if (warnings.length > 0) {
    verdict = `⚠️ **Verdict: Caution** (${warnings.length} warning${warnings.length > 1 ? 's' : ''} detected)`;
  }

  const scorecardTable = [
    '| Category | Findings | Status |',
    '|:---|:---:|:---:|',
    `| 🛡️ Security & Critical | ${criticals.length} | ${criticals.length === 0 ? '🟢 Pass' : '🔴 Action Required'} |`,
    `| ⚠️ Warnings & Reliability | ${warnings.length} | ${warnings.length === 0 ? '🟢 Pass' : '🟡 Review Advised'} |`,
    `| 💡 Optimization & Suggestions | ${suggestions.length} | ℹ️ ${suggestions.length} Notes |`,
  ].join('\n');

  const parts = [
    BOT_SIGNATURE,
    `### 🤖 NormaHub AI Code Review &nbsp; ${riskBadge}`,
    '',
    `> ${verdict}  `,
    `> **Commit:** ${codeSpan(commitSha)} &nbsp;|&nbsp; **Files:** ${reviewedFiles.length} &nbsp;|&nbsp; **Noise Filtered:** ${ignoredFiles.length}${isTruncated ? ' &nbsp;|&nbsp; ⚠️ *Diff partially truncated*' : ''}`,
    '',
    `**Summary:** ${indentContinuation(analysis.summary)}`,
    '',
    scorecardTable,
    '',
  ];

  if (findings.length === 0) {
    parts.push(
      '---',
      '#### ✅ No critical bugs or security vulnerabilities found',
      'The changes appear safe, logically sound, and ready for review.',
      ''
    );
  } else {
    // 1. Critical issues (Always expanded, prominent)
    if (criticals.length > 0) {
      parts.push(`---`, `#### 🔴 Critical & Security Issues (${criticals.length})`, '');
      for (const item of criticals) {
        const location = item.line ? `${codeSpan(item.file)}:${item.line}` : codeSpan(item.file);
        parts.push(`- **${sanitizeText(item.title || 'Security/Critical Flaw')}** in ${location}`);
        parts.push(`  ${indentContinuation(item.description)}`);
        if (item.suggestion && item.suggestion.trim()) {
          parts.push('  <details><summary>💡 Suggested fix</summary>', '', `  ${fencedCode(item.suggestion)}`, '  </details>', '');
        } else {
          parts.push('');
        }
      }
    }

    // 2. Warnings & Edge cases (Always expanded, actionable)
    if (warnings.length > 0) {
      parts.push(`---`, `#### 🟡 Warnings & Edge Cases (${warnings.length})`, '');
      for (const item of warnings) {
        const location = item.line ? `${codeSpan(item.file)}:${item.line}` : codeSpan(item.file);
        parts.push(`- **${sanitizeText(item.title || 'Warning')}** in ${location}`);
        parts.push(`  ${indentContinuation(item.description)}`);
        if (item.suggestion && item.suggestion.trim()) {
          parts.push('  <details><summary>💡 Suggested fix</summary>', '', `  ${fencedCode(item.suggestion)}`, '  </details>', '');
        } else {
          parts.push('');
        }
      }
    }

    // 3. Minor suggestions (Collapsed under details to avoid developer overthinking and visual fatigue)
    if (suggestions.length > 0) {
      parts.push(
        `---`,
        `<details><summary><b>💡 Minor Suggestions & Code Improvements (${suggestions.length})</b></summary>`,
        ''
      );
      for (const item of suggestions) {
        const location = item.line ? `${codeSpan(item.file)}:${item.line}` : codeSpan(item.file);
        parts.push(`- **${sanitizeText(item.title || 'Suggestion')}** in ${location}`);
        parts.push(`  ${indentContinuation(item.description)}`);
        if (item.suggestion && item.suggestion.trim()) {
          parts.push('  <details><summary>Suggested fix</summary>', '', `  ${fencedCode(item.suggestion)}`, '  </details>', '');
        } else {
          parts.push('');
        }
      }
      parts.push('</details>', '');
    }
  }

  // Highlighted strengths (Collapsed)
  if (positives.length > 0) {
    parts.push(
      '<details><summary><b>🌟 Highlighted Strengths (' + positives.length + ')</b></summary>',
      '',
      ...positives.map((p) => `- ${indentContinuation(p)}`),
      '</details>',
      ''
    );
  }

  // Ignored / filtered files list (Collapsed)
  if (ignoredFiles.length > 0) {
    parts.push(
      '<details><summary><b>Filtered Non-Code Files (' + ignoredFiles.length + ')</b></summary>',
      '',
      ...ignoredFiles.map((f) => `- ${codeSpan(f)}`),
      '</details>',
      ''
    );
  }

  // Footer
  parts.push(
    '---',
    `<sub>Automated review powered by [NormaHub API](https://normahub.cc) · Model: ${codeSpan(model)}</sub>`
  );

  return parts.join('\n');
}
