import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

describe('package manifest', () => {
  it('declares the expected identity and engine', () => {
    assert.strictEqual(pkg.name, 'stonks-watch');
    assert.strictEqual(pkg.publisher, 'venkateshkamat');
    assert.strictEqual(pkg.engines.vscode, '^1.85.0');
    assert.deepStrictEqual(pkg.activationEvents, ['onStartupFinished']);
  });

  it('has the marketplace metadata', () => {
    assert.strictEqual(pkg.version, '1.0.0');
    assert.strictEqual(pkg.displayName, 'Stonks Watch: Stocks & Crypto');
    assert.strictEqual(pkg.license, 'MIT');
    assert.strictEqual(pkg.author, 'Venkatesh Kamat');
    assert.strictEqual(pkg.repository.url, 'https://github.com/Venkateshkamat/stonks-extension.git');
    assert.ok(pkg.homepage && pkg.bugs.url);
    assert.ok(pkg.keywords.length > 5);
    assert.strictEqual(pkg.capabilities.untrustedWorkspaces.supported, true);
    assert.strictEqual(pkg.capabilities.virtualWorkspaces, true);
  });

  it('packages an explicit file allowlist that exists on disk, plus a PNG icon', () => {
    const root = path.join(__dirname, '..', '..', '..');
    assert.ok(Array.isArray(pkg.files));
    for (const f of ['media/icon.png', 'README.md', 'CHANGELOG.md', 'LICENSE', 'dist/extension.js']) assert.ok(pkg.files.includes(f), f);
    // dist/ is a build output, so only the sources of the allowlist are checked here.
    for (const f of pkg.files.filter((x: string) => !x.startsWith('dist/'))) assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
    assert.strictEqual(pkg.icon, 'media/icon.png');
    const png = fs.readFileSync(path.join(root, pkg.icon));
    assert.strictEqual(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(png.readUInt32BE(16) >= 128 && png.readUInt32BE(20) >= 128, 'icon is at least 128x128');
    assert.ok(!fs.existsSync(path.join(root, '.vscodeignore')), 'the files allowlist replaces .vscodeignore');
  });

  it('contributes all stonks commands under the Stonks category', () => {
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command).sort();
    assert.deepStrictEqual(ids, [
      'stonks.addHolding',
      'stonks.clearFinnhubApiKey',
      'stonks.editHolding',
      'stonks.openPortfolio',
      'stonks.pinTicker',
      'stonks.refresh',
      'stonks.removeHolding',
      'stonks.setBaseCurrency',
      'stonks.setFinnhubApiKey',
      'stonks.setRefreshInterval',
      'stonks.toggleHideAmounts',
      'stonks.unpinTicker',
    ]);
    for (const c of pkg.contributes.commands) assert.strictEqual(c.category, 'Stonks');
  });

  it('contributes the stonks.* settings with spec defaults', () => {
    const p = pkg.contributes.configuration.properties;
    assert.strictEqual(p['stonks.baseCurrency'].default, 'INR');
    assert.deepStrictEqual(p['stonks.baseCurrency'].enum, ['INR', 'USD']);
    assert.strictEqual(p['stonks.refreshIntervalSeconds'].default, 60);
    assert.strictEqual(p['stonks.refreshIntervalSeconds'].minimum, 15);
    assert.strictEqual(p['stonks.hideAmounts'].default, false);
  });
});
