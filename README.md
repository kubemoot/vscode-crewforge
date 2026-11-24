<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kubemoot/vscode-crewforge/main/.github/assets/kubemoot-horizontal-white-text.png">
  <img src=".github/assets/kubemoot-horizontal-color.png" alt="Kubemoot" height="64">
</picture>

# CrewForge for Kubemoot

[![Latest release](https://img.shields.io/github/v/release/kubemoot/vscode-crewforge?sort=semver)](https://github.com/kubemoot/vscode-crewforge/releases/latest) [![Build status](https://github.com/kubemoot/vscode-crewforge/actions/workflows/ci.yaml/badge.svg?branch=main)](https://github.com/kubemoot/vscode-crewforge/actions/workflows/ci.yaml?query=branch%3Amain) [![License: Apache 2.0](https://img.shields.io/github/license/kubemoot/vscode-crewforge)](https://github.com/kubemoot/vscode-crewforge/blob/main/LICENSE) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/kubemoot/vscode-crewforge?label=openssf%20scorecard)](https://scorecard.dev/viewer/?uri=github.com/kubemoot/vscode-crewforge)

CrewForge is a VS Code extension for building and running [Kubemoot](https://kubemoot.org)
crews. Create a crew, edit it as code, lint it, deploy it to a namespace, ask it questions,
and run its fitness scenarios, all from the editor.

It works through your kubeconfig, the same way `kmctl` does: any cluster your `kubectl` can
reach works, no crew needs a public address, and no extra credential is involved.

![The Kubemoot view in VS Code: Deployed Crews lists the Help Desk crew (helpdesk in crew-helpdesk) with its agents, prompts, MCP servers, tools, and policies, and no Models of its own because the crew selects from the cluster's catalog, and Crew Sources lists its chart in the workspace, deployed and in sync, with the same groups.](docs/screenshots/views.png)

## Install

Install CrewForge from the VS Code Marketplace. For other editors (Open VSX) and the
offline `.vsix`, see [Install and connect](https://kubemoot.org/docs/ecosystem/crewforge/install-and-connect/).

You need VS Code 1.95 or later and a kubeconfig with access to a cluster that runs the
Kubemoot operator. Developing a crew also needs `helm` (deploy and lint), `kubectl`
(bundles of plain manifests), and a current [`kmctl`](https://github.com/kubemoot/kmctl/releases)
release (create). CrewForge reads the kubeconfig from the `crewforge.kubeconfig`
setting, else `KUBECONFIG`, else `~/.kube/config`. VS Code started from the Dock or
Start menu does not see a `KUBECONFIG` exported in a terminal, so point CrewForge at the
file with **CrewForge: Select Kubeconfig File**. If the path is a folder or missing,
CrewForge says so and names the command.

## A 60-second tour

1. Click the Kubemoot mark (the round table) in the activity bar. **Deployed Crews** lists
   the crews in your kubeconfig context's namespace (every namespace you can read when the
   context sets none or holds no crews; set `crewforge.namespaces`, or `*` there for all, alone or among other entries),
   one row each with its namespace; **Group by Namespace** in its title bar nests them
   instead. **Crew Sources** lists the crew charts
   and bundles in your workspace. Each crew shows by its display name, such as "Help
   Desk", with its Kubernetes name beside it.
2. Choose **Ask** on a deployed crew. A chat opens; type a question and press Enter. Each
   agent reports as it works, then the crew's answer follows, with how long it took.
   Under the answer, **The Moot** folds open to show what each agent said. The **...**
   menu in the chat header stops, pauses, resumes, renames, copies, saves, and deletes the
   conversation. With `crewforge.dashboardUrl` set, **Open in the Moot** under an answer
   shows the agents' deliberation in the Kubemoot dashboard.
3. Expand a crew to see every part of it: Agents, Prompts, Skills, Models, RAG Sources,
   MCP Servers, Tools, Policies, Notifications, Fitness, and Deployment. Objects the crew
   shares with others, such as a cluster's ModelServer, are marked *shared*. A crew that
   ships no Models selects from the cluster's model catalog, so its Models group lists the
   ModelServers that publish the catalog, each with the models it offers. Click a
   crew, deployed or in your workspace, for its dashboard: **Overview**, **Source**,
   **Live**, and **Diff** tabs. A crew's state reads the way Kubemoot reports it: `Ready` means
   the crew is reconciled as declared, while a reconciled crew whose models are away shows
   `WaitingForCapacity` and a warning, with the model catalog's reason ("waiting for an
   accelerator: ...") in its tooltip, its dashboard, and the chat input. A crew answers only
   when it is reconciled, in phase `Ready`, and its `CapacityAvailable` condition is True
   (on a Kubemoot without that condition, when it is reconciled and `Ready`). The dashboard's
   Live status also shows the last retention cleanup and any invalid retention.
4. Right-click a folder in the Explorer and choose **New Kubemoot Crew Here** to scaffold
   kmctl's starter crew with `kmctl create --chart`: a small, working crew that reads its
   own namespace, with 1 to 5 specialists. It ships no models and names no model server:
   its scheduling policy states what it needs, a model that can call tools, and the
   cluster's model catalog supplies the models. Name it in plain words; CrewForge suggests
   the Kubernetes name from it, and **Rename the Crew...** later changes either.
5. Edit it, or use **Add an Agent to the Crew...**, **Add a PromptModule (Instructions)...** and the other **Add** entries on a group in Crew Sources to add an Agent, a
   PromptModule, a RAG source, an MCP server, and more. **Edit Scheduling Needs...** on
   the Models group states what the crew needs for a phase, such as triage or mulling, in
   its CrewSchedulingPolicy: the abilities a model must have (tool-calling, reasoning,
   vision), the size it prefers (small, medium, or large, by parameter count), and how
   much it favors the model the cluster measured faster (`preferFaster`). It names no
   model; the cluster's model catalog supplies them. **Add Crew-Local Model
   (Advanced)...** is there for a crew that must bring its own: it writes the Model's
   parameters and abilities, and warns first that a crew with Models of its own stops
   using the catalog. The status bar says where the crew stands against its deployment:
   not deployed, in sync, or changed. **Lint** checks the chart against your cluster's
   schemas.
6. Choose **Deploy to Namespace...** to run it with Helm, then **Ask the Crew a Question**,
   **Run Fitness on the Crew**, and **Redeploy from Source** after each edit. A deployed crew carries its fitness scenarios: its
   Fitness group runs all of them, a batch you pick, or one.

### Edit a crew like code

A crew is a folder of YAML and ADL in git, and the editor treats it that way.

- **References.** In a crew's manifests, **Go to Definition** (F12) on a name in an
  Agent's `promptRefs` opens the PromptModule that declares it, and on a `crewRef` opens the
  Crew. **Find All References** from a PromptModule or Crew name lists every place that
  names it. Typing a name in `promptRefs` or after `crewRef:` offers the names the crew
  source declares. A name no object of the source declares is a warning in the Problems
  panel (the module may be installed in the cluster; check the spelling). This reads a
  chart the way it renders, and it works with no cluster.
- **Schema.** Red Hat YAML checks the manifests against the Kubemoot schema. `kmctl create`
  writes the workspace settings that point it at the schemas of a Kubemoot release, so a new
  crew opens with no Problems and no cluster. Connected, the cluster's own schema is also
  offered. Lint leaves the schema of a file the YAML extension checks to it, so a misspelled
  field is one problem, and still checks the Helm templates the YAML extension does not read.
- **ADL.** `.adl` files, and the `content` of a PromptModule and the `testContent` of a
  fitness scenario in YAML (and in a chart's templates), are highlighted as ADL: keywords,
  `DEFINE` scopes, constants, strings, comments, and `${agent.tools}` placeholders. The
  language also gives `#` line comments and bracket pairs.

### Tooltips

Every view, tree item, command, status bar item, page heading, table column, and button says
what it is or does in a tooltip: hover it, or tab to it in a page and the tooltip shows. The
terms use the Kubemoot dashboard's definitions, so the two say the same thing. The texts live
in `src/definitions.ts`, and a test fails when a command, tree item, or page control has none.

### Crew memory

Right-click a deployed crew and choose **Open the Crew Memory** to see what the crew has
learned, read-only. The facts are grouped by topic, each with its value, the role that
learned it, and when; hover the time to see the Moot it was learned in, when the export records one. Entries the
export left out (a fact that holds a credential is never exported as memory) show as counts
with the reason, never their text. **Refresh** reads again; **Export to Folder...** saves the
crew's OMPI export as `<crew>-memory-ompi.zip` in a folder you pick.

CrewForge reads the export from the Kubemoot operator's report service
(`GET /memory-export/{namespace}/{crew}`), through a port-forward to the operator's pod with
your kubeconfig's bearer token, so Kubernetes RBAC decides: you need `get` on the Crew. The
port-forward needs `get` on services, `list` on pods and `create` on `pods/portforward` in
the operator's namespace (`kubemoot`; set `crewforge.operatorNamespace` otherwise). A
kubeconfig that signs in with a client certificate uses the same `crewforge.tokenServiceAccount`
setting as the chat (see below), which mints a short-lived token for the memory view too. When the
kubeconfig has no token and no ServiceAccount is set, the memory page says so and offers **Choose a
ServiceAccount...** (it lists the ServiceAccounts in the crew's and the operator's namespace that you
may create tokens for, and keeps your pick in that setting) and **Open Setting**. An operator without
the endpoint is reported as too old.

The status bar always shows the context CrewForge is connected to. If the cluster cannot
be reached, CrewForge says so in plain words and offers **Select Kubernetes Context**.

CrewForge writes only Kubemoot resources and Helm releases of them. It never deletes a
namespace or any other kind of object; the operator owns cleanup.

### Asking a crew that knows who is asking

**Ask** reaches the crew's gateway over a port-forward to its pod, the way `kubectl
port-forward` does, and sends your kubeconfig's bearer token with each request. (The API server's
service proxy would strip it.) A crew that sets `spec.discussion.access` uses the token to know
who you are and keeps each conversation for the caller that started it; a crew that sets nothing
stays open and ignores the token. CrewForge never shows or logs the token. The port-forward needs
`get` on services, `list` on pods, and `create` on `pods/portforward` in the crew's namespace.

A kubeconfig that signs in with a client certificate (Talos, kind, k3s) has no bearer token. When
the crew requires one, set `crewforge.tokenServiceAccount` to `NAMESPACE/NAME` of a ServiceAccount
you may `create` on `serviceaccounts/token`. CrewForge then mints a ten-minute token for it, and
the crew sees that ServiceAccount as the caller; the Kubernetes audit log records who minted it.
Add `crewforge.tokenAudiences` when the crew lists `tokenAudiences`. A refusal says which of these
is missing: the crew requires a token (401), your identity may not use the crew (403), or the
conversation is not yours (404).

### Stopping, pausing, resuming and deleting a conversation

A chat with a crew that has answered at least once can act on the conversation on the crew
itself, through the same gateway connection and token as **Ask**. The **...** menu in the chat
header, and the one on each saved conversation in the list (on hover or focus), offer:

- **Stop**, **Pause** and **Resume** send the control to the conversation's running turns.
  Which of them a menu offers comes from the crew's own state read
  (`GET /api/v1/discussions/{crew}/{conversationId}/state`), read when the chat opens, every few
  seconds while a turn is queued, running or paused, and after each action, so a conversation
  running elsewhere (the dashboard, `kmctl`) offers **Stop** and **Pause** too. A question that
  still waits in the crew's queue offers **Cancel** alone and the chat says where it waits
  ("2 questions ahead"). A crew whose gateway cannot say leaves the menu to the turn in this chat.
- **Stop** says what happened, in the gateway's outcome: stopped, cancelled (the question was
  still queued), nothing to stop, or a warning that the crew did not confirm and the work may
  still be running. A question the crew has just taken answers 409 (stop again in a moment).
- A turn you stopped is saved as "Stopped by you. The crew did not answer this turn.", never as
  the crew's answer.
- **Delete from the crew** asks first, then removes the conversation from every place the crew
  keeps it (history, the agents' messages, workspace, scheduled reminders, learned memory facts)
  and shows what it removed in each store and what it cannot remove (logs and backups). A
  conversation that is still running offers **Stop and delete**. A delete that could not clear
  every store says which, and repeating it removes what is left. The copy on your computer stays;
  **Delete from this computer...** in the header menu removes that one.

The owner of a conversation acts without a reason. For another caller's conversation the gateway
needs the `kubemoot-conversation-controller` role and a reason: CrewForge asks for one (1 to 200
characters) when the gateway says it is needed and sends it as `Kubemoot-Access-Reason`, which the
crew records in its audit log. A refusal says which of these is missing: no token (401), an
identity that may not use the crew (403), a conversation that is not yours or not there (404),
nothing running or still running (409), or a store that failed (500).

### Live updates

An open chat listens to the crew's conversation events (`GET /api/v1/discussions/{crew}/events`,
server-sent events) through the same port-forward, once per crew. An event says only that a
conversation has something new, such as a late answer, a scheduled reminder that fired or a
follow-up; it carries no content. CrewForge marks that conversation in the list with a dot, reads
the conversation shown again from your saved copy, and says so under the chat. The mark clears when
you open the conversation or ask in it. A dropped connection opens again and resumes after the last
event received (`Last-Event-ID`), so no news is lost or repeated; CrewForge never subscribes to NATS.
A gateway that is older than the event stream is left alone. The crew sends events only for
conversations you own.

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

Before you push, run `npm run lint`, `npm run typecheck`, and `npm run test:coverage`.
SonarQube judges the code, and `npm run lint` runs the same TypeScript rules on `src/`
first: the `eslint-plugin-sonarjs` rules of the Sonar way profile, plus the
typescript-eslint and unicorn rules Sonar runs under its own keys (see
`eslint.config.mjs`). A finding there is very likely one SonarQube would report after
the push; the server stays the authority.

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
packages its `.vsix` as a workflow artifact, publishing nothing. A maintainer publishes a
tested candidate with the **Publish Release** workflow, which tags `vX.Y.Z` and writes
the GitHub Release with the `.vsix`, its Sigstore signature, and its build provenance
attached, and, only when asked, publishes the same `.vsix` to the VS Code Marketplace
and Open VSX (see [CONTRIBUTING](CONTRIBUTING.md)).

## Community and contributing

Kubemoot is an independent open-source project under the Apache License 2.0. Contributing, support, governance, the code of conduct, security reporting, and releases are documented in one place: the [Community section of kubemoot.org](https://kubemoot.org/docs/community/). Ask questions and share ideas in [GitHub Discussions](https://github.com/orgs/kubemoot/discussions). Write to moot@kubemoot.org for anything else. Use security@kubemoot.org only to report a vulnerability, privately.

## License

Apache License 2.0. See [LICENSE](LICENSE).
