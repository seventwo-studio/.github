import test from 'node:test';
import assert from 'node:assert/strict';
import { planEnterprise, proposeCaller, parseArguments, RUNNER_WORKFLOW, CALLER, WORKFLOW_PATH } from './rollout-pr-message.mjs';

test('enterprise discovery follows organization pagination and includes every active repository', async () => {
  const calls = [];
  const plan = await planEnterprise('enterprise', async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === 'graphql') return { data: { enterprise: { organizations: body.variables.cursor ? { nodes: [{ login: 'second' }], pageInfo: { hasNextPage: false } } : { nodes: [{ login: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'next' } } } } };
    const org = path.split('/')[1]; return [{ id: org === 'first' ? 1 : 2, full_name: `${org}/active`, default_branch: 'trunk', permissions: { push: true } }, { archived: true, full_name: `${org}/archived` }];
  });
  assert.deepEqual(plan.organizations, ['first', 'second']); assert.deepEqual(plan.repositories.map(item => item.repository), ['first/active', 'second/active']); assert.equal(plan.skipped.length, 2); assert.equal(calls.filter(call => call.path === 'graphql').length, 2);
});
test('repository discovery does not silently truncate after 100 repositories', async () => {
  const paths = [];
  const plan = await planEnterprise('enterprise', async (_, path) => {
    paths.push(path);
    if (path === 'graphql') return { data: { enterprise: { organizations: { nodes: [{ login: 'org' }], pageInfo: { hasNextPage: false } } } } };
    return path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: `org/repo-${i}`, default_branch: 'main' })) : [{ id: 101, full_name: 'org/final', default_branch: 'main' }];
  });
  assert.equal(plan.repositories.length, 101); assert.ok(paths.some(path => path.endsWith('page=2')));
});
test('unavailable enterprise discovery cannot become a partial rollout', async () => {
  await assert.rejects(planEnterprise('enterprise', async () => ({ data: { enterprise: null } })));
  await assert.rejects(planEnterprise('enterprise', async () => ({ data: { enterprise: { organizations: { nodes: [], pageInfo: { hasNextPage: true } } } } })));
});
test('empty repositories are positively identified rather than mistaken for unreadable branches', async () => {
  const plan = await planEnterprise('enterprise', async (_, path, body) => {
    if (path === 'graphql' && body.variables.owner) return { data: { repository: { isEmpty: true } } };
    if (path === 'graphql') return { data: { enterprise: { organizations: { nodes: [{ login: 'org' }], pageInfo: { hasNextPage: false } } } } };
    return [{ id: 1, name: 'empty', full_name: 'org/empty', size: 0, default_branch: 'main' }];
  });
  assert.deepEqual(plan.repositories, []); assert.deepEqual(plan.skipped, [{ repository: 'org/empty', reason: 'empty' }]);
});
test('a missing pilot repository value cannot accidentally apply to the entire enterprise', () => {
  for (const args of [[], ['--enterprise', 'org', '--apply', '--repository'], ['--enterprise', 'org', '--repository', '--apply'], ['--enterprise', 'org', '--apply', '--apply'], ['--enterprise', 'org', '--unknown'], ['--enterprise', 'org', '--repository', '../repo']]) assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(['--enterprise', 'enterprise', '--apply', '--repository', 'org/repo']), { enterprise: 'enterprise', apply: true, repository: 'org/repo' });
  assert.equal(parseArguments(['--enterprise', 'enterprise']).apply, false);
});

const item = { repository: 'org/repo', id: 1, base: 'main' };
function api({ existing, prior, changed = false, runner = {} } = {}) {
  const calls = [];
  return { calls, request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === 'repos/org/repo') return { id: changed ? 2 : 1, full_name: 'org/repo', visibility: 'public', default_branch: 'main', permissions: { push: true } };
    if (path.startsWith('orgs/org/actions/runner-groups?')) return { runner_groups: [{ id: 14, name: 'amsterdam', inherited: true }] };
    if (path === 'orgs/org/actions/runner-groups/14') return { id: 14, visibility: 'selected', restricted_to_workflows: true, selected_workflows: [RUNNER_WORKFLOW], allows_public_repositories: true, inherited_allows_public_repositories: true, ...runner };
    if (path.includes('/runner-groups/14/repositories?')) return { repositories: [{ id: 1 }] };
    if (path.includes('/git/trees/')) return { tree: existing === undefined ? [] : [{ path: WORKFLOW_PATH, sha: 'file' }], truncated: false };
    if (path.includes('/git/blobs/')) return { content: Buffer.from(existing).toString('base64') };
    if (path.includes('/pulls?')) return prior ? [{ head: { ref: 'ci/enterprise-pr-message' }, base: { ref: 'main' }, state: 'open', html_url: prior }] : [];
    if (path.includes('/git/ref/heads/')) return { object: { sha: 'a'.repeat(40) } };
    if (method === 'POST' && path.endsWith('/pulls')) return { html_url: 'https://github.com/org/repo/pull/1' };
    return {};
  } };
}
test('rollout creates only an isolated caller branch and PR, with no direct default-branch update', async () => {
  const f = api(); const result = await proposeCaller(item, f.request);
  assert.equal(result.status, 'proposed'); const writes = f.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 3); assert.equal(writes[0].body.ref, 'refs/heads/ci/enterprise-pr-message'); assert.equal(writes[1].body.branch, 'ci/enterprise-pr-message');
  assert.equal(Buffer.from(writes[1].body.content, 'base64').toString('utf8'), CALLER); assert.ok(!CALLER.includes('checkout'));
  assert.ok(CALLER.includes('\n  pull_request:\n'));
  assert.ok(CALLER.includes('edited')); assert.ok(!CALLER.includes('secrets: inherit'));
});
test('installed or already proposed callers are idempotent', async () => {
  for (const options of [{ existing: CALLER }, { prior: 'https://github.com/org/repo/pull/1' }]) {
    const f = api(options); const result = await proposeCaller(item, f.request);
    assert.ok(['installed', 'proposed'].includes(result.status)); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  }
});
test('foreign existing workflows, changed repository identity and incomplete trees are never overwritten', async () => {
  for (const options of [{ existing: 'custom workflow' }, { changed: true }]) { const f = api(options); await assert.rejects(proposeCaller(item, f.request)); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0); }
  const f = api(); await assert.rejects(proposeCaller(item, async (method, path, body) => path.includes('/git/trees/') ? { tree: [], truncated: true } : f.request(method, path, body))); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});
test('missing public access at either runner layer blocks rollout before branch or PR writes', async () => {
  for (const runner of [{ allows_public_repositories: false }, { inherited_allows_public_repositories: false }]) {
    const f = api({ runner }); await assert.rejects(proposeCaller(item, f.request), /both enterprise and organization/); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  }
});
test('unapproved workflows and missing repository grants cannot produce broken caller proposals', async () => {
  for (const runner of [{ restricted_to_workflows: false }, { selected_workflows: [] }]) { const f = api({ runner }); await assert.rejects(proposeCaller(item, f.request), /not approved/); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0); }
  const f = api(); await assert.rejects(proposeCaller(item, (method, path, body) => path.includes('/runner-groups/14/repositories?') ? { repositories: [] } : f.request(method, path, body)), /not been granted/); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});
