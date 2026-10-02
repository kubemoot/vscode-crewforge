# test crew

A small, complete Kubemoot crew scaffolded by `kmctl create`: a read-only guide to its own
Kubernetes namespace. Ask it what is running, what is wrong, and why; it reads the
namespace with real tools and answers from what it found. It never changes anything.

It works on any cluster with Kubemoot installed and needs no configuration: everything
it reads is in the namespace you install it into, starting with its own pods.

## The crew

- **coordinator** (`test-coordinator`) picks the specialists for each question and writes the answer.
- **workloads** (`test-workloads`, tooler): Pods, Deployments, ReplicaSets, StatefulSets, and Jobs in the crew's namespace.
- **events** (`test-events`, tooler): Warning events, container restarts, and recent failures in the crew's namespace.

Scaffold with `--members 5` for the full crew of five specialists: workloads, events,
networking, config, and a reviewer.

## Your first five minutes

**1. Install it.**

```bash
helm upgrade --install test . --namespace crew-test --create-namespace
kmctl crew get test -n crew-test   # wait for Ready
```

**2. Ask it something.**

```bash
kmctl conversation ask test "List the pods in this namespace and their status." -n crew-test
```

The answer names the crew's own pods: you can check it with `kubectl get pods -n crew-test`.
Ask it to delete something and it declines: it is read-only by its prompts and by its RBAC.

**3. Run its fitness suite.**

```bash
kmctl fitness run -f fitness/fitness.yaml -n crew-test
kmctl fitness get test-starter -n crew-test
```

Each scenario asks a question whose answer the namespace itself proves. Delete the suite
before running it again: `kubectl delete crewfitnesssuite test-starter -n crew-test`.

**4. Change one rule and see the difference.** The crew's behavior is the ADL in
`templates/promptmodules.yaml`. In the `synthesis-prompt` module, which shapes
the coordinator's answer, add one rule:

```text
ALWAYS end with a one-line summary that starts "In short:"
```

Apply it again (the `helm upgrade` above); the operator rolls the agents. Ask the
same question: the answer now ends with that line.

## What is here

- `templates/crew.yaml`: the Crew and its CrewSchedulingPolicy.
- `templates/agents.yaml`: the coordinator and the specialists. Agents declare capabilities,
  never a model; the policy binds Models to them.
- `templates/promptmodules.yaml`: every prompt, in ADL.
- `templates/tools.yaml`: the Kubernetes MCP server, read-only, and the MCP gateway the agents reach it through.
- `templates/rbac.yaml`: the read-only Role the tool server runs with. Set `access.clusterWide: true` in
  `values.yaml` to let it read every namespace.
- `templates/models.yaml`: the Models the scheduler binds agents to.
- `fitness/fitness.yaml`: the fitness suite, outside `templates/` so installing does not start a run.
- `templates/fitness-scenarios.yaml`: a ConfigMap built from `fitness/`, so the deployed crew carries
  its tests; CrewForge runs them from the live crew.

Model family: `qwen`.
Model providers: `ollama`.

## What it can read

By default the crew reads only the namespace it is installed into: its Role covers that
namespace, and its prompts say so. Every answer names the namespace, and a question about
other namespaces or the whole cluster gets a plain "this crew reads only ..." with the way
to widen it. Set `access.clusterWide: true` in `values.yaml` and redeploy (the `helm upgrade` above) to
widen both: a ClusterRole lets the tool server read every namespace, still read-only and
without Secrets, and the prompts tell the crew to name the namespace of each resource it
reports.

## Read-only by design

The tool server runs with `--read-only`, so it offers no tool that changes the cluster, and its
Role grants only get, list, and watch. Secrets are not readable at all: Kubernetes cannot
grant a Secret's name without its data, so the crew names Secrets from the references in
pod specs instead.
