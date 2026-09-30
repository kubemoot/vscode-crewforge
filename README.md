# CrewForge for VS Code

Develop Kubemoot crews in the editor: create a crew, deploy it to any namespace, see
how each deployment differs from its source, roll it back or forward, run its fitness,
and talk to it. CrewForge lists every Crew your kubeconfig can read and opens a chat
with any of them: you watch each agent triage, analyze, and report, then read the
crew's answer. Conversations are saved, so you can continue one later or export it as
Markdown.

Everything goes through your kubeconfig. The chat reaches a crew's discussion gateway
through the Kubernetes API server's service proxy, the same route `kmctl` uses, so no
crew needs a public address and no extra credential is involved.

## Use it

1. Download `crewforge-<version>.vsix` from the repository's
   [GitHub Releases](https://github.com/kubemoot/vscode-crewforge/releases) and install it:
   in VS Code, **Extensions: Install from VSIX...**, or
   `code --install-extension crewforge-<version>.vsix`.
2. Click the Kubemoot mark (the round table) in the activity bar on the left. The
   **Crews** view lists every crew your kubeconfig can read, grouped by namespace, with a
   green mark on the ready ones.
3. Click a crew. A chat opens beside the view. Type a question and press Enter.

CrewForge reads the kubeconfig from the `crewforge.kubeconfig` setting, else every file
in `KUBECONFIG` (merged as kubectl merges them), else `~/.kube/config`. To use a
different file, run **CrewForge: Select Kubeconfig File** from the Command Palette; to
change cluster, **CrewForge: Select Kubernetes Context** (the server icon on the view).

While a turn runs, each agent has a card: queued, analyzing (with the GPU it landed on),
then its finding or "stood aside". The crew's answer follows, rendered as Markdown. Ask
again in the same panel and the crew keeps the conversation's context. The square button
stops a turn.

**CrewForge: Continue a Conversation** reopens any saved conversation. The copy and
download buttons in a chat's header copy or save it as Markdown. **CrewForge: Open
Conversations Folder** shows where they are kept.

## Develop crews

The **Crew Sources** view finds crew Helm charts and plain-manifest bundles in the
workspace and, under each, every namespace its crew is deployed to.

- **Create Crew** (the + on the view) scaffolds a working crew as a Helm chart with
  `kmctl create --chart`. It needs [kmctl](https://github.com/kubemoot/kmctl/releases)
  0.12.0 or later on your PATH, and checks the version before asking anything.
- **Deploy Crew to a Namespace** (the upload icon on a source) deploys into any namespace
  you name, through Helm (`helm upgrade --install`), as a bundle (`kubectl apply
  --server-side`), or, for a crew Flux manages, by commit and push. A crew keeps the
  channel it came through, and CrewForge asks before replacing a crew from another source
  or another developer. It records the source, owner, revision, and channel on the Crew.
- Each deployment shows its **drift**: the Kubemoot objects whose spec differs from the
  source, missing ones, and extra ones. Click one for a live-versus-source diff. Flux
  deployments render with their HelmRelease values and show the release state.
- A deployment's menu has **Update Deployment from Source** (a bundle applies only what
  differs), **Deploy a Revision** (any commit that touched the source, to roll back or
  forward), **Run Fitness**, **Follow GitOps Rollout** (Flux), and **Remove Deployment**.
- Its **Fitness** node lists its fitness runs with their results; a run opens as a report.
  CrewForge warns before starting a run while another is in progress, since crews share
  the GPUs.
- In an open crew manifest, a CodeLens above the Crew offers **Ask in** each namespace it
  is deployed to, and every other Kubemoot object shows its drift state in each
  deployment where it was compared; click one for the diff.
- With the Red Hat YAML extension installed, Kubemoot manifests are checked against the
  cluster's own schema, including fields the CRD does not define.

`helm`, `kubectl`, and `git` come from your PATH; CrewForge runs them with its kubeconfig
and context.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `crewforge.kubeconfig` | empty | Path to a kubeconfig. Empty uses `KUBECONFIG`, then `~/.kube/config`. |
| `crewforge.context` | empty | Context to use. Empty uses the kubeconfig's current context. |
| `crewforge.namespaces` | `[]` | Show crews only in these namespaces. Set it when your account may read only some namespaces. |
| `crewforge.streamTimeoutSeconds` | `600` | Longest a single turn may stream. |
| `crewforge.dashboardUrl` | empty | The Kubemoot dashboard, opened from **Powered by Kubemoot** in a chat. Empty opens this setting. |

## What your account needs

- `list` on `crews.kubemoot.ai`, cluster-wide or in each namespace of `crewforge.namespaces`.
- `get` and `create` on `services/proxy` in the crew's namespace, to ask and to stream.
- To develop crews: `get` and `list` on the Kubemoot kinds a source renders, `patch` on
  `crews` (its annotations), `create` on `crewfitnesses` and `crewfitnesssuites`, and what
  `helm` or `kubectl` need to deploy. Reading `helmreleases.helm.toolkit.fluxcd.io` adds
  the Flux state; without it the tree says it cannot read it.

## Architecture boundaries

CrewForge's own writes to the API server are Kubemoot custom resources only: the
annotations on a Crew and the fitness runs it starts. Deploying and removing run your
own `helm` and `kubectl`.

- **CrewForge never** deletes namespaces, manages Jobs, touches non-CRD cluster resources,
  or implements cleanup or lifecycle logic.
- **The Kubemoot operator always** owns namespace lifecycle, garbage collection, Job
  management, and cascading cleanup.

## Develop

This section is for working on CrewForge itself; using it needs only the install above.

```bash
npm install
npm test            # vitest
npm run test:coverage  # the same, failing below the coverage thresholds CI enforces
npm run lint
npm run typecheck
npm run package     # builds dist/ and crewforge-<version>.vsix
```

With this repository open in VS Code, F5 starts a second VS Code window (the Extension
Development Host) running your local build.

The tests replay discussion streams recorded from a live crew (`test/fixtures/*.sse`).
The VS Code glue runs against a small fake of the `vscode` module (`test/vscodeFake.ts`)
and a local stand-in for the Kubernetes API (`test/fakeApiServer.ts`); the chat page's
script runs in jsdom against the page the panel generates.
To record a new one:

```bash
P=/api/v1/namespaces/<ns>/services/<crew>-discussion:80/proxy/api/v1/discussions/<crew>
ID=$(kubectl create --raw $P -f <(printf '{"message":"<question>","conversationId":""}') | jq -r .conversationId)
kubectl get --raw $P/$ID/stream > test/fixtures/<name>.sse
```

Versions come from git tags; `package.json` keeps `0.0.0` and the workflows set the
version when they package. Every push to `main` tags a release candidate
`vX.Y.Z-rc.N` (the conventional commits since the last release decide `X.Y.Z`) and
packages its `.vsix` as a workflow artifact, publishing nothing. A maintainer promotes a
tested candidate with the **Promote Release** workflow, which tags `vX.Y.Z` and writes
the GitHub Release with the `.vsix` attached.

## Community and contributing

Kubemoot is an independent open-source project under the Apache License 2.0. Contributing, support, governance, the code of conduct, security reporting, and releases are documented in one place: the [Community section of kubemoot.org](https://kubemoot.org/docs/community/). Ask questions and share ideas in [GitHub Discussions](https://github.com/orgs/kubemoot/discussions). Write to moot@kubemoot.org for anything else. Use security@kubemoot.org only to report a vulnerability, privately.

## License

Apache License 2.0. See [LICENSE](LICENSE).
