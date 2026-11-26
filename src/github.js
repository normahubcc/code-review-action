/**
 * GitHub API Client for NormaHub Code Review Action.
 * Handles fetching PR diffs and idempotent comment updates (anti-spam).
 */

import { BOT_SIGNATURE, fencedCode } from './formatter.js';

const USER_AGENT = 'NormaHub-Code-Review-Action';
const PER_PAGE = 100;
// Guardrail so a pathological PR cannot make the action page forever.
const MAX_PAGES = 10;

/**
 * Builds request headers for the GitHub REST API.
 * @param {string} token
 * @param {string} [accept='application/vnd.github.v3+json']
 * @returns {Record<string,string>}
 */
function githubHeaders(token, accept = 'application/vnd.github.v3+json') {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'User-Agent': USER_AGENT,
  };
}

/**
 * Extracts the rel="next" URL from a Link header.
 * @param {Headers|undefined} headers
 * @returns {string|null}
 */
export function nextPageUrl(headers) {
  const link = headers?.get?.('link');
  if (!link) return null;
  const match = String(link).match(/<([^>]+)>\s*;\s*rel="next"/i);
  return match ? match[1] : null;
}

/**
 * Fetches every page of a GitHub list endpoint.
 * @param {string} url
 * @param {string} token
 * @returns {Promise<{ ok: boolean, status?: number, items: any[] }>}
 */
async function fetchAllPages(url, token) {
  const items = [];
  let nextUrl = url;

  for (let page = 0; nextUrl && page < MAX_PAGES; page++) {
    const res = await fetch(nextUrl, { headers: githubHeaders(token) });
    if (!res.ok) {
      return { ok: false, status: res.status, items };
    }
    const data = await res.json();
    if (!Array.isArray(data)) break;
    items.push(...data);
    nextUrl = nextPageUrl(res.headers);
  }

  return { ok: true, items };
}

/**
 * Fetches the unified diff of a pull request.
 * @param {string} apiUrl
 * @param {string} repo
 * @param {number|string} prNumber
 * @param {string} token
 * @returns {Promise<string>}
 */
