/**
 * The words CrewForge uses to say what a thing is and what a control does: every term
 * (a crew, an agent, a moot), every button, tab, menu item, and table column. The native
 * views, the commands, and the webviews all read their tooltips from here, so one thing
 * has one definition. The terms say what the Kubemoot dashboard's page definitions say.
 * A test walks package.json, the trees, and every page and fails when one has no text.
 */
/** What the gate and judge score columns of a fitness run mean, and why they can disagree. */
export const GATES_LEGEND = [
  "Gates are the scenario script's own checks (the agree floor, required and forbidden terms). An iteration passes when every gate holds.",
  "Judge score is the judge's 0 to 100 rating of the answers against the references. It does not read the gates.",
  'The two are independent: all gates can pass with a low score, and a gate can fail on an answer the judge liked.',
];


/** What a thing is in Kubemoot, by name. */
export const TERMS = {
  crew: 'A crew is a team of agents that deliberate together to answer questions in one domain.',
  agent: 'An agent is one member of a crew, backed by a model, with its own prompt and tools.',
  coordinator: 'The coordinator is the agent that leads a crew: it triages a question and writes the answer the moot settles on.',
  promptModule: 'A prompt module is a reusable block of instructions that agents combine in order.',
  skill: 'A skill is a named block of know-how an agent can load when a question needs it.',
  model: 'A model is a language model that agents call, loaded by a model server.',
  modelServer: 'A model server is the inference backend, such as vLLM, that runs models on an accelerator.',
  embeddingModel: 'An embedding model turns text into vectors so agents can search documents by meaning.',
  ragSource: 'A RAG source is a document repository indexed so agents can search it for grounded answers.',
  mcpServer: 'An MCP server gives agents tools, such as kubectl or Helm, through the Model Context Protocol.',
  mcpGateway: "An MCP gateway is the single endpoint agents use to reach a crew's MCP servers.",
  tool: 'A tool is one action an MCP server offers that an agent can call, such as listing pods.',
  policy: "A scheduling policy states which kind of moot a crew runs and what its agents need from models, such as a preferred size.",
  notificationSink: "A notification sink is a place Kubemoot sends a crew's alerts, such as a webhook.",
  conversation: "A conversation holds your own questions to a crew and the crew's answers.",
  moot: 'A moot is the agents of a crew deliberating over one question until they settle on an answer.',
  memory: 'Crew memory is what a crew has learned about its cluster and keeps between discussions.',
  fitness: 'Fitness measures how well a crew answers a set of scripted scenarios.',
  fitnessRun: 'A fitness run is one execution of a scripted scenario, or of a suite of them, against a crew.',
  fitnessSuite: "A fitness suite repeats a crew's scenarios many times to measure how reliably it answers.",
  scenario: 'A fitness scenario is one scripted question with the assertions that say whether the crew answered well.',
  source: 'A crew source is a Helm chart or a bundle of manifests in your workspace that declares a crew.',
  deployment: 'A deployment is a crew running in one namespace of the cluster, put there by Helm, a bundle, or Flux.',
  channel: 'The channel is how a deployment reaches the cluster: Helm, a bundle applied with kubectl, or Flux from git.',
  namespace: 'A Kubernetes namespace is a named area of the cluster; each crew lives in one.',
  context: 'The Kubernetes context is the cluster, user, and namespace default your kubeconfig selects; CrewForge reads through it.',
  drift: 'Drift is how a deployed object differs from what its source renders.',
  overview: 'The crews overview is the summary of every crew CrewForge can read on the cluster you are connected to.',
  connection: 'The connection is the kubeconfig context CrewForge reads through, and the Kubemoot and Kubernetes versions it found there.',
  archetype: 'An archetype is the pattern a moot follows, such as who speaks first and how agents agree.',
} as const;

export type TermId = keyof typeof TERMS;

