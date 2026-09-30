# Changelog

Release notes for each version are on the repository's GitHub releases page,
generated from the conventional commits since the previous release.

## Unreleased

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
- Ask Crew about Selection, in the editor's context menu: pick a crew, and its chat opens
  with the selected text in the input, fenced with its file name and language.

### Crews

- Create Crew checks for kmctl 0.12.0 or later (the first release with `create --chart`) before asking anything, and shows a missing or old kmctl, or a failed scaffold with kmctl's message, as a modal error.
- A live crew in the Crews view expands to its Agents (role, capabilities, readiness), PromptModules (order, ADL or prose), Skills, MCP servers and tools, and Deployment (chart, release, Flux object, recorded source). Its line shows the chart version; its tooltip, the crew's metadata and conditions.
- Show YAML and Show Crew Bundle YAML open live objects as read-only YAML without managedFields.
- A live crew's menu runs Update Deployment from Source, Deploy a Revision, Run Fitness, Follow GitOps Rollout, and Remove Deployment; Create Crew is on the Crews view's title bar.
- Removing a bundle deployment deletes only the Kubemoot objects it renders.
