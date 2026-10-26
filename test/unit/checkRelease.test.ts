import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

// scripts/check-release.js is plain CommonJS used by the publish workflow; load it from the repo root (out/test/unit/ -> root).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cr = require('../../../scripts/check-release.js') as {
  normalizeTag(tag: unknown): string;
  checkVersion(tag: unknown, version: string): { ok: boolean; version: string; message: string };
  checkVsixEntries(entries: string[]): { ok: boolean; unexpected: string[]; missing: string[] };
  listZipEntries(file: string): string[];
};

const GOOD = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/media/icon.png',
  'extension/dist/extension.js',
  'extension/dist/media/chart.umd.min.js',
  'extension/dist/media/panel.css',
  'extension/dist/media/panel.js',
];

describe('release checks (scripts/check-release.js)', () => {
  it('matches a tag against the package version, ignoring a leading v', () => {
    assert.strictEqual(cr.normalizeTag(' v1.2.3 '), '1.2.3');
    assert.ok(cr.checkVersion('v1.0.0', '1.0.0').ok);
    assert.ok(cr.checkVersion('1.0.0', '1.0.0').ok);
    assert.ok(!cr.checkVersion('v1.0.1', '1.0.0').ok);
    assert.ok(!cr.checkVersion('', '1.0.0').ok);
    assert.ok(!cr.checkVersion(undefined, '1.0.0').ok);
  });

  it('accepts the expected package contents', () => {
    const r = cr.checkVsixEntries(GOOD);
    assert.deepStrictEqual(r, { ok: true, unexpected: [], missing: [] });
  });

  it('rejects sources, tests, tooling, secrets and source maps', () => {
    for (const bad of [
      'extension/src/extension.ts',
      'extension/test/unit/a.test.js',
      'extension/dev/preview.html',
      'extension/node_modules/chart.js/package.json',
      'extension/.vscode-test/x',
      'extension/CLAUDE.md',
      'extension/.claude/settings.json',
      'extension/dist/extension.js.map',
      'extension/.env',
      'extension/scripts/make-icon.js',
      'extension/media/screenshot-stocks.png',
    ]) {
      const r = cr.checkVsixEntries([...GOOD, bad]);
      assert.ok(!r.ok && r.unexpected.includes(bad), bad);
    }
  });

  it('reports missing runtime files and docs', () => {
    const r = cr.checkVsixEntries(GOOD.filter((n) => n !== 'extension/dist/extension.js' && n !== 'extension/LICENSE.txt' && n !== 'extension/media/icon.png'));
    assert.ok(!r.ok);
    assert.deepStrictEqual(r.missing.sort(), ['LICENSE', 'extension/dist/extension.js', 'extension/media/icon.png']);
  });

  it('reads the file names of a zip', () => {
    const names = ['a.txt', 'dir/b.txt'];
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const name of names) {
      const data = zlib.deflateRawSync(Buffer.from('x'));
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(name.length, 26);
      const entry = Buffer.concat([lh, Buffer.from(name), data]);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([ch, Buffer.from(name)]));
      local.push(entry);
      offset += entry.length;
    }
    const dir = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(names.length, 8);
    eocd.writeUInt16LE(names.length, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stonks-zip-')), 't.zip');
    fs.writeFileSync(file, Buffer.concat([...local, dir, eocd]));
    try {
      assert.deepStrictEqual(cr.listZipEntries(file), names);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
