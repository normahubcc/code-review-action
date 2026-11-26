/**
 * Smart Diff Parser & Filter for NormaHub Code Review Action.
 * Filters out lockfiles, assets, generated bundles, and vendors.
 */

const DEFAULT_IGNORED_PATTERNS = [
  // Lockfiles
  /pnpm-lock\.yaml$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /mix\.lock$/,
  /go\.sum$/,

  // Minified, bundled & map files
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.bundle\.js$/,

  // Assets and media
  /\.(png|jpe?g|gif|svg|ico|webp|avif|pdf|mp4|webm|wasm|woff2?|eot|ttf)$/i,

  // Compiled & vendor directories
  /(^|\/)(dist|build|out|\.next|node_modules|vendor|target|coverage|\.git)\//,
];

/**
 * Compiles user-supplied ignore patterns, reporting the invalid ones instead of
 * aborting the whole review. Patterns are regular expressions.
 * @param {Array<string|RegExp>} patterns
 * @returns {{ compiled: RegExp[], invalid: string[] }}
 */
export function compileIgnorePatterns(patterns = []) {
  const compiled = [];
  const invalid = [];

  for (const raw of patterns || []) {
    if (raw instanceof RegExp) {
      compiled.push(raw);
      continue;
    }
    const source = String(raw ?? '').trim();
    if (!source) continue;
    try {
      compiled.push(new RegExp(source));
    } catch {
      invalid.push(source);
    }
  }

  return { compiled, invalid };
}

/**
 * Checks whether a file path should be ignored during code review.
 * @param {string} filePath
 * @param {Array<RegExp|string>} extraPatterns
 * @returns {{ ignored: boolean, reason?: string }}
 */
export function shouldIgnoreFile(filePath, extraPatterns = []) {
  if (!filePath) return { ignored: true, reason: 'Empty file path' };

  for (const pattern of DEFAULT_IGNORED_PATTERNS) {
    if (pattern.test(filePath)) {
      return { ignored: true, reason: 'Standard noise / lockfile / asset' };
    }
  }

  const { compiled } = compileIgnorePatterns(extraPatterns);
  for (const rx of compiled) {
    if (rx.test(filePath)) {
      return { ignored: true, reason: `Matches custom pattern: ${rx.source}` };
    }
  }

  return { ignored: false };
}

/**
 * Parses raw git diff string into structured file entries and filters noise.
 * @param {string} rawDiff
 * @param {object} options
 * @param {number} [options.maxDiffLength=50000]
 * @param {Array<string>} [options.extraIgnorePatterns=[]]
 * @returns {{ includedDiff: string, totalFiles: number, reviewedFiles: string[], ignoredFiles: string[], isTruncated: boolean, invalidPatterns: string[] }}
 */
export function parseAndFilterDiff(rawDiff, options = {}) {
  const maxDiffLength = options.maxDiffLength || 50000;
  const { compiled: extraPatterns, invalid: invalidPatterns } = compileIgnorePatterns(
    options.extraIgnorePatterns || []
  );

  if (!rawDiff || typeof rawDiff !== 'string') {
    return {
      includedDiff: '',
      totalFiles: 0,
      reviewedFiles: [],
      ignoredFiles: [],
      isTruncated: false,
      invalidPatterns,
    };
  }

  // Split diff into per-file chunks by "diff --git "
  const rawChunks = rawDiff.split(/(?=diff --git )/g);

  const reviewedFiles = [];
  const ignoredFiles = [];
  const includedChunks = [];
  let currentLength = 0;
  let isTruncated = false;

  for (const chunk of rawChunks) {
    if (!chunk.trim()) continue;

    // Extract file path from header: diff --git a/path/to/file b/path/to/file
    const headerMatch = chunk.match(/diff --git a\/(.+?) b\/(.+?)(\n|\r\n)/);
    const filePath = headerMatch ? headerMatch[2] : '';

    if (!filePath) {
      continue;
    }

    const { ignored } = shouldIgnoreFile(filePath, extraPatterns);
    if (ignored) {
      ignoredFiles.push(filePath);
      continue;
    }

    if (currentLength + chunk.length > maxDiffLength) {
      isTruncated = true;
      // If we haven't included any chunk yet, include a truncated version of the first
      if (includedChunks.length === 0) {
        const remaining = maxDiffLength - currentLength;
        includedChunks.push(chunk.substring(0, remaining) + '\n... [chunk truncated]');
        reviewedFiles.push(filePath);
      }
      break;
    }

    includedChunks.push(chunk);
    reviewedFiles.push(filePath);
    currentLength += chunk.length;
  }

  return {
    includedDiff: includedChunks.join(''),
    totalFiles: reviewedFiles.length + ignoredFiles.length,
    reviewedFiles,
    ignoredFiles,
    isTruncated,
    invalidPatterns,
  };
}

/**
 * Builds the set of new-file (RIGHT side) line numbers that GitHub accepts for
 * inline review comments, taken from the hunk headers of a unified diff.
 * Commenting on any other line makes the whole review API call fail with 422.
 * @param {string} diffText
 * @returns {Map<string, Set<number>>}
 */
export function buildLineIndex(diffText) {
  const index = new Map();
  if (!diffText || typeof diffText !== 'string') return index;

  for (const chunk of diffText.split(/(?=diff --git )/g)) {
    if (!chunk.trim()) continue;
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+?)\r?\n/);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];
    const lines = index.get(filePath) || new Set();

    for (const hunk of chunk.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) {
        lines.add(start + i);
      }
    }

    index.set(filePath, lines);
  }

  return index;
}
