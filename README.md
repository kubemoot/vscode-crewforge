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
   **Deployed Crews** view lists every crew your kubeconfig can read, grouped by namespace,
   with a green mark on the ready ones. **Crew Sources** below it lists the crew charts and
   bundles in your workspace.
3. Click a crew. A chat opens beside the view. Type a question and press Enter. The send
   button shows once there is text and the crew can take a question; while the crew
   answers, Stop takes its place. When the crew is not ready, in an error state, or out of
   reach, the reason shows above the input and sending waits.

CrewForge reads the kubeconfig from the `crewforge.kubeconfig` setting, else every file
in `KUBECONFIG` (merged as kubectl merges them), else `~/.kube/config`. To use a
different file, run **CrewForge: Select Kubeconfig File** from the Command Palette; to
change cluster, **CrewForge: Select Kubernetes Context** (the server icon on the view).

While a turn runs, each agent has a card: starting up, queued, analyzing (with the GPU it
landed on), then what it found, in plain words ("agrees", "has a concern", "objects",
"failed"), or "stood aside". A card turns red when its agent failed or could not run. When
the turn ends, anything that went wrong stays under the answer or notice: an agent that
failed, could not run, or had not finished, an error from the crew's discussion gateway, a
turn that timed out, or one you stopped. The crew's answer follows, rendered as Markdown, with
its time and how long the crew took, for example `03:36 PM` and `42 s`. Ask again in the same
panel and the crew keeps the conversation's context. The square button stops a turn.

Messages use the panel's full width, so the chat stays readable in a narrow side bar; there
the conversations list opens over the chat from the menu button. Under each message, a row
of buttons appears on hover or keyboard focus: for your question **Copy**, **Ask again**
(sends it as a new turn), and **Edit and resend** (puts it back in the input); for the
crew's answer **Copy** (its Markdown) and **Ask the question again**.

To ask about code, select it in an editor and choose **Ask a Crew about the Selection** from the
editor's context menu. Pick a crew; its chat opens with the selection in the input, fenced
and labelled with its file and language, ready for your question.

**CrewForge: Continue a Conversation** reopens any saved conversation. A conversation is
named after its first question; the buttons in a chat's header **Rename** it, **Delete**
it from this computer (after asking; the crew is not changed), and copy or save the whole
conversation as Markdown. **CrewForge: Open
Conversations Folder** shows where they are kept.

## Develop a crew

CrewForge's inner loop runs from the editor, without GitOps: create a crew, understand
what it declares, edit it, lint it, deploy it to a namespace with Helm, test it, debug
a turn, change it, redeploy, and test again. It never commits or pushes; Flux rollouts
stay the outer loop.

