import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupByTopic, leftOutByReason, parseExport, parseReport } from '../src/memory/ompi';
import { readZip, ZIP_LIMITS } from '../src/memory/zip';
import { buildZip } from './zipBuilder';

const fixture = (name: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', name));

describe('readZip', () => {
  it('reads deflated and stored entries and skips directories', () => {
    for (const method of [0, 8] as const) {
      const files = readZip(buildZip({ 'a/': '', 'a/b.txt': 'hello', 'c.txt': 'world' }, method));
      expect([...files.keys()]).toEqual(['a/b.txt', 'c.txt']);
      expect(files.get('a/b.txt')?.toString()).toBe('hello');
    }
  });

  it('finds the end record behind a zip comment', () => {
    expect(readZip(buildZip({ 'x.txt': 'y' }, 8, 'a comment')).get('x.txt')?.toString()).toBe('y');
  });

  it('reads a zip made by another writer', () => {
    expect(readZip(fixture('memory-export.zip')).has('manifest.json')).toBe(true);
  });

  it('rejects what is not a zip, a damaged zip, and an unsupported method', () => {
    expect(() => readZip(Buffer.from('not a zip file at all, just text'))).toThrow(/not a zip/);
    const zip = buildZip({ 'a.txt': 'x' });
    zip.writeUInt32LE(0, zip.length - 22 + 16 - 0); // central directory offset into the weeds
    expect(() => readZip(zip)).toThrow(/damaged/);
    const odd = buildZip({ 'a.txt': 'x' }, 0);
    odd.writeUInt16LE(99, odd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(() => readZip(odd)).toThrow(/unsupported zip method/);
  });

  it('refuses an entry that is too large', () => {
    const zip = buildZip({ 'a.txt': 'x' }, 0);
    zip.writeUInt32LE(ZIP_LIMITS.entryBytes + 1, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    expect(() => readZip(zip)).toThrow(/too large/);
  });
});

describe('readZip limits', () => {
  const saved = { ...ZIP_LIMITS };
  afterEach(() => Object.assign(ZIP_LIMITS, saved));

  it('refuses an archive of too many files or too many bytes in all', () => {
    const zip = buildZip({ 'a.txt': 'xxxx', 'b.txt': 'yyyy' });
    ZIP_LIMITS.entries = 1;
    expect(() => readZip(zip)).toThrow(/too many files/);
    ZIP_LIMITS.entries = saved.entries;
    ZIP_LIMITS.totalBytes = 6;
    expect(() => readZip(zip)).toThrow(/memory export is too large/);
  });

  it('refuses an entry whose local header is missing', () => {
    const zip = buildZip({ 'a.txt': 'x' }, 0);
    zip.writeUInt32LE(zip.length, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 42);
    expect(() => readZip(zip)).toThrow(/damaged/);
  });
});

describe('parseExport', () => {
  const parsed = parseExport(fixture('memory-export.zip'));

  it('reads the manifest', () => {
    expect(parsed.manifest).toEqual({ protocolVersion: '0.6', exportedAt: '2026-11-20T12:00:00Z', selection: 'selection', skipped: 2 });
  });

  it('reads each fact with its value, writer, time and thread', () => {
    expect(parsed.facts).toHaveLength(3);
    const node = parsed.facts.find((f) => f.key === 'node-count');
    expect(node).toEqual({ topic: 'cluster', key: 'node-count', value: 'The homelab has 5 nodes <b>bold</b>', learnedBy: 'coordinator', learnedAt: '2026-11-18T10:00:00Z', thread: 'thread-abc' });
  });

  it('leaves the writer and thread empty when the export names none', () => {
    const units = parsed.facts.find((f) => f.key === 'units');
    expect(units).toMatchObject({ learnedBy: '', thread: '' });
  });

  it('groups facts by topic, in name order', () => {
    const groups = groupByTopic(parsed.facts);
    expect(groups.map((g) => g.topic)).toEqual(['cluster', 'preferences']);
    expect(groups[0].facts.map((f) => f.key)).toEqual(['gpu', 'node-count']);
  });

  it('rejects an archive without a manifest, a memory that is not JSON, and one with no topic or key', () => {
    expect(() => parseExport(buildZip({ 'memories/a.json': '{}' }))).toThrow(/no manifest/);
    expect(() => parseExport(buildZip({ 'manifest.json': '{}', 'memories/a.json': 'nope' }))).toThrow(/not valid JSON/);
    expect(() => parseExport(buildZip({ 'manifest.json': '{}', 'memories/a.json': '{"body":"x"}' }))).toThrow(/no topic or key/);
  });

  it('reads an export with no facts', () => {
    expect(parseExport(buildZip({ 'manifest.json': '{"protocol_version":"0.6"}' })).facts).toEqual([]);
  });
});

describe('the selection report', () => {
  const report = parseReport(fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-report.json'), 'utf8'));

  it('counts the left-out entries by reason, most frequent first', () => {
    expect(leftOutByReason(report!)).toEqual([
      { reason: 'its value holds a credential (bearer token); not exported as memory', count: 2 },
      { reason: 'its topic or key holds a credential; not exported as memory', count: 1 },
    ]);
  });

  it('carries no text of a fact', () => {
    expect(JSON.stringify(leftOutByReason(report!))).not.toContain('crew-demo.demo');
  });

  it('is null for a body that is not a report', () => {
    expect(parseReport('<html>')).toBeNull();
    expect(parseReport('{"memories":"x"}')).toBeNull();
    expect(leftOutByReason(undefined)).toEqual([]);
  });
});