/** The Kubernetes kinds the trees list, each with the term that says what it is. */
export const KIND_TERMS: Record<string, string> = {
  Crew: TERMS.crew,
  Agent: TERMS.agent,
  PromptModule: TERMS.promptModule,
  Skill: TERMS.skill,
  Model: TERMS.model,
  ModelServer: TERMS.modelServer,
  EmbeddingModel: TERMS.embeddingModel,
  RAGSource: TERMS.ragSource,
  MCPServer: TERMS.mcpServer,
  MCPGateway: TERMS.mcpGateway,
  MCPCatalog: 'An MCP catalog lists MCP servers found in an outside registry.',
  MCPQualityPolicy: 'A quality policy is a set of allow and block rules for MCP servers found in catalogs.',
  MCPServerReport: 'An MCP report is the test history and reliability verdict for one MCP server.',
  CrewSchedulingPolicy: TERMS.policy,
  MootArchetype: TERMS.archetype,
  NotificationSink: TERMS.notificationSink,
  CrewFitness: TERMS.fitnessRun,
  CrewFitnessSuite: TERMS.fitnessSuite,
  KubemootConfig: 'Kubemoot config holds the cluster-wide settings that apply to every crew.',
  HelmRelease: 'A Flux HelmRelease is the object Flux reads from git to install and upgrade the crew chart.',
};

/** The definition of a Kubernetes kind, or a plain statement for a kind this list does not know. */
export function kindTerm(kind: string): string {
  return KIND_TERMS[kind] ?? `${kind} is a Kubernetes object the crew uses.`;
}

/** What each page and pane heading means; a heading with a count drops the count to look itself up. */
export const HEADINGS: Record<string, string> = {
  'Crews Overview': TERMS.overview,
  'Deployed crews': 'The crews running on the cluster you are connected to, with their state, agents, chart, and recent problems.',
  Source: TERMS.source,
  Deployment: TERMS.deployment,
  Contents: "Every group of objects the crew is made of, with how many each holds. A group's name opens it in the tree.",
  Agents: TERMS.agent,
  'Live status': "The operator's current report on the crew: its phase, whether it can answer, and its conditions.",
  Conversations: TERMS.conversation,
  "Conversations (CrewForge's, on this computer)": "The conversations CrewForge saved on this computer with this crew, and the problems in recent turns. The crew's own copy is separate.",
  'Recent problems': 'Failed turns and agent failures found in the conversations saved on this computer.',
  Runs: TERMS.fitnessRun,
  Scenarios: TERMS.scenario,
  Assertions: 'An assertion is one check a scenario makes on the answer; it passes or fails.',
  'Left out': 'Memory entries the export did not include, with the reason. Credentials are never exported as memory.',
  Fitness: TERMS.fitness,
  Memory: TERMS.memory,
  Moot: TERMS.moot,
};

/** What a topic section of the memory page is: the facts the crew filed under one subject. */
export const MEMORY_TOPIC = 'A topic is a subject the crew files what it learned under; its facts are listed below.';

/** What each column header in a table means. */
export const COLUMNS: Record<string, string> = {
  Agent: TERMS.agent,
  Role: "The agent's part in the moot, such as coordinator or specialist.",
  Capabilities: 'What the agent asks the scheduler for in a model, such as tool-calling or reasoning.',
  State: 'Whether the agent is ready to take part, or the phase it is in.',
  Condition: 'One check the operator makes on the crew, by name.',
  Status: 'Whether the condition holds: True or False.',
  Reason: 'A short code for why the condition has its status.',
  Message: 'The text the operator gives with the condition.',
  When: 'When the problem was recorded.',
  Problem: 'What went wrong in the turn.',
  Crew: TERMS.crew,
  Namespace: TERMS.namespace,
  Phase: "Where the crew or run is in its life, such as Ready or Running.",
  'Agents ready': 'How many of the crew\'s agents are ready, out of how many it has.',
  Chart: 'The version of the Helm chart the crew was deployed from.',
  Channel: TERMS.channel,
  'Last deploy': 'When CrewForge or Helm last deployed this crew.',
  'Answering now': 'The question a turn is answering right now in an open chat with this crew.',
  'Recent problems': 'How many problems CrewForge found in its recent saved turns with this crew.',
  'Local source': 'Whether a source for this crew is open in your workspace.',
  Run: TERMS.fitnessRun,
  Kind: 'Whether the run is a suite of scenarios or a single scenario.',
  Progress: 'How many iterations of the run have finished.',
  Started: 'When the run started.',
  Duration: 'How long the run took, or has taken so far.',
  Scenario: TERMS.scenario,
  Done: 'How many iterations of the scenario have finished.',
  'Gates passed': "How many iterations held every gate: the scenario script's own checks, not the judge.",
  'Gates failed': "How many iterations failed a gate. The judge's score does not change this.",
  Errored: 'How many iterations stopped on an error before the gates ran.',
  'Mean duration': 'The average time one iteration of the scenario took.',
  'Judge score': "The judge's rating of the scenario's answers against the references, 0 to 100. The gates do not change it.",
  'Failure reason': 'Why a gate failed: the first failed assertion, or the error of the iteration that could not run.',
  'Judge reason': "The judge's reason for the score.",
  Assertion: 'The check the scenario makes on the answer.',
  Result: 'Whether the check passed, and what it found.',
  '': 'Whether the assertion passed or failed.',
  Key: 'The name the crew filed the fact under.',
  Value: 'What the crew remembers under that key.',
  'Learned by': 'The agent that learned the fact.',
  Thread: 'The discussion thread in which the fact was learned.',
  Entries: 'How many memory entries were left out for this reason.',
};

