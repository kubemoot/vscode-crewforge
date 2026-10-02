import { describe, expect, it } from 'vitest';
import { crewNameProblem, crewTitle, dnsLabel, deriveCrewName, DISPLAY_NAME_ANNOTATION, displayNameIn, displayNameProblem, MAX_CREW_NAME, MAX_DISPLAY_NAME, titleOf } from '../src/crew/displayName';

describe('deriveCrewName', () => {
  it.each([
    ['Homelab Health Guide', 'homelab-health-guide'],
    ['Lab-Ops Crew #2', 'lab-ops-crew-2'],
    ['  --Lab__Ops--  ', 'lab-ops'],
    ['Café Résumé', 'cafe-resume'],
    ['Ærøskøbing Straße', 'aeroskobing-strasse'],
    ['Łódź Œuvre', 'lodz-oeuvre'],
    ['ＡＢＣ １２３', 'abc-123'],
    ['K8s: the "Guide"!', 'k8s-the-guide'],
    ['日本語', 'crew'],
    ['', 'crew'],
    ['!!!', 'crew'],
    ['demo', 'demo'],
  ])('%j becomes %j', (display, name) => {
    expect(deriveCrewName(display)).toBe(name);
  });

  it('caps the length without leaving a hyphen at the end, and always gives a valid name', () => {
    const long = deriveCrewName('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(MAX_CREW_NAME);
    expect(long.endsWith('-')).toBe(false);
    expect(deriveCrewName(`${'a'.repeat(MAX_CREW_NAME - 1)} b`)).toBe('a'.repeat(MAX_CREW_NAME - 1));
    for (const display of ['Homelab Health Guide', 'word '.repeat(30), '日本語', '  ', 'Ünïcödé Crew #9']) {
      expect(crewNameProblem(deriveCrewName(display)), display).toBeUndefined();
    }
  });
});

describe('crewNameProblem', () => {
  it('accepts DNS labels up to the longest name the crew objects leave room for', () => {
    expect(MAX_CREW_NAME).toBe(36);
    for (const ok of ['a', 'demo', 'lab-2', '2lab', ' demo ', 'a'.repeat(MAX_CREW_NAME)]) expect(crewNameProblem(ok), ok).toBeUndefined();
  });

  it('says in plain words what a name may hold', () => {
    const rule = "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit; it becomes the Kubernetes name of the crew's objects.";
    for (const bad of ['Demo', 'lab ops', 'lab_ops', 'lab.ops', '-lab', 'lab-', 'café']) expect(crewNameProblem(bad), bad).toBe(rule);
    expect(crewNameProblem('  ')).toBe('Enter a name.');
    expect(crewNameProblem('a'.repeat(MAX_CREW_NAME + 1))).toBe('Keep it to 36 characters (it has 37), so the names Kubernetes builds on it fit.');
  });
});

describe('displayNameProblem', () => {
  it('accepts any one line of text up to the limit', () => {
    for (const ok of ['Homelab Health Guide', 'Lab-Ops "Crew" #2', '{{ .Values.x }}', '日本語のクルー', 'é'.repeat(MAX_DISPLAY_NAME)]) expect(displayNameProblem(ok), ok).toBeUndefined();
  });

  it('refuses an empty name, more than one line, tabs, and too many characters', () => {
    expect(displayNameProblem(' ')).toBe('Enter a name.');
    expect(displayNameProblem('two\nlines')).toBe('Keep it to one line, without tabs.');
    expect(displayNameProblem('tab\there')).toBe('Keep it to one line, without tabs.');
    expect(displayNameProblem('line\u2028sep')).toBe('Keep it to one line, without tabs.');
    expect(displayNameProblem('half ' + String.fromCharCode(0xd800) + ' pair')).toBe('Use only whole characters.');
    expect(displayNameProblem('x'.repeat(MAX_DISPLAY_NAME + 1))).toBe('Keep it to 100 characters (it has 101).');
  });
});

describe('titleOf and displayNameIn', () => {
  it('read the display-name annotation, trimmed, and fall back to the technical name', () => {
    expect(titleOf({ name: 'demo', annotations: { [DISPLAY_NAME_ANNOTATION]: ' Demo Crew ' } })).toBe('Demo Crew');
    expect(titleOf({ name: 'demo', annotations: { [DISPLAY_NAME_ANNOTATION]: '  ' } })).toBe('demo');
    expect(titleOf({ name: 'demo', annotations: { other: 'x' } })).toBe('demo');
    expect(titleOf({ name: 'demo' })).toBe('demo');
    expect(displayNameIn(undefined)).toBeUndefined();
    expect(displayNameIn({ [DISPLAY_NAME_ANNOTATION]: 'X' })).toBe('X');
  });

  it('crewTitle is one rule: the source display name, the live one, then the technical names, then the folder', () => {
    const entry = { source: { label: 'folder' }, crewName: 'src', displayName: 'Source Name' };
    const crew = { name: 'live', annotations: { [DISPLAY_NAME_ANNOTATION]: 'Live Name' } };
    expect(crewTitle({ entry, crew })).toBe('Source Name');
    expect(crewTitle({ entry: { ...entry, displayName: undefined }, crew })).toBe('Live Name');
    expect(crewTitle({ entry: { ...entry, displayName: undefined }, crew: { name: 'live' } })).toBe('src');
    expect(crewTitle({ entry: { source: { label: 'folder' } }, crew: { name: 'live' } })).toBe('live');
    expect(crewTitle({ entry: { source: { label: 'folder' } } })).toBe('folder');
    expect(crewTitle({})).toBe('');
  });

  it('dnsLabel makes any text a DNS label of a given length, or empty', () => {
    expect(dnsLabel('My Test.md', 63)).toBe('my-test-md');
    expect(dnsLabel('x'.repeat(10) + ' y', 5)).toBe('xxxxx');
    expect(dnsLabel('!!', 10)).toBe('');
  });

});