export async function fetchPullRequestDiff(apiUrl, repo, prNumber, token) {
  const url = `${apiUrl}/repos/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, {
    headers: githubHeaders(token, 'application/vnd.github.v3.diff'),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    // GitHub refuses to generate diffs above 300 changed files or 20,000 lines
    // (HTTP 406). Surface it as a typed error so the entrypoint can skip review
    // gracefully instead of failing the whole workflow.
    if (res.status === 406) {
      const err = new Error(
        `GitHub API refused to generate the diff (HTTP 406). PRs above 300 changed files or 20,000 lines exceed the API limit. ${errText}`
      );
      err.code = 'DIFF_TOO_LARGE';
      throw err;
    }
    throw new Error(`Failed to fetch PR diff (${res.status}): ${errText}`);
  }

  return await res.text();
}

/**
 * Searches for an existing comment on the PR posted by this action.
 * Bots are preferred; pagination covers PRs with more than 100 comments,
 * where the bot comment used to be invisible and re-posted on every push.
 * @param {string} apiUrl
 * @param {string} repo
 * @param {number|string} prNumber
 * @param {string} token
 * @returns {Promise<number|null>} commentId if found, null otherwise
 */
export async function findExistingBotComment(apiUrl, repo, prNumber, token) {
  const url = `${apiUrl}/repos/${repo}/issues/${prNumber}/comments?per_page=${PER_PAGE}`;
  const { items } = await fetchAllPages(url, token);

  const matches = items.filter(
    (comment) => comment && typeof comment.body === 'string' && comment.body.includes(BOT_SIGNATURE)
  );
  if (matches.length === 0) return null;

  const botComment = matches.find((comment) => comment.user && comment.user.type === 'Bot');
  return (botComment || matches[0]).id ?? null;
}

/**
 * Searches for an existing review published by this action.
 * Used to avoid publishing a second review (and duplicated inline comments)
 * every time the PR receives a new push.
 * @param {string} apiUrl
 * @param {string} repo
 * @param {number|string} prNumber
 * @param {string} token
 * @returns {Promise<number|null>}
 */
export async function findExistingBotReview(apiUrl, repo, prNumber, token) {
  const url = `${apiUrl}/repos/${repo}/pulls/${prNumber}/reviews?per_page=${PER_PAGE}`;
  const { items } = await fetchAllPages(url, token);

  const matches = items.filter(
    (review) => review && typeof review.body === 'string' && review.body.includes(BOT_SIGNATURE)
  );
  if (matches.length === 0) return null;

  const botReview = matches.find((review) => review.user && review.user.type === 'Bot');
  return (botReview || matches[0]).id ?? null;
}

/**
 * Posts a new review comment or updates an existing one (anti-spam).
 * If the matched comment cannot be edited (foreign author, deleted comment),
 * a fresh comment is created instead of failing the run.
 * @param {string} apiUrl
 * @param {string} repo
 * @param {number|string} prNumber
 * @param {string} body
 * @param {string} token
 * @returns {Promise<{ action: 'created'|'updated', id: number }>}
 */
export async function postOrUpdateComment(apiUrl, repo, prNumber, body, token) {
  const existingId = await findExistingBotComment(apiUrl, repo, prNumber, token);

  if (existingId) {
    // Update existing comment
    const patchUrl = `${apiUrl}/repos/${repo}/issues/comments/${existingId}`;
    const res = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        ...githubHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    });

    if (res.ok) {
      return { action: 'updated', id: existingId };
    }

    const errText = (await res.text()).slice(0, 300);
    if (![403, 404].includes(res.status)) {
      throw new Error(`Failed to update comment #${existingId} (${res.status}): ${errText}`);
    }
    console.warn(
      `⚠️ Cannot edit comment #${existingId} (${res.status}) — it is not owned by this token. Posting a new comment instead.`
    );
  }

  // Create new comment
  const postUrl = `${apiUrl}/repos/${repo}/issues/${prNumber}/comments`;
  const res = await fetch(postUrl, {
    method: 'POST',
    headers: {
      ...githubHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(`Failed to post new comment (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return { action: 'created', id: data.id };
}

/**
 * Creates a formal GitHub Pull Request Review with inline comments.
 * Enables interactive 1-click 'Commit suggestion' buttons in GitHub UI.
 * @param {string} apiUrl
 * @param {string} repo
 * @param {number|string} prNumber
 * @param {string} commitSha
 * @param {string} body
 * @param {Array<{file: string, line: number, severity?: string, title?: string, description?: string, suggestion?: string}>} findings
 * @param {string} token
 * @param {object} [options]
 * @param {Map<string, Set<number>>} [options.lineIndex] Only lines present in this
 *   diff index are commentable; anything else would reject the whole review (422).
 * @returns {Promise<{ action: 'review_created', id: number, inlineCount: number }>}
 */
export async function createPullRequestReview(
  apiUrl,
  repo,
  prNumber,
  commitSha,
  body,
  findings = [],
  token,
  options = {}
) {
  const postUrl = `${apiUrl}/repos/${repo}/pulls/${prNumber}/reviews`;
  const lineIndex = options.lineIndex instanceof Map ? options.lineIndex : null;

  const inlineComments = findings
    .filter((f) => f && f.file && Number.isInteger(Number(f.line)) && Number(f.line) > 0)
    .filter((f) => !lineIndex || lineIndex.get(f.file)?.has(Number(f.line)))
    .map((f) => {
      const emoji = f.severity === 'CRITICAL' ? '🔴' : f.severity === 'WARNING' ? '🟡' : '💡';
      let commentBody = `### ${emoji} ${f.title || 'Code Finding'}\n\n${f.description || ''}`;
      if (f.suggestion && f.suggestion.trim()) {
        commentBody += `\n\n${fencedCode(f.suggestion)}`;
      }
      return {
        path: f.file,
        line: Number(f.line),
        side: 'RIGHT',
        body: commentBody,
      };
    });

  const payload = {
    body,
    event: 'COMMENT',
  };

  if (commitSha) {
    payload.commit_id = commitSha;
  }

  if (inlineComments.length > 0) {
    payload.comments = inlineComments;
  }

  const res = await fetch(postUrl, {
    method: 'POST',
    headers: {
      ...githubHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300);
    throw new Error(`Failed to create PR review (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return { action: 'review_created', id: data.id, inlineCount: inlineComments.length };
}
