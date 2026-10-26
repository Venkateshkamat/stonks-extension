import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

describe('package manifest', () => {
  it('declares the expected identity and engine', () => {
    assert.strictEqual(pkg.name, 'stonks');
    assert.strictEqual(pkg.publisher, 'venkateshkamat');
    assert.strictEqual(pkg.engines.vscode, '^1.85.0');
    assert.deepStrictEqual(pkg.activationEvents, ['onStartupFinished']);
  });

  it('contributes all stonks commands under the Stonks category', () => {
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command).sort();
    assert.deepStrictEqual(ids, [
      'stonks.addHolding',
      'stonks.clearFinnhubApiKey',
      'stonks.editHolding',
      'stonks.openPortfolio',
      'stonks.refresh',
      'stonks.removeHolding',
      'stonks.setBaseCurrency',
      'stonks.setFinnhubApiKey',
      'stonks.setRefreshInterval',
      'stonks.toggleHideAmounts',
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