1. **Create.** Right-click a folder in the Explorer and choose **New Kubemoot Crew Here**
   (offered only on folders that are not already inside a crew source), or click
   the + on Crew Sources and pick the folder (the active file's folder comes first). Give
   the crew a name, a number of specialists, and a model family; `kmctl create --chart`
   writes the chart into a subfolder named after the crew. CrewForge selects the new crew
   in Crew Sources, opens `templates/crew.yaml` beside its README, and offers **Deploy to
   Namespace...**.
2. **Understand.** Expand the crew in **Crew Sources**. It lists what the chart declares,
   read from its render: the Crew, its **Agents** (role and capabilities), the
   **PromptModules** they compose (ADL or prose, in composition order), **Skills**, **MCP
   Servers**, and **Fitness Scenarios** (from `fitness/`). Click any of them to open its
   file at that object. Its deployments follow. The view follows the file system: adding,
   deleting, or renaming a crew folder or file updates it by itself (**Refresh** stays on the
   view's title bar as a fallback). When the chart does not render, the error is an item;
   when it names a file and line, clicking it opens them. From the other side, right-click
   any file or folder of a crew source in the Explorer and choose **View in CrewForge**: it
   selects the matching item in Crew Sources (the object a manifest declares, or the crew
   for a folder) and opens the crew's dashboard.
3. **Edit.** While a file of the crew is open, the status bar names the crew and where it
   stands: *not deployed*, *deployed in crew-x, in sync*, or *deployed in crew-x, changed* (the same drift
   check as Compare with Live). Click it for the next steps in that state.
4. **Lint.** **Lint** (on the source's menu, and in the status bar menu) runs `helm
   lint` on the chart, renders it, and checks every Kubemoot object against the schemas the
   cluster serves. Findings land in the Problems panel on the file and line they concern,
   such as a field the CRD does not define. Saving a file of the crew lints it again once
   the saves settle. A chart needs `helm` on your PATH; without it Lint says where to
   get it.
5. **Deploy.** **Deploy to Namespace...** (the rocket on a source) asks for a namespace on
   the current context, offering the last one you picked for that source, else
   `crew-<name>`, and runs `helm upgrade --install` there. A bundle deploys with `kubectl
   apply --server-side` instead. A crew already deployed can go to another namespace too;
   each deployment shows under its source. CrewForge remembers the namespace for
   **Redeploy**, which is one click. CrewForge then follows the crew until the operator has seen
   the deploy and the Crew and all its agents report ready (cancel the progress
   notification to stop following), and selects the crew in the Deployed Crews view. A crew or agent
   that fails says so.
6. **Test.** **Ask** opens the chat with the deployed crew; **Run Fitness** runs one of its
   fitness definitions against it. Both are on the source, in the status bar menu, and on
   the live crew in the Deployed Crews view.
7. **Debug.** Under each crew answer, *N agents took part* lists each agent's last word in
   the turn. When the crew's source is open in the workspace, an agent's name links to where
   it is defined: its Agent, then the PromptModules it composes. With `crewforge.dashboardUrl`
   set, **Open this turn in the Kubemoot dashboard** appears among the answer's buttons; it
  opens the dashboard's Discussions page with the turn's thread, namespace, and crew in the
  address.
8. **Change and redeploy.** Saving a file of a deployed crew marks it *changed since
   deploy* in the status bar and on its source; the lint and drift check that follow have
   the last word. **Redeploy** (the sync icon on a changed source, or the status bar)
   upgrades the release in the namespace you last deployed to and waits for the agents again.
9. **Retest.** The redeploy's notification offers **Re-ask last question** (in the open
   chat, else the newest saved conversation with the crew) and **Rerun fitness** (the
   definition you ran last, without asking).

To change where Redeploy goes, choose **Change the Namespace Redeploy Uses...** from the
status bar menu, or deploy again with **Deploy to Namespace...**. **Deploy with a
Channel...** picks the channel too (Helm, bundle, or Flux). A namespace where Flux or
a bundle already owns the crew is refused, since two channels must not fight over the same
objects.

## Explore a live crew

Expand a crew in the **Deployed Crews** view to see what it is made of, read from the cluster:

- **Agents**, each with its discussion role, the capabilities it asks the scheduler for
  (never a model name), and whether it is ready.
- **PromptModules** its agents compose, in composition order, each marked ADL or prose,
  with the agents that use it. A module an agent names but the cluster lacks shows as
  missing.
- **Skills**, in order.
- **MCP Servers** its agents or skills name or its release installed, and the **Tools**
  its agents may call, when it has any.
- **Deployment**: the channel (Helm, Flux, or a kubectl bundle), the Helm chart and
  version, the Helm release, the Flux HelmRelease or Kustomization, and what a CrewForge
  deploy recorded (source, revision, who, when).

The line under a crew shows its phase, agent count, and chart version, and whether its
source is open in the workspace (*source open* or *no local source*); hover it for its
namespace, labels, creation time, archetype, and status conditions. Click any leaf for
its live YAML in a read-only editor; **Show YAML** and **Show Bundle YAML** (the
Crew with its Agents, PromptModules, and Skills in one document) are on a crew's menu.

A crew's menu also carries the lifecycle commands of Crew Sources: **Redeploy**, **Deploy a Git Revision**, **Run Fitness**, **Follow Flux Rollout** (Flux), and
**Undeploy**. CrewForge finds the crew's source among the workspace's crew
charts and bundles: the one the Crew names, else the one that renders a crew of its
name. When no source is open it says so. Undeploy works without a source: it
confirms with the crew's name, then uninstalls a Helm crew's release, or deletes the
crew's Crew, Agents, Skills, and the PromptModules only it uses. A Flux-managed crew
changes only through git. **Create Crew** is on the Deployed Crews view's title bar too.


The **Crew Sources** view finds crew Helm charts and plain-manifest bundles in the
workspace and, under each, every namespace its crew is deployed to. Each source reads as
its crew's name, with where it stands on its line: *deployed in crew-x, changed*,
*deployed in crew-x, in sync*, or *not deployed*.

- **Create Crew** (the + on the view, or **New Kubemoot Crew Here** on a folder in the Explorer)
  scaffolds a working crew as a Helm chart with `kmctl create --chart`, in the folder you
  pick. It needs [kmctl](https://github.com/kubemoot/kmctl/releases) 0.12.0 or later on
  your PATH, and checks the version before asking anything.
- Each source expands to what it declares (see [Develop a crew](#develop-a-crew)), then to
  its deployments. Its menu has the actions in the table below.
- **Deploy with a Channel...** (on a source's menu) deploys into any namespace
  you name, through Helm (`helm upgrade --install`), as a bundle (`kubectl apply
  --server-side`), or, for a crew Flux manages, by commit and push. A crew keeps the
  channel it came through, and CrewForge asks before replacing a crew from another source
  or another developer. It records the source, owner, revision, and channel on the Crew.
- Each deployment shows its **drift**: the Kubemoot objects whose spec differs from the
  source, missing ones, and extra ones. Click one for a live-versus-source diff. Flux
  deployments render with their HelmRelease values and show the release state.
- The diff is normalized so that only what a person wrote can differ: both sides leave out
  `status`, the server's bookkeeping (managedFields, resourceVersion, uid, generation,
  creationTimestamp, finalizers), the annotations Helm, kubectl, and CrewForge add
  (`meta.helm.sh/*`, `kubectl.kubernetes.io/*`, `crewforge.kubemoot.ai/*`), and the labels
  releases stamp (`helm.toolkit.fluxcd.io/*`, `helm.sh/chart`, `app.kubernetes.io/version`,
  `kubemoot.ai/crew-version`), and every map's keys are sorted. When the chart version of
  the source differs from the deployed one, a banner on top of both sides and the diff's
  title say so, for example "source 0.2.2, deployed 0.46.0-rc.0".
- To see one side alone, a resource's menu (and the diff editor's title bar) has **Show
  Source YAML** (the object as the source renders it, read-only, with a link that opens
  its source file at the object for editing), **Show Live YAML** (normalized the same
  way), and **Show Live YAML (raw)** (everything the API server holds, status and all).
- A deployment's menu has **Redeploy** (from its source; a bundle applies only what differs),
  **Deploy a Git Revision** (any commit that touched the source, to roll back or forward),
  **Run Fitness**, **Follow Flux Rollout** (Flux), and **Undeploy**.
- Its **Fitness** node lists its fitness runs; clicking the node or a run opens the
  [Fitness dashboard](#dashboards). **Run Fitness** is hidden, and refuses, while a run of
  that crew is in progress; CrewForge warns before starting one while another crew's run
  is in progress, since crews share the GPUs.
- **Fitness Scenarios** under a source lists the scenarios in its fitness folder: the
  scripts of each CrewFitnessSuite, each CrewFitness, and loose `.adl` (ADL) and `.md`
  (prose) scripts. **Add Fitness Scenario** (on the Fitness node or the Fitness Scenarios
  section) asks ADL or prose and a name, and writes the scenario in the folder's layout: a
  one-scenario CrewFitnessSuite YAML shaped like the kmctl starter suite, or a loose
  script when the folder holds those. On a scenario, **Rename Fitness Scenario**, **Delete
  Fitness Scenario** (after a confirmation: a script file to the trash, or its script out
  of a suite that keeps others), and **Run This Scenario Only** (the play icon: one
  iteration against the deployment Redeploy goes to, as a suite of that one script or a CrewFitness).
  These change local files only, except Run, which starts a run.
- In an open crew manifest, a CodeLens above the Crew offers **Ask in** each namespace it
  is deployed to, and every other Kubemoot object shows its drift state in each
  deployment where it was compared; click one for the diff.
- With the Red Hat YAML extension installed, Kubemoot manifests are checked against the
  cluster's own schema, including fields the CRD does not define.

### What each action does

| Action | When to use it | What it changes |
|---|---|---|
| **Deploy to Namespace...** | Deploy a crew, here or to one more namespace | `helm upgrade --install` (a bundle: `kubectl apply --server-side`) into the namespace you pick (the last one, else `crew-<name>`, is offered), which Redeploy then uses; records the source on the Crew and waits until it is ready |
| **Redeploy** (on a source) | After editing a deployed crew | The same release in the namespace you last deployed to, upgraded from the source; waits for the agents again |
| **Deploy with a Channel...** | Pick the channel too, such as Flux | A Helm release or bundle in the namespace you name; for Flux, nothing (it tells you to commit and push) |
| **Redeploy** (on a deployment or a live crew) | A deployment in the list is behind its source | That deployment, through the channel it came by; a bundle applies only the objects that differ |
| **Apply Only This Object (kubectl apply)** | One changed or missing object of a bundle | That one Kubemoot object |
| **Deploy a Git Revision (Roll Back or Forward)** | Go back to, or forward to, a committed version | The deployment, rendered from that commit |
| **Follow Flux Rollout (GitOps channel)** | A crew Flux manages, after you push | Nothing; it follows the HelmRelease until it settles |
| **Undeploy** | Take a crew out of a namespace | `helm uninstall` of its release, or deletes the Kubemoot objects the bundle renders; the operator's finalizers clean up the rest. The namespace stays unless the crew manages it |
| **Delete Source... (move folder to trash)** | Throw away a crew you no longer want | The source folder moves to the trash after a confirmation that names it; if the crew is deployed, it offers to undeploy first. A workspace folder, or a folder holding another crew source, is refused. The cluster does not change otherwise |
| **Rename...** | Give a crew a new name | The chart name, the Crew, every name built on the crew's (agents, prompt modules, policy, fitness suites) and the references to them, and the folder when it carries the crew's name; other keys, prompt text, and `.tpl` helpers stay as they are. It waits until the crew's files are saved. A deployed crew keeps the old name: redeploy to deploy the new one, and undeploy the old one (offered first) |
| **Compare Source with Live (normalized diff)** | See how a deployed object differs from the source | Nothing |
| **Show Source YAML** / **Show Live YAML** / **Show Live YAML (raw)** | Look at one side alone | Nothing |
| **Lint (helm lint and schema check)** | Before deploying, or any time | Nothing; findings go to the Problems panel |
| **Ask** / **Run Fitness** | Try the deployed crew | Run Fitness creates a fitness run (a Kubemoot object) in the crew's namespace |
| **Run This Scenario Only** | Try one scenario after changing a prompt | One fitness run of one scenario, one iteration, marked so its dashboard offers Stop |
| **Add / Rename / Delete Fitness Scenario** | Grow or tidy the crew's fitness scenarios | Local files in the fitness folder only; Delete moves a file to the trash after a confirmation |
| **Pause** / **Resume** / **Stop** (Fitness dashboard) | Hold or end a running suite | Sets `spec.suspend` (pause between iterations; the running one finishes) or `spec.cancel` (the suite becomes Cancelled, results so far kept) on the suite; Stop on a single-scenario CrewFitness deletes it. Shown only when the operator's CRD has those fields |
| **Open Dashboard** / **Open Crews Overview** / **Open Fitness Dashboard** | See a crew, every crew, or a crew's fitness at a glance | Nothing; read-only |

CrewForge applies only Kubemoot objects and Helm releases of them. It never deletes a
namespace or any other kind of object; the operator owns cleanup.

`helm`, `kubectl`, and `git` come from your PATH; CrewForge runs them with its kubeconfig
and context. Lint reads the Kubemoot schemas from the cluster's OpenAPI; without a
reachable cluster it lints with `helm lint` and the render alone, and says the schema
check was skipped.

## Dashboards

Dashboards open as editor tabs and read again every few seconds while visible (the fitness
dashboard, while a run is going). They are read-only pages: every value is escaped, the
page runs one script under a strict content security policy, and it can only ask the
extension to run one of its own buttons.

- **Crew dashboard.** Click a crew in Crew Sources or Deployed Crews. It shows the crew's
  name and description; the source's path, chart name, chart version, and app version; where
  it is deployed (namespace and context, channel, Helm release, deployed chart and app
  version, first deployed and last redeploy from `helm status`, and what a CrewForge
  deploy recorded); its agents counted by role, with the capabilities each declares and
  whether each is ready (the Models the source declares follow); the Crew's phase,
  message, and status conditions; CrewForge's own conversations with it on this computer
  (conversations, turns, the turn answering now in an open chat, and the newest problems
  saved with a turn); and, from the Kubemoot dashboard, the number of discussion threads and
  agent failures. A banner says when the source's chart version differs from the deployed
  one. Its buttons are **Deploy to Namespace...**, **Redeploy**, **Undeploy**, **Ask**, **Run
  Fitness**, **Fitness Runs**, **Lint**, **Show YAML**, and **Refresh**; a button that does
  not apply is disabled, with the reason as its tooltip.
- **Crews Overview.** The dashboard icon on Deployed Crews, **CrewForge: Open Crews
  Overview**, or the first item of Deployed Crews. A table of every deployed crew the
  kubeconfig can see: name, namespace, phase and readiness, agents ready out of total,
  chart version, channel (helm, bundle, flux), last deploy time, the turn answering now,
  recent problems, and whether a local source is open for it. Click a crew for its
  dashboard. Its header says what CrewForge is connected to.
- **Fitness dashboard.** Click a Fitness node or a run. The crew's runs, newest first, and
  the selected run: phase (Pausing and Stopping until the operator settles), iterations done
  out of total, passed, failed, and errored, start, end, and duration, and the results
  workbook. For a suite, each scenario's iterations and outcomes with their mean duration and
  its judge score, and where the deferred judge stands; for a single run, its assertions.
  **Pause**, **Resume**, and **Stop** appear when the operator's CRD has `spec.suspend`
  and `spec.cancel`; a single-scenario run started from CrewForge can be stopped. **Open
  XLSX** downloads the workbook from the Kubemoot dashboard when `crewforge.dashboardUrl`
  is set.
- **Connection.** The status bar always shows the context CrewForge uses (`$(plug)
  <context>`, with the kubeconfig file's name when it is not the default); click it to
  select another context. Its tooltip, the first item of Deployed Crews, the Crews Overview
  header, and **CrewForge: Show Connection Info** (with Copy for a bug report) give
  CrewForge's version, the Kubemoot operator's version (its image tag and Helm chart version,
  found by the operator's label, or in the namespace of the Helm release that installed the
  Crew CRD), the Kubernetes server version, and the context and server URL. When the
  cluster cannot be reached, they say so.

Where the numbers come from: the Kubernetes API (Crews, Agents, fitness runs and their
iterations, the operator Deployment, `/version`, and the CRD schema), `helm status` for
release times, CrewForge's saved conversations on this computer, and, read-only through the
Kubernetes service proxy, the Kubemoot dashboard's API: `/api/nats/history` for a crew's
discussion threads and agent failures, and a suite's `/scores` and `/iterations`. The
dashboard's Service is found by its `app.kubernetes.io/name=kubemoot-dashboard` label, or
named in `crewforge.dashboardService`. Without it, those parts say they are not available.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `crewforge.kubeconfig` | empty | Path to a kubeconfig. Empty uses `KUBECONFIG`, then `~/.kube/config`. |
| `crewforge.context` | empty | Context to use. Empty uses the kubeconfig's current context. |
| `crewforge.namespaces` | `[]` | Show crews only in these namespaces. Set it when your account may read only some namespaces. |
| `crewforge.streamTimeoutSeconds` | `600` | Longest a single turn may stream. |
| `crewforge.dashboardService` | empty | The Kubemoot dashboard's Service as `namespace/name:port`, read through the service proxy for thread counts, discussion failures, fitness scores, and archived iterations. Empty finds it by its label. |
| `crewforge.dashboardUrl` | empty | The Kubemoot dashboard, opened from **Powered by Kubemoot** in a chat, and from **Open this turn in the Kubemoot dashboard** under an answer (shown only when set). Empty makes Powered by Kubemoot open this setting. |

## What your account needs

- `list` on `crews.kubemoot.ai`, cluster-wide or in each namespace of `crewforge.namespaces`.
- `get` and `create` on `services/proxy` in the crew's namespace, to ask and to stream;
  `get` on `endpoints` there, to tell whether its discussion gateway is running.
- For the dashboards (each optional; a part it cannot read says so): `get` on
  `services/proxy` of the Kubemoot dashboard, `list` on `services` to find it, `list` on
  `deployments` (or `get` on the Crew CRD) to find the operator's version, and `patch` on
  `crewfitnesssuites` (`delete` on `crewfitnesses`) for Pause, Resume, and Stop.
- To explore a crew: `get` and `list` on `agents`, `promptmodules`, `skills`,
  `mcpservers`, and `crewschedulingpolicies`; a kind it may not read shows as a warning
  under the crew. `delete` on those kinds and `crews` to remove a crew whose source is not
  open.
- To develop crews: `get` and `list` on the Kubemoot kinds a source renders, `patch` on
  `crews` (its annotations), `create` on `crewfitnesses` and `crewfitnesssuites`, and what
  `helm` or `kubectl` need to deploy. Reading `helmreleases.helm.toolkit.fluxcd.io` adds
  the Flux state; without it the tree says it cannot read it.

## Architecture boundaries

CrewForge's own writes to the API server are Kubemoot custom resources only: the
annotations on a Crew, the fitness runs it starts, and deleting a crew's Kubemoot objects
when you remove it. Deploying and removing otherwise run your own `helm` and `kubectl`;
removing a bundle deletes only the Kubemoot objects it renders.

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
