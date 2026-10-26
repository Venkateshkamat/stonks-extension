import * as assert from 'assert';
import { fixture } from '../helpers';
import { setup } from '../controllerSetup';
import { buildPanelModel } from '../../src/panel/model';
import { buildPinItems, parsePinKey } from '../../src/portfolio/pins';
import { buildPinStatusModel } from '../../src/statusBarModel';
import { COINS, findMarketDef, INDICES } from '../../src/types';

const coinRoutes = [
  ...COINS.map((c) => [`/chart/${c.symbol}?range=1d`, { body: fixture('yahoo/BTC-USD.1d.json') }] as const),
  ['/chart/', { status: 500 }],
] as const;

describe('coin market defs', () => {
  it('registers BTC, ETH, SOL, BNB and XRP as USD-priced Yahoo X-USD symbols in the Crypto region', () => {
    assert.deepStrictEqual(COINS.map((c) => c.name), ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
    assert.deepStrictEqual(COINS.map((c) => c.symbol), ['BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD', 'XRP-USD']);
    for (const c of COINS) {
      assert.strictEqual(c.region, 'Crypto');
      assert.strictEqual(c.currency, 'USD');
    }
  });

  it('findMarketDef resolves coins as well as indices, and nothing else', () => {
    assert.strictEqual(findMarketDef('ETH-USD')?.name, 'ETH');
    assert.strictEqual(findMarketDef('^NSEI')?.name, 'NIFTY 50');
    assert.strictEqual(findMarketDef('DOGE-USD'), undefined);
    for (const i of INDICES) assert.strictEqual(i.currency, undefined, 'index levels are plain numbers');
  });

  it('coin pin keys are ordinary market pins', () => {
    assert.deepStrictEqual(parsePinKey('m:BTC-USD'), { kind: 'market', symbol: 'BTC-USD' });
  });
});

describe('coin watch-list in the controller', () => {
  it('fetches coin quotes only while requested, using the rolling 24h change', async () => {
    const { controller, fetch } = setup({ routes: coinRoutes });
    await controller.refresh();
    assert.ok(fetch.calls.every((c) => !c.includes('-USD')), 'no coin fetch while the Crypto view is closed');
    controller.setIncludeCoins(true);
    await controller.refresh();
    for (const c of COINS) assert.ok(fetch.calls.some((u) => u.includes(`/chart/${c.symbol}?`)), `${c.symbol} fetched`);
    assert.strictEqual(controller.snapshot.coins.length, 5);
    assert.ok(controller.snapshot.coins.every((r) => r.quote && r.quote.price > 0));
    assert.deepStrictEqual(controller.snapshot.indices, [], 'indices stay off');
    controller.dispose();
  });

  it('setWatchlists swaps indices for coins and drops the data that is switched off', async () => {
    const { controller, fetch } = setup({ routes: [...coinRoutes.slice(0, -1), ['%5E', { body: fixture('yahoo/GSPC.1d.json') }], ['/chart/', { status: 500 }]] });
    controller.setWatchlists({ indices: true });
    await controller.refresh();
    assert.strictEqual(controller.snapshot.indices.length, 6);
    controller.setWatchlists({ indices: false, coins: true });
    assert.deepStrictEqual(controller.snapshot.indices, [], 'cleared at once');
    await controller.refresh();
    assert.strictEqual(controller.snapshot.coins.length, 5);
    assert.ok(controller.snapshot.coins.every((r) => r.quote));
    const before = fetch.calls.length;
    controller.setWatchlists({ coins: false });
    assert.deepStrictEqual(controller.snapshot.coins, []);
    await controller.refresh();
    assert.ok(fetch.calls.slice(before).every((c) => !c.includes('-USD') && !c.includes('%5E')), 'nothing fetched once both are off');
    controller.dispose();
  });

  it('reports a failed coin as a per-row error and in the snapshot errors', async () => {
    const { controller } = setup({ routes: [['/chart/ETH-USD', { status: 500 }], ...coinRoutes] });
    controller.setIncludeCoins(true);
    await controller.refresh();
    const eth = controller.snapshot.coins.find((r) => r.index.name === 'ETH')!;
    assert.ok(eth.error && !eth.quote);
    assert.ok(controller.snapshot.errors.some((e) => e.scope === 'index' && e.label === 'ETH'));
    const model = buildPanelModel(controller.snapshot, { view: 'crypto' });
    assert.strictEqual(model.indices[0].items.find((i) => i.name === 'ETH')!.level.text, '--');
    controller.dispose();
  });

  it('a pinned coin is fetched without the Crypto view and shows a $ price in the status bar', async () => {
    const { controller, pins, fetch } = setup({ routes: coinRoutes });
    await pins.add({ kind: 'market', symbol: 'ETH-USD' });
    await controller.refresh();
    assert.ok(fetch.calls.some((c) => c.includes('/chart/ETH-USD')));
    assert.ok(fetch.calls.every((c) => !c.includes('/chart/SOL-USD')), 'only the pinned coin');
    assert.deepStrictEqual(controller.snapshot.coins, []);
    const item = controller.snapshot.pins[0];
    assert.strictEqual(item.label, 'ETH');
    assert.strictEqual(item.currency, 'USD');
    const sb = buildPinStatusModel(item);
    assert.match(sb.text, /^ETH \$[\d,]+\.\d{2} [+-]?\d+\.\d{2}%$/);
    assert.match(sb.tooltip, /Price: \$/);
    controller.dispose();
  });

  it('buildPinItems labels a coin pin by its short name', () => {
    const btc = COINS[0];
    const [i] = buildPinItems([{ kind: 'market', symbol: btc.symbol }], [], []);
    assert.strictEqual(i.label, 'BTC');
    assert.strictEqual(i.currency, 'USD');
  });
});
