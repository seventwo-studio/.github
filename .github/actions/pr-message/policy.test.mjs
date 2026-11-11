import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTitle, annotationData, summary } from './policy.mjs';
import { run } from './action.mjs';

const head = 'a'.repeat(40);
function fixture(overrides = {}) {
  const event = { number: 18, pull_request: { number: 18, title: 'stale event title', head: { sha: head } } };
  let pr = { number: 18, title: 'fix: accept renamed PRs', head: { sha: head }, base: { repo: { full_name: 'owner/repo' } } };
  const writes = [], logs = [], requests = [];
  const options = { env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: '/event', INPUT_TOKEN: 'fixture-private-token', GITHUB_OUTPUT: '/output', GITHUB_STEP_SUMMARY: '/summary' },
    inspect: async () => ({ size: 256 }), read: async () => JSON.stringify(event), append: async (...args) => { writes.push(args); }, log: value => logs.push(value),
    fetcher: async (url, options) => { requests.push({ url: String(url), options }); return new Response(JSON.stringify(pr)); }, ...overrides };
  return { options, writes, logs, requests, event, setPR: value => { pr = value; }, pr: () => pr };
}

test('the actual Canaveral title fails only after the squash suffix consumes the budget', () => {
  const title = 'feat: migrate Canaveral to TypeScript and Rust with managed runtime updates';
  const result = validateTitle(title, 18);
  assert.equal(result.valid, false); assert.equal(result.subjectLength, 69); assert.equal(result.maximumSubject, 66);
  assert.equal(validateTitle('feat: port Canaveral to TypeScript and Rust with managed updates', 18).valid, true);
});
test('exact subject boundary adapts to PR number length', () => {
  for (const number of [1, 18, 999, 10000, Number.MAX_SAFE_INTEGER]) {
    const n = 72 - ` (#${number})`.length;
    assert.equal(validateTitle(`fix: ${'a'.repeat(n)}`, number).valid, true);
    assert.equal(validateTitle(`fix: ${'a'.repeat(n + 1)}`, number).valid, false);
  }
});
test('scopes, breaking changes and any lowercase type preserve the enterprise policy', () => {
  for (const title of ['feat(api): add accounts', 'fix!: remove old endpoint', 'refactor(core)!: change storage', 'custom: reviewed change', 'revert: remove broken feature']) assert.equal(validateTitle(title, 5).valid, true, title);
  for (const title of ['Feat: title', 'fix:title', 'fix(): title', 'fix: ', 'Merge feature', 'Revert "old feature"']) assert.equal(validateTitle(title, 5).valid, false, title);
});
test('Unicode counts code points and malformed or multiline titles are refused', () => {
  assert.equal(validateTitle(`feat: ${'🚀'.repeat(66)}`, 18).valid, true);
  assert.equal(validateTitle(`feat: ${'🚀'.repeat(67)}`, 18).valid, false);
  for (const title of ['fix: first\nsecond', 'fix: first\rsecond', 'fix: \ud800']) assert.throws(() => validateTitle(title, 18));
  for (const number of [0, -1, 1.5, '18', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateTitle('fix: valid', number));
});
test('annotations and summaries cannot turn PR text into workflow commands or markup', () => {
  assert.equal(annotationData('%\r\n::error::injected'), '%25%0D%0A::error::injected');
  const text = summary(validateTitle('fix: <script>`title`</script>', 18));
  assert.ok(!text.includes('<script>')); assert.ok(text.includes('&lt;script&gt;&#96;'));
});
test('action rereads the current title for edits and manual reruns without checking out PR code', async () => {
  const f = fixture(); const result = await run(f.options);
  assert.equal(result.valid, true); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, 'https://api.github.com/repos/owner/repo/pulls/18');
  assert.equal(f.requests[0].options.redirect, 'error'); assert.equal(f.requests[0].options.headers.Authorization, 'Bearer fixture-private-token');
  assert.deepEqual(f.writes[0], ['/output', 'valid=true\n']); assert.ok(!JSON.stringify(f.logs).includes('fixture-private-token'));
});
test('an invalid current title fails even if the event snapshot was valid', async () => {
  const f = fixture(); f.event.pull_request.title = 'fix: valid'; f.setPR({ ...f.pr(), title: 'Unconventional current title' });
  assert.equal((await run(f.options)).valid, false); assert.ok(f.logs[0].startsWith('::error'));
});
test('stale head, wrong repository and wrong PR responses never pass', async () => {
  for (const change of [{ head: { sha: 'b'.repeat(40) } }, { base: { repo: { full_name: 'other/repo' } } }, { number: 19 }, { head: {} }]) {
    const f = fixture(); f.setPR({ ...f.pr(), ...change }); await assert.rejects(run(f.options)); assert.equal(f.writes.length, 0);
  }
});
test('missing permissions, redirect failures and oversized or malformed responses fail closed', async () => {
  for (const status of [401, 403, 404, 500]) { const f = fixture({ fetcher: async () => new Response('', { status }) }); await assert.rejects(run(f.options), /permission/); assert.equal(f.writes.length, 0); }
  await assert.rejects(run(fixture({ fetcher: async () => { throw new Error('redirect'); } }).options), /could not be fetched/);
  await assert.rejects(run(fixture({ fetcher: async () => new Response('x'.repeat(1048577)) }).options));
  await assert.rejects(run(fixture({ fetcher: async () => new Response(Buffer.from([255])) }).options));
});
test('unsupported events, malformed repository and token input never reach the API', async () => {
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: '../repo' }, { INPUT_TOKEN: '' }, { INPUT_TOKEN: 'token\nvalue' }]) {
    const f = fixture(); Object.assign(f.options.env, change); await assert.rejects(run(f.options)); assert.equal(f.requests.length, 0);
  }
});
