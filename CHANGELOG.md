# Changelog

Release notes for each version are on the repository's GitHub releases page,
generated from the conventional commits since the previous release.

## Unreleased

### Develop a crew from the editor

- The whole inner loop runs in VS Code, without GitOps: create, understand, edit, lint,
  deploy to a namespace, ask, debug, redeploy, and retest. CrewForge never commits or
  pushes. See [Develop a crew in VS Code](https://kubemoot.org/docs/ecosystem/crewforge/develop-a-crew/).
- **New Kubemoot Crew Here** on a folder in the Explorer scaffolds a crew with
  `kmctl create --chart` (kmctl 0.12.0 or later). The **+** on Crew Sources asks for the
  folder, starting with the active file's folder. Afterwards the crew is selected in Crew
  Sources, `templates/crew.yaml` opens beside the README, and a notification offers
  **Deploy to Namespace...**. A missing or old kmctl is named before anything is asked.
- **View in CrewForge** on any file or folder inside a crew selects the matching item in
  Crew Sources (the object a manifest declares, or the crew) and opens its dashboard.
- A crew source expands to what it declares: the Crew, Agents, PromptModules (ADL or
  prose), Skills, MCP Servers, and Fitness Scenarios. Each opens its file at the object.
  Crew Sources follows the file system, and a chart that does not render shows the error
  as an item that opens the file and line.
- A status bar item names the crew of the open file and where it stands: not deployed,
  deployed and in sync, or deployed and changed. Click it for the next steps.
- **Lint** runs `helm lint`, renders the chart, and checks every Kubemoot object against
  the schemas your cluster serves. Findings appear in the Problems panel on the right file
  and line, and saving a file of the crew lints it again.
- **Deploy to Namespace...** asks for the namespace (the last one, else `crew-<name>`),
  runs `helm upgrade --install`, and follows the crew until the operator has seen the
  deploy and the Crew and its agents are ready. **Redeploy** repeats it in the same
  namespace; its notification offers **Re-ask last question** and **Rerun fitness**.
  **Deploy with a Channel...** picks Helm, a bundle, or Flux.
- **Undeploy**, **Rename...**, and **Delete Source...** (which moves the folder to the
  trash, after a confirmation that names it) manage a crew's lifecycle.
- **Ask** and **Run Fitness** work from a source, from the status bar, and from a deployed
  crew. Under each answer, an agent's name links to its Agent and PromptModules when the
  crew's source is open, and with `crewforge.dashboardUrl` set a turn opens in the
  Kubemoot dashboard.

### Views and dashboards

- The views are **Deployed Crews** and **Crew Sources**. A deployed crew expands to its
  Agents, PromptModules, Skills, MCP Servers and tools, and Deployment; each deployment of
  a source shows its drift.
- The **crew dashboard** opens when you click a crew. Its tab is titled with the crew's
  name. **Overview** shows the source, the deployment, the agents, and the live status.
  **Source** lists the rendered objects, **Live** the objects in the cluster, and **Diff**
  each changed, missing, or extra object with its normalized diff and **Open in Diff
  Editor**. A tab without its counterpart says why and offers the way to it.
- The **Crews Overview** lists every deployed crew your kubeconfig can see in one table.
- **Compare Source with Live** is normalized: both sides leave out `status`, server
  bookkeeping, and the labels and annotations Helm, Flux, kubectl, and CrewForge add, so
  only real differences show. A banner says when the source and deployed chart versions
  differ.
- **Show Source YAML**, **Show Live YAML**, and **Show Live YAML (raw)** show one side
  alone, from a resource and from the diff editor's title bar.
- Every action has a title that says what it does and how, and the documentation has a
  table of each action, when to use it, and what it changes.

### Fitness

- The **fitness dashboard** shows a crew's runs and the selected one: phase, progress, each
  scenario's outcomes and judge score, the judge's status, durations, and the results
  workbook. It reads again while a run is going.
- **Pause**, **Resume**, and **Stop** set `spec.suspend` and `spec.cancel` on a suite when
  your operator's CRD has them. A single-scenario run can be stopped.
- **Run This Scenario Only** runs one scenario for one iteration.
  **Add Fitness Scenario...**, **Rename Fitness Scenario...**, and **Delete Fitness
  Scenario...** manage the scenarios in the fitness folder, ADL or prose.
- **Run Fitness** is hidden, and refuses, while a run of that crew is in progress, and
  warns before starting one while another crew's run is in progress.

### Chat

- Messages use the panel's full width. Each answer shows how long the crew took.
- Under each message, buttons appear on hover or keyboard focus: **Copy**, **Ask again**,
  and **Edit and resend** for your questions; **Copy** and **Ask the question again** for
  answers.
- A conversation is named after its first question. **Rename**, **Delete** (from this
  computer, after asking), copy, and save as Markdown are in the chat's header.
- Failures stay visible. An agent's card says what it found in plain words and turns red
  when the agent failed or could not run. What went wrong in a turn stays under the answer,
  is saved with the conversation, and is included in the Markdown export, which also gives
  each answer's duration.
- The send button appears only when there is text to send and the crew can take it. While
  the crew answers, **Stop** takes its place; Enter never stops a turn. When the crew is
  not ready or out of reach, sending waits and the reason shows above the input.
- **Ask a Crew about the Selection**, in the editor's context menu, opens a crew's chat
  with the selected code in the input, fenced with its file name and language.

### Connection

- A status bar item shows the context CrewForge uses; click it to switch. Its tooltip,
  the first item of Deployed Crews, the Crews Overview, and **Show Connection Info** give
  the versions of CrewForge, the Kubemoot operator, and Kubernetes, with the context and
  server address.
- A cluster that cannot be reached is said in plain words, with the context and server:
  "No response from context kind-dev at https://127.0.0.1:49681. Is the cluster running?".
  Refused, timed-out, unresolvable, and reset connections, untrusted certificates, rejected
  credentials, forbidden requests, and failed login plugins each have their own message.
  Each offers **Select Kubernetes Context**; the raw error stays in the tooltip.
- A request that gets no answer from the API server for 20 seconds fails with a plain
  message. A page or tree that is slow to read says "Still reading from <context>...", and
  a page gives up after a bounded wait instead of staying on "Reading...". Page errors go
  to the CrewForge output channel.
- Dashboard and chat tabs carry the Kubemoot mark, in light and dark variants.
