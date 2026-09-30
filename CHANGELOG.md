# Changelog

Release notes for each version are on the repository's GitHub releases page,
generated from the conventional commits since the previous release.

## Unreleased

### Fixes

- The crew dashboard, the Crews Overview, and the fitness dashboard show their data again instead of hanging on "Reading...".
- A page that cannot start says so; a slow read says "Still reading from <context>..."; a cluster that does not answer is named after a bounded wait. Page errors go to the CrewForge output channel.
- Dashboard and chat tabs carry the Kubemoot logo, in light and dark variants.

### Crew Sources

- Crew Sources follows the file system: adding, deleting, or renaming a crew folder or one of its files, or a workspace folder, updates the view by itself, with one reload per burst of changes. Refresh stays as a manual fallback.
- A source whose render fails shows the error as an item; when the error names a file and line, clicking the item opens it there. An undeployed crew (such as a fresh `kmctl create` scaffold) lists what it declares before "Not deployed".
- Compare with Live is normalized: both sides leave out `status`, server bookkeeping, and the labels and annotations Helm, Flux, kubectl, the operator, and CrewForge add, with keys sorted, so only real differences show. A banner (and the diff title) says when the source and deployed chart versions differ.
- New on a crew source: Undeploy (Remove Deployment), Delete Crew Source (moves the folder to the trash after a confirmation that names it, and offers to undeploy a deployed crew first), and Rename Crew (the chart, the Crew, and every name built on it, with the references between them and the folder; a deployed crew is offered undeploy first, since it keeps its old name).
- Every action has a title that says what it does and how, for example "Redeploy from Source (helm upgrade or kubectl apply)" and "Follow Flux Rollout (GitOps channel)". The README has a table of each action, when to use it, and what it changes.
- The Crews view is now **Deployed Crews**.
- Crew dashboard: clicking a crew in Crew Sources or Deployed Crews opens a tab with its vitals (source and chart versions, deployment and release times, agents by role with their capabilities, live status and conditions, CrewForge's conversations and saved problems, and the Kubemoot dashboard's thread and failure counts) and buttons for Deploy (dev), Redeploy, Undeploy, Ask, Run Fitness, Lint, and Show YAML. It reads again while open.
- Crews Overview: every deployed crew the kubeconfig can see, in one table, with phase, agents ready, chart version, channel, last deploy, the turn answering now, recent problems, and whether its source is open; a crew opens its dashboard. It is on Deployed Crews' title bar, in the Command Palette, and the first item of Deployed Crews.
- CrewForge shows what it is connected to: a status bar item with the context (click to switch), and CrewForge's, Kubemoot's, and Kubernetes' versions with the context and server URL in its tooltip, the Crews Overview, and Show Connection Info (with Copy for bug reports). An unreachable cluster is named as such.
- Fitness dashboard: clicking a Fitness node or run shows the runs and the selected one's phase, progress, per-scenario outcomes and judge scores, judge status, durations, and the XLSX; it reads again while a run is going. Pause, Resume, and Stop use the operator's `spec.suspend` and `spec.cancel` when its CRD has them; a single-scenario run can be stopped.
- Run Fitness is hidden, and refuses, while a run of that crew is in progress.
- Fitness scenarios: Add (ADL or prose, in the fitness folder's layout), Rename, and Delete (to the trash, or out of its suite) from the Fitness nodes, and Run This Scenario Only (one iteration) on a scenario. Loose `.adl` and `.md` scripts in a fitness folder are listed as scenarios.
- Show Source YAML, Show Live YAML, and Show Live YAML (raw) on a resource and in the diff editor's title bar. The source view links to the file to edit; live YAML is normalized by default, and the raw view keeps everything the API server holds.

### Inner loop

- Develop a crew from the editor without GitOps: create, understand, edit, lint, deploy to a dev namespace, test, debug, redeploy, and retest. The README's "Develop a crew" walks through it.
- New Crew Here on an Explorer folder; the + on Crew Sources asks for the folder, starting with the active file's folder, instead of using the first workspace folder. After scaffolding, the crew is selected in Crew Sources, `templates/crew.yaml` opens beside the README, and a notification offers Deploy to a dev namespace.
- A crew source expands to what it declares, read from its render: the Crew, Agents (role, capabilities), PromptModules (ADL or prose), Skills, MCP servers, and fitness scenarios. Each opens its file at the object.
- A status bar item names the crew of the active file and its state: not deployed, deployed and in sync, or changed since deploy. Clicking it offers the next steps.
- Lint Crew runs `helm lint`, renders the chart, and checks every Kubemoot object against the cluster's schemas, with findings in the Problems panel on the right file and line. Saving a crew file lints its crew again. A missing helm is named with where to get it.
- Deploy (dev) is one click after the first: `helm upgrade --install` to `crew-<name>` (asked once, remembered per source), then it waits until the operator has seen the deploy and the Crew and its agents are ready, and selects the crew in the Crews view.
- Ask and Run Fitness from a source and from the status bar, as well as from the live crew.
- Saving a file of a deployed crew marks it changed since deploy; Redeploy (dev) upgrades it and waits for readiness, then offers Re-ask last question and Rerun fitness.
- In the chat, each answer keeps the agents that took part; an agent's name links to its Agent and PromptModules when the crew's source is open. With `crewforge.dashboardUrl` set, a turn opens in the Kubemoot dashboard.

### Chat

- Messages take the panel's full width; the avatars are small marks beside the time, and a
  narrow panel opens the conversations list over the chat.
- Each crew answer shows how long the crew took, next to its time. Conversations saved
  before this show the time alone.
- Under each message, buttons for Copy, Ask again, and Edit and resend (your questions), or
  Copy and Ask the question again (crew answers), shown on hover or keyboard focus.
- Rename and Delete in a chat's header, beside Copy and Save. A conversation keeps its
  first question as its name until renamed; Delete asks first, removes the saved file, and
  closes the panel.
- Failures stay visible. An agent's card says what it found in plain words and turns red
  when the agent failed or could not run; when the turn ends, what went wrong (a failed or
  unfinished agent, a gateway error, a timeout, a stop) is kept under the answer or notice,
  saved with the conversation, and included in the Markdown export. The export also gives
  each answer's duration, and its last section is now "Agent activity".
- An agent's card says when the agent is starting up or ready.
- The send button appears only when there is text to send and the crew can take it. While the crew answers, Stop takes its place; Enter never stops a turn. When the crew is not ready, in an error state, or out of reach (the cluster, or its discussion gateway), sending is blocked and the reason shows above the input, such as "The crew is not ready: phase Pending". The chat reads the crew's Crew, Agents, and gateway endpoints when it opens, every 15 seconds while visible, and after each turn.
- Ask Crew about Selection, in the editor's context menu: pick a crew, and its chat opens
  with the selected text in the input, fenced with its file name and language.

### Crews

- Create Crew checks for kmctl 0.12.0 or later (the first release with `create --chart`) before asking anything, and shows a missing or old kmctl, or a failed scaffold with kmctl's message, as a modal error.
- A live crew in the Crews view expands to its Agents (role, capabilities, readiness), PromptModules (order, ADL or prose), Skills, MCP servers and tools, and Deployment (chart, release, Flux object, recorded source). Its line shows the chart version; its tooltip, the crew's metadata and conditions.
- Show YAML and Show Crew Bundle YAML open live objects as read-only YAML without managedFields.
- A live crew's menu runs Update Deployment from Source, Deploy a Revision, Run Fitness, Follow GitOps Rollout, and Remove Deployment; Create Crew is on the Crews view's title bar.
- Removing a bundle deployment deletes only the Kubemoot objects it renders.
