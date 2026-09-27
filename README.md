# CrewForge for VS Code

See the Kubemoot crews in a cluster and talk to them from the editor. CrewForge lists
every Crew your kubeconfig can read, shows whether each is Ready, and opens a chat with
any of them: you watch each agent triage, analyze, and report, then read the crew's
answer. Conversations are saved, so you can continue one later or export it as Markdown.

Everything goes through your kubeconfig. The chat reaches a crew's discussion gateway
through the Kubernetes API server's service proxy, the same route `kmctl` uses, so no
crew needs a public address and no extra credential is involved.

## Use it

1. Install the `.vsix`: in VS Code, **Extensions: Install from VSIX...**, or
   `code --install-extension crewforge-<version>.vsix`.
2. Open the **Kubemoot** view in the activity bar. CrewForge reads the kubeconfig from
   the `crewforge.kubeconfig` setting, else `KUBECONFIG`, else `~/.kube/config`. To use a
   different file, run **CrewForge: Select Kubeconfig File**; to change cluster, **CrewForge:
   Select Kubernetes Context**.
3. Click a crew, type a question, press Enter.

While a turn runs, each agent has a card: queued, analyzing (with the GPU it landed on),
then its finding or "stood aside". The crew's answer follows, rendered as Markdown. Ask
again in the same panel and the crew keeps the conversation's context. The square button
stops a turn.

**CrewForge: Continue a Conversation** reopens any saved conversation. The copy and
download buttons in a chat's header copy or save it as Markdown. **CrewForge: Open
Conversations Folder** shows where they are kept.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `crewforge.kubeconfig` | empty | Path to a kubeconfig. Empty uses `KUBECONFIG`, then `~/.kube/config`. |
| `crewforge.context` | empty | Context to use. Empty uses the kubeconfig's current context. |
| `crewforge.namespaces` | `[]` | Show crews only in these namespaces. Set it when your account may read only some namespaces. |
| `crewforge.streamTimeoutSeconds` | `600` | Longest a single turn may stream. |

## What your account needs

- `list` on `crews.kubemoot.ai`, cluster-wide or in each namespace of `crewforge.namespaces`.
- `get` and `create` on `services/proxy` in the crew's namespace, to ask and to stream.

## Architecture boundaries

CrewForge reads Crews and talks to their discussion gateways; it creates and deletes
nothing. When authoring arrives it stays within Kubemoot's custom resources:

- **CrewForge never** deletes namespaces, manages Jobs, touches non-CRD cluster resources,
  or implements cleanup or lifecycle logic.
- **The Kubemoot operator always** owns namespace lifecycle, garbage collection, Job
  management, and cascading cleanup.

## Develop

```bash
npm install
npm test            # vitest
npm run lint
npm run typecheck
npm run package     # builds dist/ and crewforge-<version>.vsix
```

Press F5 in VS Code to run the extension in an Extension Development Host.

The tests replay discussion streams recorded from a live crew (`test/fixtures/*.sse`).
To record a new one:

```bash
P=/api/v1/namespaces/<ns>/services/<crew>-discussion:80/proxy/api/v1/discussions/<crew>
ID=$(kubectl create --raw $P -f <(printf '{"message":"<question>","conversationId":""}') | jq -r .conversationId)
kubectl get --raw $P/$ID/stream > test/fixtures/<name>.sse
```

Versions come from git tags: conventional commits on `main` drive the release workflow,
which tags, packages, and attaches the `.vsix` to a GitHub release.

## License

Apache License 2.0. See [LICENSE](LICENSE).
