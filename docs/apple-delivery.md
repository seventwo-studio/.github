# Shared Apple delivery

SevenTwo uses GitHub Actions on the enterprise `seventwo-mac` runner group for Apple delivery. The shared workflow currently delivers internal-only TestFlight builds for iOS (including embedded Watch apps/extensions) and macOS. Public beta and App Store release must remain separate explicitly approved workflows; an internal-only build cannot be promoted to either.

## Organization setup

- Store `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_BASE64` as organization Actions secrets with **selected repository** access. Initially grant only GlassAware. Use the dedicated SevenTwo GitHub Apple Delivery App Store Connect team key with App Manager access. Never commit its private key. Transfer its bytes directly to secret storage without displaying them.
- Set organization variable `APPLE_TEAM_ID` for the same repositories. Apple team keys cover every app in the Apple team; selected GitHub repository access is therefore a trust decision, not an Apple-side app restriction.
- The existing persistent PR runner is not sufficient isolation for signing. Provision an isolated or reset-per-job release runner in `seventwo-mac`, with labels `self-hosted`, `macOS`, `ARM64`, `apple-release-isolated`. Restrict its runner-group workflow access to the reviewed shared workflow. A label alone does not establish isolation. Xcode 27+, signing/keychain readiness, and accepted upload toolchain must be verified on that runner.
- Only then set repository variable `APPLE_RELEASE_RUNNER_READY=true`. The workflow fails closed until both readiness and per-app delivery are enabled.

## App onboarding

1. Commit the generated Xcode project, shared Release schemes, bundle IDs and entitlements. Make signing support the organization's Apple team.
2. Create an `internal-testflight` environment in the **calling app repository**, restricted to `main`. Environment secrets with the same names override organization secrets: remove old duplicates only after confirming the replacement. An environment does not restrict other workflows from using an organization secret; protect repository workflow changes accordingly.
3. Add a small caller workflow using the shared workflow at a reviewed full commit SHA. Pass only the three named secrets, the project path, a JSON target list, and optionally a Swift package path. Do not use `secrets: inherit`.
4. Set `APPLE_INTERNAL_TESTFLIGHT_ENABLED=true` only after confirming signing, existing build numbers, export compliance, internal tester group distribution, and release runner readiness.
5. Dispatch once from `main`. Verify each platform's upload, Apple processing, group availability and device installation before relying on automatic delivery. Test notes are entered separately in App Store Connect.

The shared job serializes uploads within each app and uses `GITHUB_RUN_ID.GITHUB_RUN_ATTEMPT` for the build number. If a later build already exists, use a new dispatch rather than rerunning an older run. A failure can leave an earlier platform uploaded; inspect App Store Connect before retrying. Temporary key/archive cleanup is best effort and does not replace runner isolation.

## Credential cutover

Keep the old GitHub Actions and Expo EAS Submit keys until the new key is securely stored and a signed upload is verified. Then revoke those delivery keys and remove their obsolete secret references. The RevenueCat key belongs to the subscription integration and is outside delivery cutover. Confirm that all remaining delivery consumers have migrated before revocation; selecting only GlassAware initially does not migrate other apps.

## Status

This workflow is prepared infrastructure, not evidence of a signed upload. Runner isolation, organization credentials and the first app's successful TestFlight run are required activation gates.