/** What each label in a facts list means. */
export const FACTS: Record<string, string> = {
  Path: 'The folder of the source in your workspace.',
  Kind: 'Whether the source is a Helm chart or a bundle of manifests.',
  Chart: 'The name of the Helm chart.',
  'Chart version': 'The version of the Helm chart.',
  'App version': 'The version of the application the chart installs, as the chart declares it.',
  'Render error': 'Why the source could not be rendered into objects.',
  Namespace: TERMS.namespace,
  Context: TERMS.context,
  Channel: TERMS.channel,
  'Helm release': 'The name Helm knows this installation by.',
  'First deployed': "When the crew was first installed: the Helm release's first install, else the Crew object's creation.",
  'Last redeploy': 'When the crew was last upgraded.',
  'Helm revision': 'How many times Helm has upgraded this release; each upgrade is one revision.',
  'Deployed by': 'Who CrewForge recorded as having deployed the crew.',
  'Source revision': 'The git revision of the source when it was deployed.',
  'CrewForge deploy': 'When CrewForge stamped the deployment.',
  Phase: 'Where the crew or run is in its life, such as Ready or Running.',
  Reconciled: "Whether the operator has finished acting on the crew's latest spec.",
  'Can answer': 'Whether the crew can take a question now, and if not, why.',
  Capacity: "How much of the cluster's accelerator and model capacity the crew has to answer with.",
  'Generation observed': "Which version of the Crew's spec the operator has acted on, out of the latest.",
  'Agents the operator counts': 'How many agents the operator found for this crew.',
  Coordinator: TERMS.coordinator,
  Message: 'The text the operator gives about the crew.',
  Conversations: 'How many conversations with this crew CrewForge saved on this computer.',
  Turns: 'How many questions and answers those conversations hold in all.',
  'Answering now': 'How many turns are being answered right now.',
  Progress: 'How many iterations of the run have finished.',
  'Passed / failed / errored': 'How the finished iterations ended.',
  Started: 'When the run started.',
  Completed: 'When the run finished.',
  Duration: 'How long the run took.',
  'Run id': 'The identifier the fitness runner gave the run; it names the results in the object store.',
  'Results workbook': 'Where the run stored its results spreadsheet.',
  Error: 'Why the run stopped.',
};

/** What each tab of the crew page shows. */
export const TAB_TIPS = {
  overview: 'Where the crew runs, its agents, and its conversations',
  source: 'The objects the local source renders, each openable at its place',
  live: 'The objects running in the cluster',
  diff: 'Each object changed, missing, or extra between source and cluster',
} as const;

/** What stopping a fitness run does, in the tooltip of Stop and in the question that asks first. */
export const STOP_EFFECTS = {
  suite: 'The running iteration ends and the suite becomes Cancelled; results so far are kept.',
  single: 'The run is deleted with its results; the operator removes its Job.',
} as const;

