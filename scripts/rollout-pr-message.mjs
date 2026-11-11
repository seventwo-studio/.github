#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKFLOW_PATH = '.github/workflows/enterprise-pr-message.yml';
export const ROLLOUT_BRANCH = 'ci/enterprise-pr-message';
export const RUNNER_WORKFLOW = 'seventwo-studio/.github/.github/workflows/pr-message.yml@refs/heads/main';
export const CALLER = `# Managed by seventwo-studio/.github; validation stays in the shared workflow.
name: PR message policy
on:
  pull_request:
    types: [opened, edited, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: read
jobs:
  pr-message:
    name: PR message policy
    uses: seventwo-studio/.github/.github/workflows/pr-message.yml@main
`;

export function ghRequest(method, path, body) {
  const result = spawnSync('gh', ['api', path, '--method', method, ...(body === undefined ? [] : ['--input', '-'])], {
    input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', maxBuffer: 16 * 1048576, shell: false,
  });
  if (result.error || result.status !== 0) throw new Error(`GitHub request failed: ${method} ${path}`);
  const value = JSON.parse(result.stdout);
  if (value.errors) throw new Error('GitHub GraphQL returned errors; enterprise discovery is incomplete.');
  return value;
}

export async function planEnterprise(enterprise, request = ghRequest) {
  if (!/^[A-Za-z0-9-]+$/u.test(enterprise)) throw new Error('An enterprise slug is required.');
  const organizations = []; let cursor = null;
  do {
    const result = await request('POST', 'graphql', { query: 'query($slug:String!,$cursor:String){enterprise(slug:$slug){organizations(first:100,after:$cursor){nodes{login}pageInfo{hasNextPage endCursor}}}}', variables: { slug: enterprise, cursor } });
    const page = result.data?.enterprise?.organizations;
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo || typeof page.pageInfo.hasNextPage !== 'boolean') throw new Error('Cannot discover every enterprise organization.');
    organizations.push(...page.nodes.map(node => node.login));
    if (page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor)) throw new Error('Enterprise organization pagination did not advance.');
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  if (!organizations.length || organizations.some(name => !/^[A-Za-z0-9-]+$/u.test(name))) throw new Error('Enterprise organization inventory is empty or invalid.');
  const repositories = [], skipped = [];
  for (const org of organizations) {
    for (let page = 1; ; page++) {
      const batch = await request('GET', `orgs/${org}/repos?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Repository discovery did not return an inventory.');
      for (const repo of batch) {
        if (repo.archived || repo.disabled || !repo.default_branch) { skipped.push({ repository: repo.full_name, reason: repo.archived ? 'archived' : repo.disabled ? 'disabled' : 'no default branch' }); continue; }
        if (!Number.isSafeInteger(repo.id) || !repo.full_name?.toLowerCase().startsWith(org.toLowerCase() + '/')) throw new Error('Repository identity differs from its organization.');
        if (repo.size === 0) {
          const state = await request('POST', 'graphql', { query: 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){isEmpty}}', variables: { owner: org, name: repo.name } });
          if (typeof state.data?.repository?.isEmpty !== 'boolean') throw new Error('Empty-repository inspection is unavailable.');
          if (state.data.repository.isEmpty) { skipped.push({ repository: repo.full_name, reason: 'empty' }); continue; }
        }
        repositories.push({ repository: repo.full_name, id: repo.id, base: repo.default_branch, writable: repo.permissions?.push === true });
      }
      if (batch.length < 100) break;
    }
  }
  return { schema: 'enterprise-pr-message-rollout-v1', enterprise, organizations, repositories, skipped };
}

export async function proposeCaller(item, request = ghRequest) {
  const repo = item.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) || repo.split('/').some(part => ['.', '..'].includes(part))) throw new Error('Invalid repository identity.');
  const current = await request('GET', `repos/${repo}`);
  if (current.id !== item.id || current.default_branch !== item.base || current.archived || current.disabled || !current.permissions?.push) throw new Error('Repository identity, branch, activity or write access changed.');
  await verifyRunnerAccess(current, request);
  // A directory inventory avoids treating a permission/network error as an absent file.
  const tree = await request('GET', `repos/${repo}/git/trees/${encodeURIComponent(item.base)}?recursive=1`);
  if (!Array.isArray(tree.tree) || tree.truncated) throw new Error('Complete repository tree is required before adding a caller.');
  const existing = tree.tree.find(entry => entry.path === WORKFLOW_PATH);
  if (existing) {
    const file = await request('GET', `repos/${repo}/git/blobs/${existing.sha}`);
    if (Buffer.from(file.content, 'base64').toString('utf8') === CALLER) return { repository: repo, status: 'installed' };
    throw new Error('An existing workflow at the rollout path requires manual review; it was not overwritten.');
  }
  const pulls = await request('GET', `repos/${repo}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + ROLLOUT_BRANCH)}&per_page=100`);
  const prior = pulls.find(pr => pr.head?.ref === ROLLOUT_BRANCH && pr.base?.ref === item.base);
  if (prior) return { repository: repo, status: prior.state === 'open' ? 'proposed' : 'closed proposal needs review', url: prior.html_url };
  const base = await request('GET', `repos/${repo}/git/ref/heads/${encodeURIComponent(item.base)}`);
  if (!/^[a-f0-9]{40}$/u.test(base.object?.sha ?? '')) throw new Error('The current default branch is unavailable.');
  // A conflicting existing branch causes a definite failure; never force-update it.
  await request('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${ROLLOUT_BRANCH}`, sha: base.object.sha });
  await request('PUT', `repos/${repo}/contents/${WORKFLOW_PATH}`, { branch: ROLLOUT_BRANCH, message: 'ci: add enterprise PR message check', content: Buffer.from(CALLER).toString('base64') });
  const pr = await request('POST', `repos/${repo}/pulls`, { base: item.base, head: ROLLOUT_BRANCH, title: 'ci: validate PR squash titles with enterprise policy', body: 'Add the small caller for the centrally managed PR squash-title policy. It reruns on title edits, uses the enterprise runner workflow, and never checks out PR code.\n\nThe shared implementation lives in seventwo-studio/.github. Existing repository CI and branch rules remain in place.' });
  return { repository: repo, status: 'proposed', url: pr.html_url };
}

