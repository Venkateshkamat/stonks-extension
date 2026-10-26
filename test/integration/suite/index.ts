import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

/** Entry point called by the editor host: runs every *.test.js in this folder. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: false, timeout: 30_000 });
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) mocha.addFile(path.join(__dirname, f));
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
    } catch (e) {
      reject(e);
    }
  });
}
