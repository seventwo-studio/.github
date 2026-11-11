import { readFile, appendFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTitle, validateCommitMessage, annotationData, summary } from './policy.mjs';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_COMMITS = 250;
class CommitLimitError extends Error {}

export async function run({ env = process.env, fetcher = fetch, read = readFile, inspect = stat, append = appendFile, log = console.log } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') || repository.split('/').some(part => ['.', '..'].includes(part))) throw new Error('A GitHub repository context is required.');
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)) throw new Error('This action requires a pull request event.');
  if (!env.GITHUB_EVENT_PATH || (await inspect(env.GITHUB_EVENT_PATH)).size > 1048576) throw new Error('A bounded pull request event is required.');
  const event = JSON.parse(await read(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.pull_request?.number ?? event.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A positive PR number is required.');
  const token = env.INPUT_TOKEN;
  if (!token || /[\r\n]/u.test(token)) throw new Error('Provide a repository token with pull-requests: read permission.');
  const api = new URL(env.GITHUB_API_URL ?? 'https://api.github.com');
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw new Error('GitHub API must use a trusted HTTPS origin.');
  const endpoint = new URL(`${api.href.replace(/\/$/u, '')}/repos/${repository}/pulls/${number}`);
  async function json(url, label, limit = 1048576) {
    let response;
    try {
      response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new Error(`${label} could not be fetched; the check has not passed.`); }
    if (!response.ok) throw new Error(`Reading ${label} failed with HTTP ${response.status}; pull-requests: read permission is required.`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) { await response.body.cancel().catch(() => {}); throw new Error('The API response exceeds its bound.'); }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }
  function metadata(pr) {
    if (pr.number !== number || pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error('The PR metadata belongs to a different repository or pull request.');
    if (!SHA.test(pr.head?.sha ?? '') || !SHA.test(pr.base?.sha ?? '')) throw new Error('The PR head or base identity is unavailable.');
    if (!Number.isSafeInteger(pr.commits) || pr.commits < 1) throw new Error('The PR commit count is unavailable.');
    if (pr.commits > MAX_COMMITS) throw new CommitLimitError('This PR exceeds the 250-commit metadata API limit. Rebase or split it before validation; partial history cannot pass.');
    return pr;
  }
  const pr = metadata(await json(endpoint, 'current PR metadata'));
  if (event.pull_request?.head?.sha && event.pull_request.head.sha !== pr.head.sha) throw new Error('This run belongs to an older PR head; use the current run.');
  const seen = new Set(), invalidCommitShas = [];
  for (let page = 1; seen.size < pr.commits; page += 1) {
    const commits = await json(new URL(`${endpoint.href}/commits?per_page=100&page=${page}`), 'PR commits', 4194304);
    if (!Array.isArray(commits) || commits.length !== Math.min(100, pr.commits - seen.size)) throw new Error('The PR commit list is incomplete or inconsistent.');
    for (const commit of commits) {
      if (!SHA.test(commit?.sha ?? '') || seen.has(commit.sha)) throw new Error('The PR commit list contains an invalid or duplicate identity.');
      seen.add(commit.sha);
      if (!validateCommitMessage(commit.commit?.message)) invalidCommitShas.push(commit.sha);
    }
  }
  if (!seen.has(pr.head.sha)) throw new Error('The PR commit list does not include the current head.');
  const current = metadata(await json(endpoint, 'current PR metadata'));
  if (current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha || current.commits !== pr.commits) throw new Error('The PR head, base or commit count changed during validation; use the current run.');
  const title = validateTitle(current.title, number);
  const valid = title.valid && invalidCommitShas.length === 0;
  let explanation = title.explanation;
  if (invalidCommitShas.length) explanation += ` Invalid commit messages: ${invalidCommitShas.map(sha => sha.slice(0, 12)).join(', ')}. Each message must satisfy both enterprise rules, including a conventional subject and a blank line before any body.`;
  else if (valid) explanation = `The PR title, squash suffix and all ${seen.size} commit messages satisfy both enterprise message rules.`;
  const result = { ...title, valid, titleValid: title.valid, commitCount: seen.size, invalidCommitShas, explanation };
  if (env.GITHUB_OUTPUT) await append(env.GITHUB_OUTPUT, `valid=${result.valid}\n`);
  if (env.GITHUB_STEP_SUMMARY) await append(env.GITHUB_STEP_SUMMARY, summary(result));
  log(result.valid ? result.explanation : `::error title=PR message policy::${annotationData(result.explanation)}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (!(await run()).valid) process.exitCode = 1; }
  catch (error) { console.log(`::error title=PR message policy::${error instanceof CommitLimitError ? annotationData(error.message) : 'PR title and commit validation could not complete. Check repository permissions, event context, API availability and documented metadata bounds; the check has not passed.'}`); process.exitCode = 1; }
}