/** What each button of a page does, by what it is for. A button's tooltip is its text; a disabled one says why instead. */
export const ACTIONS = {
  deploy: 'Deploy to a namespace you pick (helm upgrade --install, or kubectl apply for a bundle)',
  deployShort: 'Deploy the source to a namespace you pick',
  redeploy: 'Redeploy from source to the namespace it was last deployed to (helm upgrade)',
  undeploy: 'Remove the deployment (helm uninstall, or delete its Kubemoot objects)',
  ask: 'Open the chat with this crew',
  fitness: 'Run one of its fitness definitions',
  fitnessDashboard: 'Open the fitness dashboard for this deployment',
  lint: 'Lint (helm lint and schema check)',
  yamlSource: "Open the Crew's source file at the Crew",
  yamlLive: 'Show the live Crew YAML',
  refreshPage: 'Read everything again',
  selectContext: 'Pick another context from the kubeconfig',
  openSourceFolder: 'Add the folder that holds its chart or bundle to the workspace',
  refreshCrews: 'Read every crew again',
  connection: 'Show the connection details, with Copy for a bug report',
  refreshRuns: 'Read the runs again',
  runFitness: "Run one of the crew's fitness definitions",
  showRun: 'Show this run',
  showProgress: 'How many iterations of the suite have finished, out of all of them',
  pause: 'Pause between iterations; the running iteration finishes (spec.suspend)',
  resume: 'Resume the paused suite',
  stopSuite: `Stop the suite (spec.cancel). ${STOP_EFFECTS.suite}`,
  stopSingle: `Stop this single-scenario run. ${STOP_EFFECTS.single}`,
  xlsx: 'Download the results workbook from the Kubemoot dashboard',
  openRunInDashboard: "Open the Kubemoot dashboard's Fitness page in your browser, where this run's transcripts are",
  rawOn: 'Leave out status and the metadata the cluster and tools add',
  rawOff: 'Everything the API server holds, status and all',
  openDiff: 'Compare live with source in the diff editor',
  refreshMemory: 'Read the crew memory again',
  exportMemory: 'Save the OMPI export as a zip in a folder you pick',
  moreActions: 'Show the other actions for this page',
} as const;

/** An icon-only control: its short name for a screen reader, and what it does and affects. Its tooltip is `name: what`. */
export interface IconAction {
  label: string;
  what: string;
}

/** The tooltip of an icon-only control. */
export function iconTip(a: IconAction): string {
  return `${a.label}: ${a.what}`;
}

/** The icon buttons of the chat page, in its header, on each saved conversation, and under each message. */
export const CHAT = {
  menu: { label: 'Conversation actions', what: 'opens the actions for this conversation: stop, pause, resume, rename, copy, save, and the two deletes' },
  newConversation: { label: 'New conversation', what: 'starts an empty conversation with this crew; the current one stays saved' },
  toggleList: { label: 'Show or hide conversations', what: 'opens or closes the list of conversations saved on this computer' },
  stop: { label: 'Stop on the crew', what: 'ends the moot running for this conversation; the saved messages stay' },
  cancel: { label: 'Cancel on the crew', what: 'removes this question from the crew\'s queue before the crew sees it; the saved messages stay' },
  pause: { label: 'Pause on the crew', what: 'pauses the conversation\'s running turns on the crew until you resume them; nothing is deleted' },
  resume: { label: 'Resume on the crew', what: 'resumes the conversation\'s paused turns on the crew' },
  erase: { label: 'Delete from the crew', what: 'erases this conversation from every store on the cluster; asks first. CrewForge\'s copy on this computer stays' },
  rename: { label: 'Rename conversation', what: 'changes the title in CrewForge only; the crew is not changed' },
  delete: { label: 'Delete from this computer', what: "removes CrewForge's saved copy only; the crew keeps its own record" },
  copy: { label: 'Copy conversation as Markdown', what: 'puts the whole conversation on the clipboard' },
  export: { label: 'Save conversation as Markdown', what: 'writes the conversation to a .md file you choose' },
  send: { label: 'Send', what: 'asks the crew this question' },
  stopTurn: { label: 'Stop this turn', what: 'stops waiting for the answer here and keeps what arrived; the crew may keep working. Use Stop on the crew in the actions menu to end the moot' },
  copyMessage: { label: 'Copy', what: 'puts this question on the clipboard' },
  copyAnswer: { label: 'Copy answer as Markdown', what: 'puts this answer on the clipboard' },
  reask: { label: 'Ask again', what: 'sends this question to the crew again as a new turn' },
  reaskAnswer: { label: 'Ask the question again', what: 'sends the question that led to this answer to the crew again as a new turn' },
  edit: { label: 'Edit and resend', what: 'puts this question back in the input to change before sending' },
  openTurn: { label: 'Open in the Moot', what: 'shows the moot behind this answer, message by message, in the Kubemoot dashboard in your browser' },
  openDashboard: { label: 'Open the Kubemoot dashboard', what: 'opens the dashboard in your browser' },
  resizer: { label: 'Resize the conversations list', what: 'drag to make the list wider or narrower' },
  freshDot: { label: 'Something new from the crew', what: 'the crew added to this conversation since you last opened it' },
  question: { label: 'Question', what: 'ask the crew anything in its domain; its agents will discuss it' },
} as const satisfies Record<string, IconAction>;

