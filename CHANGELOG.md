# Changelog

Release notes for each version are on the repository's GitHub releases page,
generated from the conventional commits since the previous release.

## Unreleased

- Create Crew checks for kmctl 0.12.0 or later (the first release with `create --chart`) before asking anything, and shows a missing or old kmctl, or a failed scaffold with kmctl's message, as a modal error.
- A live crew in the Crews view expands to its Agents (role, capabilities, readiness), PromptModules (order, ADL or prose), Skills, MCP servers and tools, and Deployment (chart, release, Flux object, recorded source). Its line shows the chart version; its tooltip, the crew's metadata and conditions.
- Show YAML and Show Crew Bundle YAML open live objects as read-only YAML without managedFields.
- A live crew's menu runs Update Deployment from Source, Deploy a Revision, Run Fitness, Follow GitOps Rollout, and Remove Deployment; Create Crew is on the Crews view's title bar.
- Removing a bundle deployment deletes only the Kubemoot objects it renders.
