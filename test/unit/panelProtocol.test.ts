import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildHtml, makeNonce, parseWebviewMessage, TRADINGVIEW_FRAME_SRC, TRADINGVIEW_SCRIPT_SRC } from '../../src/panel/protocol';

describe('parseWebviewMessage', () => {
  it('accepts ready and the simple actions', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
    for (const action of ['add', 'refresh', 'toggleHide']) {
      assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action }), { type: 'action', action });
    }
  });

  it('accepts diag and error reports from the webview, normalising their fields', () => {
    const full = {
      type: 'diag',
      chartLib: true,
      chartRendered: false,
      holdingRows: 3,
      currencyButtons: 2,
      rangeButtons: 3,
      pinButtons: 9,
      viewButtons: 3,
      view: 'heatmap',
      marketRows: 5,
      heatmapContainer: true,
      heatmapIframe: true,
      heatmapLoaded: false,
      heatmapSource: 'SPX500',
      cspViolations: ['style-src inline'],
    };
    assert.deepStrictEqual(parseWebviewMessage(full), full);
    assert.deepStrictEqual(parseWebviewMessage({ type: 'diag', chartLib: 'yes' }), {
      type: 'diag',
      chartLib: false,
      chartRendered: false,
      holdingRows: 0,
      currencyButtons: 0,
      rangeButtons: 0,
      pinButtons: 0,
      viewButtons: 0,
      view: '',
      marketRows: 0,
      heatmapContainer: false,
      heatmapIframe: false,
      heatmapLoaded: false,
      heatmapSource: '',
      cspViolations: [],
    });
    const messy = parseWebviewMessage({ type: 'diag', cspViolations: ['a', 3, null, 'x'.repeat(500), ...Array(20).fill('z')] });
    assert.ok(messy?.type === 'diag' && messy.cspViolations.length === 10 && messy.cspViolations[1].length === 200, 'only strings, capped');
    assert.deepStrictEqual(parseWebviewMessage({ type: 'error', message: 'boom' }), { type: 'error', message: 'boom' });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'error', message: 42 }), { type: 'error', message: 'unknown error' });
    const long = parseWebviewMessage({ type: 'error', message: 'x'.repeat(5000) });
    assert.ok(long?.type === 'error' && long.message.length === 500);
  });

  it('requires a string id for edit / remove', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action: 'edit', id: 'abc' }), { type: 'action', action: 'edit', id: 'abc' });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action: 'remove', id: 'abc', extra: 1 }), { type: 'action', action: 'remove', id: 'abc' });
    assert.strictEqual(parseWebviewMessage({ type: 'action', action: 'edit' }), undefined);
    assert.strictEqual(parseWebviewMessage({ type: 'action', action: 'remove', id: 5 }), undefined);
    assert.strictEqual(parseWebviewMessage({ type: 'action', action: 'edit', id: '' }), undefined);
  });

  it('accepts only INR / USD for setCurrency', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'setCurrency', currency: 'USD' }), { type: 'setCurrency', currency: 'USD' });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'setCurrency', currency: 'INR', x: 1 }), { type: 'setCurrency', currency: 'INR' });
    for (const bad of ['EUR', '', 5, undefined, null]) assert.strictEqual(parseWebviewMessage({ type: 'setCurrency', currency: bad }), undefined);
  });

  it('accepts only 1D / 15D / 30D for setRange', () => {
    for (const range of ['1D', '15D', '30D']) assert.deepStrictEqual(parseWebviewMessage({ type: 'setRange', range, x: 1 }), { type: 'setRange', range });
    for (const bad of ['7D', '1d', '', 30, undefined, null]) assert.strictEqual(parseWebviewMessage({ type: 'setRange', range: bad }), undefined);
  });

  it('accepts only known views for setView', () => {
    for (const view of ['stocks', 'crypto', 'heatmap']) assert.deepStrictEqual(parseWebviewMessage({ type: 'setView', view, x: 1 }), { type: 'setView', view });
    for (const bad of ['Stocks', 'bonds', '', 1, undefined, null, {}]) assert.strictEqual(parseWebviewMessage({ type: 'setView', view: bad }), undefined);
  });

  it('accepts only known heatmap sources for setHeatmapSource', () => {
    for (const source of ['SPX500', 'NASDAQ100', 'DJDJI', 'SENSEX', 'CRYPTO']) {
      assert.deepStrictEqual(parseWebviewMessage({ type: 'setHeatmapSource', source, x: 1 }), { type: 'setHeatmapSource', source });
    }
    for (const bad of ['NIFTY50', 'spx500', '', 5, undefined, null, '<script>']) assert.strictEqual(parseWebviewMessage({ type: 'setHeatmapSource', source: bad }), undefined);
  });

  it('add carries an optional stocks / crypto group and ignores anything else', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action: 'add' }), { type: 'action', action: 'add' });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action: 'add', group: 'crypto' }), { type: 'action', action: 'add', group: 'crypto' });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action: 'add', group: 'stocks' }), { type: 'action', action: 'add', group: 'stocks' });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action: 'add', group: 'evil' }), { type: 'action', action: 'add' });
  });

  it('rejects anything unexpected', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, { type: 'action' }, { type: 'action', action: 'format-disk' }, { type: 'nope' }]) {
      assert.strictEqual(parseWebviewMessage(bad), undefined);
    }
  });
});

