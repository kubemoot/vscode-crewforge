# Contributing to CrewForge

How to contribute, report a problem, and reach the maintainers is documented once for all
Kubemoot repositories, in the
[Community section of kubemoot.org](https://kubemoot.org/docs/community/). To build, test,
and run CrewForge from source, see the Develop section of the [README](README.md).

## Sign your commits

Every commit carries a Developer Certificate of Origin sign-off. Add it with
`git commit -s`; the DCO check on each pull request enforces it. There is no CLA.

## Integration tests

`npm run test:integration` packages the extension and runs it in a real VS Code against a
local fake Kubernetes API server. It needs no cluster. On a machine without a display, run
it as `xvfb-run -a npm run test:integration`.

## Documentation screenshots

The screenshots on kubemoot.org are generated, not drawn, so they can be regenerated
after a UI change:

```bash
npm run screenshots -- --out <directory>
```

The script (`scripts/screenshots/`) scaffolds a crew with `kmctl create --chart` into a
throwaway workspace, fakes a cluster that has it deployed with a fitness run in progress,
starts a real VS Code with the extension against a local fake API server, and captures
each view through VS Code's debugging port at a fixed 1400 x 900 size in the light theme.
No real cluster, host name, or person appears in a picture. It needs a `kmctl` whose
`create` takes `--chart` (see the kmctl releases), `helm`, `git`, and a display (WSLg, or
`xvfb-run -a`). If `pngquant` is installed,
it shrinks each file.

To change what a screenshot shows, edit `scripts/screenshots/suite.ts` (the steps) or
`scripts/screenshots/run.ts` (the fake cluster, workspace, and settings). Copy the
resulting PNG files into the `kubemoot-docs` repository, in
`content/en/docs/ecosystem/crewforge/`. The README's `docs/screenshots/views.png` is a copy
of the `views.png` the script produces.

## Signed releases

Every GitHub Release carries, next to `crewforge-<version>.vsix`:

- `crewforge-<version>.vsix.sigstore.json`, a keyless Sigstore signature: the **sign**
  job of Publish Release signs with a short-lived certificate Sigstore issues to the
  workflow's GitHub OIDC identity, so no signing key is stored anywhere, and the
  signature is recorded in Sigstore's public transparency log.
- `crewforge-<version>.intoto.jsonl`, the SLSA build provenance from `actions/attest`
  (also listed under the repository's attestations), naming the workflow run and commit
  that built the `.vsix`.

The release job creates the release with all three files in one call, since GitHub's
immutable releases lock the assets once a release is published, and the publish job
sends the registries that same `.vsix`. A dry run signs and verifies its `.vsix` too;
only a real release attests. To verify a download from the GitHub Release with
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/) or the GitHub CLI:

```bash
cosign verify-blob crewforge-<version>.vsix \
  --bundle crewforge-<version>.vsix.sigstore.json \
  --certificate-identity https://github.com/kubemoot/vscode-crewforge/.github/workflows/publish-release.yaml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify crewforge-<version>.vsix --repo kubemoot/vscode-crewforge \
  --signer-workflow kubemoot/vscode-crewforge/.github/workflows/publish-release.yaml
```

## Publishing to the VS Code Marketplace and Open VSX

This section is for maintainers. **Publish Release** publishes to both registries only
when it is not a dry run and `publish_marketplaces` is checked. It publishes the `.vsix`
the GitHub Release carries, with the `@vscode/vsce` and `ovsx` versions locked in
`package-lock.json`. With `pre_release`, that `.vsix` is packaged as a pre-release and
both registries list it as one. The workflow checks the credentials below before it
tags anything and stops if one is missing; a dry run with `publish_marketplaces` checks
them without publishing. `--skip-duplicate` makes a re-run of the publish job safe after
one registry already took the version.

One-time setup, done once by a maintainer from their own browser and terminal. A token
is never pasted into a chat, an issue, or a file.

### The `marketplace` environment

The publish job runs in the GitHub environment `marketplace`. Restrict it to `main` and
require a maintainer's approval, so no run reaches the registry credentials unseen. The
kubemoot organization declares this environment, and the Entra app below, in its
infrastructure code; without that, create the environment with:

```bash
me=$(gh api user --jq .id)
gh api -X PUT repos/kubemoot/vscode-crewforge/environments/marketplace --input - <<JSON
{"reviewers": [{"type": "User", "id": ${me}}],
 "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api -X POST repos/kubemoot/vscode-crewforge/environments/marketplace/deployment-branch-policies \
  -f name=main -f type=branch
```

### VS Code Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with the Microsoft account
   that will own the publisher, and choose **Create publisher**: ID `kubemoot` (it
   cannot change later; the extension ID is `kubemoot.crewforge`), name `Kubemoot`.
2. Give the workflow a credential, one of:
   - **Microsoft Entra (lasting).** In a Microsoft Entra directory you own, register an
     app (no Azure subscription is needed for an app registration; a personal Microsoft
     account gets its own directory through the Azure free sign-up). Under **Federated
     credentials**, add one with issuer `https://token.actions.githubusercontent.com`,
     audience `api://AzureADTokenExchange`, and the subject GitHub actually issues. This
     repository uses GitHub's immutable subject, which names the org and repository by
     numeric ID as well as by name:
     `repo:kubemoot@<org id>/vscode-crewforge@<repo id>:environment:marketplace`
     (`gh api repos/kubemoot/vscode-crewforge/actions/oidc/customization/sub` shows the
     prefix). The portal's **GitHub Actions** template builds the name-only subject,
     which does not match. Set the app's IDs as secrets:

     ```bash
     gh secret set AZURE_CLIENT_ID -R kubemoot/vscode-crewforge   # the app's client ID
     gh secret set AZURE_TENANT_ID -R kubemoot/vscode-crewforge   # the directory's tenant ID
     ```

     The first publishing run prints the identity's Marketplace member ID in **Show the
     identity's Marketplace member ID**, then fails at the publish. On the publisher's
     **Members** page, add that ID with the **Creator** role (publishing a new extension
     needs it; once the extension exists, **Contributor** is enough for updates), and
     re-run the job.
   - **Personal access token (until 2026-12-01).** Azure DevOps retires global personal
     access tokens on 2026-12-01, and the Marketplace accepts only a global one, so this
     works until then. In any Azure DevOps organization, create a token with
     **Organization: All accessible organizations**, **Scopes: Custom defined,
     Marketplace: Manage** (nothing else), and the shortest expiry that covers the
     release. Then:

     ```bash
     gh secret set VSCE_PAT -R kubemoot/vscode-crewforge
     ```

     When both are set, the workflow uses Entra.
3. Domain verification comes later: the Marketplace verifies a publisher's domain
   (`kubemoot.org`, by a DNS TXT record from the publisher's **Details** page) only once
   the publisher has had an extension listed for six months.

### Open VSX

1. Create an Eclipse Foundation account at <https://accounts.eclipse.org>, with the
   GitHub user name of the maintainer who publishes.
2. Sign in at <https://open-vsx.org> with that GitHub account, link the Eclipse account
   in **Settings**, and sign the **Open VSX Publisher Agreement** there.
3. In **Settings, Access Tokens**, create a token named for this workflow. From your own
   terminal, in this repository (paste the token at the silent prompt, then Enter):

   ```bash
   read -rs OVSX_PAT && export OVSX_PAT
   npx --no-install ovsx create-namespace kubemoot
   printf %s "$OVSX_PAT" | gh secret set OVSX_PAT -R kubemoot/vscode-crewforge
   unset OVSX_PAT
   ```

4. After the first run with `publish_marketplaces` has published a version (Open
   VSX requires one before a trusted publisher can be registered), switch to
   [Trusted Publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing),
   so no long-lived Open VSX token is stored: on open-vsx.org, **Settings, Trusted
   Publishers**, add organization `kubemoot`, repository `vscode-crewforge`, workflow
   `publish-release.yaml`, environment `marketplace`. Then delete the token and its
   secret (`gh secret delete OVSX_PAT -R kubemoot/vscode-crewforge`); the workflow uses
   Trusted Publishing whenever `OVSX_PAT` is absent.
5. Optionally, ask for the namespace to be verified (the extension then shows as from a
   verified publisher) by opening an issue in
   [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues) under
   the namespace access process.

### Versions and the pre-release channel

Both registries accept only `major.minor.patch` versions, and a pre-release and a
release never share a version. The release tags are already of that form, and every
release has a new version, so either channel works. While CrewForge is 0.x, its
`preview` flag shows a Preview badge on the listing.
