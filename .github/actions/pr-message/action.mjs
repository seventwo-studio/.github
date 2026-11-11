import { readFile, appendFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTitle, annotationData, summary } from './policy.mjs';

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
  let response;
  try {
    response = await fetcher(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('The current PR metadata could not be fetched; the check has not passed.'); }
  if (!response.ok) throw new Error(`Reading current PR metadata failed with HTTP ${response.status}; pull-requests: read permission is required.`);
  // PR metadata is small. Bound the streamed response rather than trusting Content-Length.
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1048576) { await response.body.cancel().catch(() => {}); throw new Error('The PR metadata response exceeds its bound.'); }
    chunks.push(Buffer.from(chunk));
  }
  const pr = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (pr.number !== number || pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error('The PR metadata belongs to a different repository or pull request.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pr.head?.sha ?? '')) throw new Error('The PR head identity is unavailable.');
  if (event.pull_request?.head?.sha && event.pull_request.head.sha !== pr.head.sha) throw new Error('This run belongs to an older PR head; use the current run.');
  const result = validateTitle(pr.title, number);
  if (env.GITHUB_OUTPUT) await append(env.GITHUB_OUTPUT, `valid=${result.valid}\n`);
  if (env.GITHUB_STEP_SUMMARY) await append(env.GITHUB_STEP_SUMMARY, summary(result));
  log(result.valid ? result.explanation : `::error title=PR squash message policy::${annotationData(result.explanation)}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (!(await run()).valid) process.exitCode = 1; }
  catch { console.log('::error title=PR squash message policy::PR metadata validation could not complete. Check repository permissions, event context and API availability; the check has not passed.'); process.exitCode = 1; }
}