describe('buildHtml', () => {
  const html = buildHtml({
    cspSource: 'https://x.vscode-cdn.net',
    nonce: 'NONCE123',
    styleUri: 'https://x.vscode-cdn.net/panel.css',
    chartUri: 'https://x.vscode-cdn.net/chart.umd.min.js',
    scriptUri: 'https://x.vscode-cdn.net/panel.js',
  });

  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `));

  it('sets a strict CSP: nonce for our scripts, no unsafe-inline / unsafe-eval, no wildcards', () => {
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(directive('script-src')?.includes("'nonce-NONCE123'"));
    assert.ok(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'") && !csp.includes('*'));
    assert.ok(!directive('connect-src'), 'no network access for our own code');
    assert.strictEqual(directive('style-src'), 'style-src https://x.vscode-cdn.net', 'styles stay local');
  });

  it('opens up only what the TradingView heatmap widget needs: its loader script and its widget iframe', () => {
    assert.strictEqual(directive('script-src'), `script-src 'nonce-NONCE123' ${TRADINGVIEW_SCRIPT_SRC}`);
    assert.strictEqual(TRADINGVIEW_SCRIPT_SRC, 'https://s3.tradingview.com');
    assert.strictEqual(directive('frame-src'), `frame-src ${TRADINGVIEW_FRAME_SRC.join(' ')}`);
    assert.deepStrictEqual(TRADINGVIEW_FRAME_SRC, ['https://www.tradingview-widget.com', 'https://s.tradingview.com']);
    const origins = new Set(csp.match(/https:\/\/[a-z0-9.-]+/g));
    assert.deepStrictEqual([...origins].sort(), ['https://s.tradingview.com', 'https://s3.tradingview.com', 'https://www.tradingview-widget.com', 'https://x.vscode-cdn.net']);
    // The page itself references only the local resources.
    assert.ok(!/(src|href)="https?:\/\/(?!x\.vscode-cdn\.net)/.test(html));
  });

  it('nonces every script and has no inline script or style', () => {
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    assert.strictEqual(scripts.length, 2);
    for (const s of scripts) assert.ok(s.includes('nonce="NONCE123"') && s.includes('src="'));
    assert.ok(!/<style/i.test(html));
    assert.ok(!/ style=/i.test(html));
  });
});

describe('makeNonce', () => {
  it('produces 32 alphanumeric characters that differ between calls', () => {
    const a = makeNonce();
    assert.ok(/^[A-Za-z0-9]{32}$/.test(a));
    assert.notStrictEqual(a, makeNonce());
  });
});

describe('webview assets', () => {
  const dir = path.join(__dirname, '..', '..', '..', 'media');

  it('ship panel.js and panel.css', () => {
    assert.ok(fs.existsSync(path.join(dir, 'panel.js')));
    assert.ok(fs.existsSync(path.join(dir, 'panel.css')));
  });

  it('panel.js loads the TradingView widget scripts only from the allowed script origin', () => {
    const js = fs.readFileSync(path.join(dir, 'panel.js'), 'utf8');
    const urls = js.match(/https:\/\/[a-z0-9.\-]+[^\s'"]*/g) ?? [];
    const scripts = urls.filter((u) => u.endsWith('.js'));
    assert.strictEqual(scripts.length, 2);
    for (const u of scripts) assert.ok(u.startsWith(`${TRADINGVIEW_SCRIPT_SRC}/external-embedding/embed-widget-`), u);
  });

  it('panel.js never uses innerHTML, eval or inline style attributes', () => {
    const js = fs.readFileSync(path.join(dir, 'panel.js'), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/.test(js));
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(js));
  });
});