/** What the chat page's headings, labels, and fixed text mean. */
export const CHAT_TEXT = {
  conversationsHeading: TERMS.conversation,
  askHeading: `${TERMS.crew} ${TERMS.moot}`,
  crewName: 'The crew this conversation is with: its display name, with its technical name beside it when they differ.',
  where: 'The namespace the crew runs in and the Kubernetes context CrewForge reached it through.',
  agentsTookPart: 'The agents of the crew that took part in the moot for this answer, with what each concluded.',
  problems: 'What went wrong in this turn.',
  status: 'What the moot is doing now.',
  input: 'Ask the crew a question. Enter sends it; Shift+Enter adds a line.',
  conversationTitle: 'Crew {crew}. ' + TERMS.crew,
  agentName: 'An agent of the crew that took part in this moot. ' + TERMS.agent,
  powered: 'AI can make mistakes. Verify important info.',
} as const;

/** The text a control gets for a short label, which says a word of what it does: used where a table has none. */
export function lookup(table: Record<string, string>, key: string): string | undefined {
  const open = key.lastIndexOf(' (');
  return table[key] ?? (open > 0 ? table[key.slice(0, open)] : undefined);
}

/** What each step of the status bar's menu does, shown beside it in the quick pick. */
export const NEXT_STEPS: Record<string, string> = {
  deploy: ACTIONS.deployShort,
  redeploy: ACTIONS.redeploy,
  ask: ACTIONS.ask,
  fitness: ACTIONS.fitness,
  reveal: 'Select the deployed crew in the Deployed Crews view',
  lint: 'Check the chart and its objects with helm lint and the schema',
  namespace: 'Pick the namespace Redeploy updates',
  refresh: 'Compare the source with the cluster again',
};

/** What each ability a model can have means, for the scheduling needs quick pick. */
export const ABILITY_TIPS: Record<string, string> = {
  'tool-calling': 'the model can call MCP tools',
  reasoning: 'the model works through a problem in steps before it answers',
  vision: 'the model can read images',
};

/** What each deploy channel does, when the channel has no reason of its own to show. */
export const CHANNEL_TIPS: Record<string, string> = {
  helm: 'installs or upgrades the chart in the namespace you pick',
  bundle: 'applies the bundle of manifests to the namespace you pick',
  flux: 'you commit and push; Flux deploys it from git',
};

/** The two views CrewForge adds to the activity bar, as the short phrase beside each view's name. */
export const VIEW_DESCRIPTIONS = {
  crews: 'crews running on the cluster',
  sources: 'crew charts in this workspace',
} as const;

/** What the status bar items say they are, ahead of their details. */
export const STATUS_TIPS = {
  connection: TERMS.connection,
  crew: TERMS.source,
} as const;

/** Words that open a tree tooltip and name a thing that is not a Kubernetes kind. */
const HEAD_TERMS: Record<string, string> = {
  Tool: TERMS.tool,
  Scenario: TERMS.scenario,
  Fitness: TERMS.scenario,
};

/**
 * Adds what the item is to a tree tooltip: its first line names the thing ("Agent helpdesk-k8s",
 * "PromptModule base"), and the definition of that kind follows it. A tooltip that does not
 * open with a known kind comes back as it was.
 */
export function withTerm(tooltip: string): string {
  const newline = tooltip.indexOf('\n');
  const head = newline < 0 ? tooltip : tooltip.slice(0, newline);
  const word = head.split(/[\s/:]/)[0];
  const term = KIND_TERMS[word] ?? HEAD_TERMS[word];
  if (!term) return tooltip;
  return newline < 0 ? `${head}\n${term}` : `${head}\n${term}${tooltip.slice(newline)}`;
}

/** The tooltip of the chat page's crew name: which crew it is, and what a crew is. */
export function conversationTitleTip(crew: string): string {
  return CHAT_TEXT.conversationTitle.replace('{crew}', crew);
}

/** The tooltip of a saved conversation in the list: its title and when it started. */
export function openConversationTip(title: string, ago: string): string {
  return `Open the conversation "${title}", started ${ago}`;
}
