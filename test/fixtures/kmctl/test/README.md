# test crew

Scaffolded by `kmctl create`. This is a minimal, valid starting point -
customize it before relying on it.

It is a Helm chart: the manifests are in `templates/`, the starter fitness suite in
`fitness/`.

## What is here

- `crew.yaml` - the Crew and its CrewSchedulingPolicy (loose model coupling:
  agents declare capabilities, the policy picks models at reconcile time).
- `agents.yaml` - a coordinator plus 2 tooler(s). Replace each
  tooler's description and responsibility with something real.
- `promptmodules.yaml` - shared protocol/style modules, the coordinator's
  modules, and a per-tooler system module (ADL). Flesh these out.
- `models.yaml` - Model CRs (the chosen family's sizes bound to your
  ModelProviders, labeled by capability + latencyClass). The scheduler binds agents
  to these; a crew needs at least one to run. Edit model names/VRAM to taste.
- `fitness.yaml` - a starter CrewFitnessSuite: a capability smoke test,
  a general-knowledge question the crew answers directly, and an honest
  don't-fabricate test (real-time data it has no source for).
- Preferred model family: `qwen` (see the policy comment to pin it).
- Selected providers: `ollama`.

## Next steps

```bash
helm upgrade --install test . --namespace test --create-namespace
kmctl crew status test -n test
kubectl apply -n test -f fitness/
```
