import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Exec } from './render';

/**
 * Runs a program without a shell, feeding `input` to its standard input. A missing
 * program or a nonzero exit comes back as a result, never a throw.
 */
export const execProgram: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options?.cwd, env: { ...process.env, ...options?.env }, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: NodeJS.ErrnoException) => {
      const missing = e.code === 'ENOENT' ? `${command} was not found on PATH` : e.message;
      resolve({ code: 127, stdout: '', stderr: missing });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options?.input ?? '');
  });

export function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

/** The .yaml and .yml files directly in a folder, in name order. */
export async function readYamlFiles(dir: string): Promise<{ file: string; text: string }[]> {
  const names = (await fs.readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  return Promise.all(names.map(async (n) => ({ file: path.join(dir, n), text: await readText(path.join(dir, n)) })));
}
