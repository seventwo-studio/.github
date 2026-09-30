# Signed release automation

Call `.github/workflows/release-please.yml` from a personal or SevenTwo repository. It uses a GitHub App installation token scoped to the calling repository, creates verified release commits through GitHub's API, and lets release PRs and tags trigger normal CI. Each repository keeps its own Release Please configuration and version manifest.

The default `GITHUB_TOKEN` suppresses subsequent Actions events. A personal access token triggers CI but does not automatically sign API-created commits as its owner. Use the App installation token for both requirements.

## Register the App once

Create **SevenTwo Releases** under [SevenTwo's developer settings](https://github.com/organizations/seventwo-studio/settings/apps/new):

- Homepage: `https://github.com/seventwo-studio/.github`.
- Disable the webhook. No callback URL, OAuth authorization or event subscriptions are needed.
- Repository permissions: **Contents**, **Issues**, and **Pull requests**, all **Read and write**. Metadata read access is automatic. Issues permission is needed for release labels.
- Installation: **Any account**, so the same App can be installed on `seventwo-studio` and `lucasilverentand`. GitHub requires public visibility for installation across accounts; this does not grant repository access until an account installs the App.

The equivalent registration manifest is [release-app-manifest.json](release-app-manifest.json). It is a reference configuration; do not publish credentials in this file.

Install the App separately on each account using **Only select repositories**. Start with `seventwo-studio/runner`, and add repositories when adopting this workflow. Give the App no ruleset bypass, administration, Actions, organization, or workflow-write permissions.

Generate a private key from the App settings. Keep it in a password manager or another secure local location. Use the public **Client ID** (`Iv…`) with `actions/create-github-app-token@v3`; the numeric App ID is a different identifier.

## Configure each caller

Authenticate `gh` with permission to manage the selected repository's Actions variables and secrets. Store the Client ID as a repository variable and send the PEM directly to the secret API, without printing it:

```sh
gh variable set RELEASE_APP_CLIENT_ID --repo OWNER/REPO --body 'IvYOUR_CLIENT_ID'
gh secret set RELEASE_APP_PRIVATE_KEY --repo OWNER/REPO < /secure/path/seventwo-releases.pem
```

Repeat for each explicitly selected personal or SevenTwo repository. Organization secrets with selected repository access are another option when organization administration is available. Personal-account repositories use repository secrets. Do not use `secrets: inherit`: pass only the key required by this workflow.

Add this caller, replacing `REVIEWED_COMMIT_SHA` with the full immutable commit containing the shared workflow:

```yaml
name: Release Please

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  release-please:
    uses: seventwo-studio/.github/.github/workflows/release-please.yml@REVIEWED_COMMIT_SHA
    with:
      client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}
    secrets:
      private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

Use the same shared URL from either account. There is no need to copy the workflow into `lucasilverentand/.github`. Keep the caller workflow name **Release Please** when downstream publishing listens for that name with `workflow_run`.

Optional inputs: `target-branch`, `config-file`, `manifest-file`, `release-type`, and `skip-github-release`. Set `target-branch` and the push trigger together for a release branch other than the default. For a repository without a manifest, set `release-type` to its supported strategy. The workflow runs only on a push or manual dispatch against the configured release branch; it skips PR events. It exposes `releases-created`, `paths-released`, and `prs` outputs for downstream jobs. The installation token is revoked at the end of the job.

Both the reusable workflow and its action dependencies must be allowed by the caller's Actions policy. If selected-action rules reject the call, add the shared workflow's exact SHA to the allowed patterns rather than broadening the policy to all actions.

## Verify adoption

1. Merge the reviewed workflow and caller PRs, then manually run the caller on its release branch. To test PR generation without publishing releases, use a temporary caller with `skip-github-release: true`.
2. Confirm Release Please creates or updates the release PR as the App bot. Every introduced commit must show **Verified**; the shared workflow fails if verification is missing.
3. Confirm required CI runs on that PR and the signed-commit rule permits merging. Do not automatically merge the release PR.
4. After a separately approved release merge, confirm tag/release-triggered delivery runs.
5. Remove the old `RELEASE_PLEASE_TOKEN` secret from this repository only after App-based automation is verified. Do not revoke a personal token still used by other repositories.

Switching credentials does not sign an existing commit in place. Release Please can replace its release-branch commit on the next update; otherwise amend and sign the commit and push with an explicit lease against the previously inspected SHA. Keep the tree and commit message unchanged when only repairing a signature.

## Reuse the App for other automation

Other trusted workflows can mint the same repository-scoped token with the pinned `actions/create-github-app-token` action, passing `client-id` and `private-key` as above. Omit `owner` and `repositories` to keep access scoped to the caller and request only the permissions that job needs. API-created bot commits must omit custom author, committer and signature fields for GitHub's automatic bot signing. A local `git commit` is not signed merely because its push uses an App token.

See [GitHub's bot-signing requirements](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#signature-verification-for-bots) and [the App token action](https://github.com/actions/create-github-app-token).