export async function verifyRunnerAccess(repo, request = ghRequest) {
  const org = repo.full_name.split('/')[0]; let found;
  for (let page = 1; ; page++) {
    const inventory = await request('GET', `orgs/${org}/actions/runner-groups?per_page=100&page=${page}`);
    if (!Array.isArray(inventory.runner_groups)) throw new Error('Runner group discovery is unavailable.');
    found = inventory.runner_groups.find(group => group.name === 'amsterdam' && group.inherited);
    if (found || inventory.runner_groups.length < 100) break;
  }
  if (!found) throw new Error('The enterprise runner group is not shared with this organization.');
  const group = await request('GET', `orgs/${org}/actions/runner-groups/${found.id}`);
  if (!group.restricted_to_workflows || !group.selected_workflows?.includes(RUNNER_WORKFLOW)) throw new Error('The protected shared workflow is not approved for the enterprise runner group.');
  if (repo.visibility === 'public' && (!group.allows_public_repositories || !group.inherited_allows_public_repositories)) throw new Error('Public repositories must be enabled at both enterprise and organization runner-group layers.');
  if (group.visibility === 'all' || group.visibility === 'private' && repo.visibility !== 'public') return;
  if (group.visibility !== 'selected') throw new Error('Repository visibility is not allowed by the runner group.');
  for (let page = 1; ; page++) {
    const inventory = await request('GET', `orgs/${org}/actions/runner-groups/${group.id}/repositories?per_page=100&page=${page}`);
    if (!Array.isArray(inventory.repositories)) throw new Error('Runner repository access is unavailable.');
    if (inventory.repositories.some(item => item.id === repo.id)) return;
    if (inventory.repositories.length < 100) break;
  }
  throw new Error('This repository has not been granted access to the enterprise runner group.');
}

export function parseArguments(args) {
  const values = {}, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--enterprise', '--apply', '--repository'].includes(option) || seen.has(option)) throw new Error('Unknown or repeated rollout option.');
    seen.add(option);
    if (option === '--apply') { values.apply = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('A rollout option value is missing.');
    values[option.slice(2)] = value;
  }
  if (!/^[A-Za-z0-9-]+$/u.test(values.enterprise ?? '')) throw new Error('An enterprise slug is required.');
  if (values.repository !== undefined && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.repository) || values.repository.split('/').some(part => ['.', '..'].includes(part)))) throw new Error('A full repository name is required.');
  return { ...values, apply: values.apply === true };
}

export async function main(args = process.argv.slice(2)) {
  const { enterprise, apply, repository } = parseArguments(args);
  const plan = await planEnterprise(enterprise);
  if (!apply) { console.log(JSON.stringify(plan, null, 2)); return; }
  const source = await ghRequest('GET', 'repos/seventwo-studio/.github/contents/.github/workflows/pr-message.yml?ref=main');
  if (source.type !== 'file' || !source.sha) throw new Error('Merge the shared workflow to main before proposing repository callers.');
  const targets = repository ? plan.repositories.filter(item => item.repository === repository) : plan.repositories;
  if (!targets.length) throw new Error('No active enterprise repositories match the selection.');
  const results = [];
  for (const item of targets) {
    try { results.push(await proposeCaller(item)); }
    catch (error) { results.push({ repository: item.repository, status: 'blocked', reason: error.message }); }
  }
  console.log(JSON.stringify({ enterprise, organizations: plan.organizations, results }, null, 2));
  if (results.some(item => item.status === 'blocked' || item.status === 'closed proposal needs review')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch { console.error('Enterprise rollout did not complete. Check GitHub access and command arguments; no broad policy changes were made.'); process.exitCode = 1; }
}
