# Contributing to CrewForge

How to contribute, report a problem, and reach the maintainers is documented once for all
Kubemoot repositories, in the
[Community section of kubemoot.org](https://kubemoot.org/docs/community/). To build, test,
and run CrewForge from source, see the Develop section of the [README](README.md).

## Sign your commits

Every commit carries a Developer Certificate of Origin sign-off. Add it with
`git commit -s`; the DCO check on each pull request enforces it. There is no CLA.

## Integration tests

`npm run test:integration` packages the extension and runs it in a real VS Code against a
local fake Kubernetes API server. It needs no cluster. On a machine without a display, run
it as `xvfb-run -a npm run test:integration`.

## Documentation screenshots

The screenshots on kubemoot.org are generated, not drawn, so they can be regenerated
after a UI change:

```bash
npm run screenshots -- --out <directory>
```

The script (`scripts/screenshots/`) scaffolds a crew with `kmctl create --chart` into a
throwaway workspace, fakes a cluster that has it deployed with a fitness run in progress,
starts a real VS Code with the extension against a local fake API server, and captures
each view through VS Code's debugging port at a fixed 1400 x 900 size in the light theme.
No real cluster, host name, or person appears in a picture. It needs a `kmctl` whose
`create` takes `--chart` (see the kmctl releases), `helm`, `git`, and a display (WSLg, or
`xvfb-run -a`). If `pngquant` is installed,
it shrinks each file.

To change what a screenshot shows, edit `scripts/screenshots/suite.ts` (the steps) or
`scripts/screenshots/run.ts` (the fake cluster, workspace, and settings). Copy the
resulting PNG files into the `kubemoot-docs` repository, in
`content/en/docs/ecosystem/crewforge/`. The README's `docs/screenshots/views.png` is a copy
of the `views.png` the script produces.
