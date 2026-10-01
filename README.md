# CrewForge for VS Code

CrewForge is a VS Code extension for building and running [Kubemoot](https://kubemoot.org)
crews. Create a crew, edit it as code, lint it, deploy it to a namespace, ask it questions,
and run its fitness scenarios, all from the editor.

It works through your kubeconfig, the same way `kmctl` does: any cluster your `kubectl` can
reach works, no crew needs a public address, and no extra credential is involved.

![The Kubemoot view in VS Code: Deployed Crews lists the helpdesk crew's groups with its Models open, including the shared ollama ModelProvider, and Crew Sources lists the helpdesk chart in the workspace, deployed and in sync, with the same groups.](docs/screenshots/views.png)

## Install

1. Download `crewforge-<version>.vsix` from the repository's
   [GitHub Releases](https://github.com/kubemoot/vscode-crewforge/releases).
2. Install it: run **Extensions: Install from VSIX...** from the Command Palette, or
   `code --install-extension crewforge-<version>.vsix`. In a WSL or other remote window,
   install into the remote.

Listings in the Visual Studio Marketplace and Open VSX are coming.

You need VS Code 1.95 or later and a kubeconfig with access to a cluster that runs the
Kubemoot operator. Developing a crew also needs `helm` (deploy and lint), `kubectl`
(bundles of plain manifests), and [`kmctl`](https://github.com/kubemoot/kmctl/releases)
0.12.0 or later (create). CrewForge reads the kubeconfig from the `crewforge.kubeconfig`
setting, else `KUBECONFIG`, else `~/.kube/config`.

## A 60-second tour

1. Click the Kubemoot mark (the round table) in the activity bar. **Deployed Crews** lists
   the crews your kubeconfig can read, grouped by namespace. **Crew Sources** lists the
   crew charts and bundles in your workspace.
2. Choose **Ask** on a deployed crew. A chat opens; type a question and press Enter. Each
   agent reports as it works, then the crew's answer follows, with how long it took.
3. Expand a crew to see every part of it: Agents, Prompts, Skills, Models, RAG Sources,
   MCP Servers, Tools, Policies, Notifications, Fitness, and Deployment. Objects the crew
   shares with others, such as a cluster's ModelProvider, are marked *shared*. Click a
   crew, deployed or in your workspace, for its dashboard: **Overview**, **Source**,
   **Live**, and **Diff** tabs.
4. Right-click a folder in the Explorer and choose **New Kubemoot Crew Here** to scaffold
   a crew with `kmctl create --chart`.
5. Edit it, or use **Add <Kind>...** on a group in Crew Sources to add an Agent, a
   PromptModule, a Model, a RAG source, an MCP server, and more. The status bar says where
   it stands against its deployment: not deployed, in sync, or changed. **Lint** checks
   the chart against your cluster's schemas.
6. Choose **Deploy to Namespace...** to run it with Helm, then **Ask**, **Run Fitness**,
   and **Redeploy** after each edit.

The status bar always shows the context CrewForge is connected to. If the cluster cannot
be reached, CrewForge says so in plain words and offers **Select Kubernetes Context**.

CrewForge writes only Kubemoot resources and Helm releases of them. It never deletes a
namespace or any other kind of object; the operator owns cleanup.

## Documentation

The full documentation is on kubemoot.org:

- [CrewForge overview](https://kubemoot.org/docs/ecosystem/crewforge/)
- [Install and connect](https://kubemoot.org/docs/ecosystem/crewforge/install-and-connect/)
- [Develop a crew in VS Code](https://kubemoot.org/docs/ecosystem/crewforge/develop-a-crew/),
  the whole loop step by step
- [Views and dashboards](https://kubemoot.org/docs/ecosystem/crewforge/views-and-dashboards/),
  every view, tab, and action, and what each changes
- [Fitness from the editor](https://kubemoot.org/docs/ecosystem/crewforge/fitness/)
- [Settings and permissions](https://kubemoot.org/docs/ecosystem/crewforge/settings-and-permissions/)
- [Troubleshooting](https://kubemoot.org/docs/ecosystem/crewforge/troubleshooting/)

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
