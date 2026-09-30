import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

/** The entry VS Code's test host calls: runs every bundled `*.it.js` next to this file with mocha. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 90_000, color: true });
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.it.js')).sort()) mocha.addFile(path.join(__dirname, file));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
}
