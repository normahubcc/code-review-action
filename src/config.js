/**
 * NormaHub AI Code Review Configuration Loader.
 * Reads optional .normahub-review.yml or .github/normahub-review.yml from workspace,
 * and normalizes action inputs coming from the workflow environment.
 */

import fs from 'fs';
import path from 'path';

export const DEFAULT_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_MAX_DIFF_LENGTH = 50000;
export const SEVERITY_VALUES = ['CRITICAL', 'WARNING', 'SUGGESTION'];

/**
 * Removes a trailing `# comment` from a YAML scalar without touching `#`
 * inside quoted strings or inside regex/glob patterns.
 * @param {string} line
 * @returns {string}
 */
export function stripInlineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/**
 * Lightweight zero-dependency YAML parser for key-value, lists, and string properties.
 * @param {string} yamlStr
 * @returns {object}
 */
export function parseSimpleYaml(yamlStr) {
  const result = {
    custom_rules: [],
    ignore_patterns: [],
    language: 'en',
    min_severity: 'SUGGESTION',
  };

  if (!yamlStr || typeof yamlStr !== 'string') {
    return result;
  }

  const lines = yamlStr.split('\n');
  let currentArrayKey = null;

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine.trim());
    if (!line || line.startsWith('#')) continue;

    // Check list item: - "some rule"
    if (line.startsWith('-') && currentArrayKey) {
      let val = line.substring(1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.substring(1, val.length - 1);
      }
      result[currentArrayKey].push(val);
      continue;
    }

    // Check key: value or key:
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.substring(0, colonIdx).trim();
      const val = line.substring(colonIdx + 1).trim();

      if (['custom_rules', 'ignore_patterns', 'exclude'].includes(key)) {
        currentArrayKey = key === 'exclude' ? 'ignore_patterns' : key;
        if (!result[currentArrayKey]) result[currentArrayKey] = [];
        if (val) {
          result[currentArrayKey].push(val.replace(/^['"]|['"]$/g, ''));
        }
      } else {
        currentArrayKey = null;
        const cleanVal = val.replace(/^['"]|['"]$/g, '');
        if (key === 'language') {
          const lang = cleanVal.toLowerCase();
          // Only 'ru' and 'en' are implemented; anything else silently falls back to English.
          result.language = lang === 'ru' ? 'ru' : 'en';
        }
        if (key === 'min_severity') {
          const sev = cleanVal.toUpperCase();
          result.min_severity = SEVERITY_VALUES.includes(sev) ? sev : 'SUGGESTION';
        }
        if (key === 'model' && cleanVal) result.model = cleanVal;
      }
    }
  }

  return result;
}

/**
 * Loads configuration from workspace filesystem.
 * @param {string} [workspaceDir=process.cwd()]
 * @returns {object}
 */
export function loadReviewConfig(workspaceDir = process.cwd()) {
  const possiblePaths = [
    path.join(workspaceDir, '.normahub-review.yml'),
    path.join(workspaceDir, '.normahub-review.yaml'),
    path.join(workspaceDir, '.github', 'normahub-review.yml'),
    path.join(workspaceDir, '.github', 'normahub-review.yaml'),
  ];

  for (const cfgPath of possiblePaths) {
    if (fs.existsSync(cfgPath)) {
      try {
        const content = fs.readFileSync(cfgPath, 'utf8');
        const parsed = parseSimpleYaml(content);
        console.log(`⚙️ Loaded custom review configuration from: ${path.relative(workspaceDir, cfgPath)}`);
        return parsed;
      } catch (e) {
        console.warn(`[NormaHub Config] Failed reading ${cfgPath}: ${e.message}`);
      }
    }
  }

  return {
    custom_rules: [],
    ignore_patterns: [],
    language: 'en',
    min_severity: 'SUGGESTION',
  };
}

/**
 * Actions-compatible boolean parsing. Accepts true/1/yes/on in any case;
 * anything unrecognized falls back to the provided default.
 * @param {string|undefined|null} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/**
 * Parses a strictly positive integer, falling back on junk/zero/negative input.
 * @param {string|number|undefined|null} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Detects an unresolved GitHub Actions expression (e.g. `${{ github.token }}`)
 * that was passed through literally instead of being evaluated.
 * @param {string|undefined|null} value
 * @returns {boolean}
 */
export function isUnresolvedExpression(value) {
  return typeof value === 'string' && value.includes('${{') && value.includes('}}');
}

/**
 * Splits a raw ignore-patterns input into individual patterns.
 * Supports newline and comma separators; patterns are regexes.
 * @param {string|undefined|null} value
 * @returns {string[]}
 */
export function splitIgnorePatterns(value) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reads and normalizes action inputs from the process environment.
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {object}
 */
export function readInputs(env = process.env) {
  return {
    apiKey: String(env.NORMAHUB_API_KEY || '').trim(),
    githubToken: String(env.GITHUB_TOKEN || '').trim(),
    model: String(env.INPUT_MODEL || '').trim() || DEFAULT_MODEL,
    maxDiffLength: parsePositiveInt(env.INPUT_MAX_DIFF_LENGTH, DEFAULT_MAX_DIFF_LENGTH),
    ignorePatterns: splitIgnorePatterns(env.INPUT_IGNORE_PATTERNS),
    failOnCritical: parseBoolean(env.INPUT_FAIL_ON_CRITICAL, false),
    inlineComments: parseBoolean(env.INPUT_INLINE_COMMENTS, true),
    prNumber: String(env.PR_NUMBER || '').trim(),
    repo: String(env.GITHUB_REPOSITORY || '').trim(),
    apiUrl: String(env.GITHUB_API_URL || '').trim() || 'https://api.github.com',
    commitSha: String(env.INPUT_COMMIT_SHA || env.GITHUB_SHA || '').trim(),
  };
}
