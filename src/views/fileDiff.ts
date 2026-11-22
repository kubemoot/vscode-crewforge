import type { ResourceDrift } from '../source/drift';
import type { Located } from '../source/locate';
import type { Manifest, YamlFormat } from '../source/manifests';
import { joinDocuments } from '../source/manifests';
import { normalizedYaml } from '../source/normalize';

/**
 * The live objects of the ones a source file declares, as normalized YAML for the diff
 * editor's left side; nothing when the file declares none the cluster holds.
 */
export function liveTextForFile(file: string, located: Located[], drift: ResourceDrift[], format: YamlFormat = 'yaml'): string | undefined {
  const live = located
    .filter((l) => l.file === file)
    .map((l) => drift.find((d) => d.kind === l.manifest.kind && d.name === l.manifest.metadata.name)?.live)
    .filter((m): m is Manifest => m !== undefined);
  return live.length ? joinDocuments(live.map((m) => normalizedYaml(m, format)), format) : undefined;
}
