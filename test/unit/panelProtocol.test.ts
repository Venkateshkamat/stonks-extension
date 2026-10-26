import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildHtml, makeNonce, parseWebviewMessage } from '../../src/panel/protocol';

describe('parseWebviewMessage', () => {
  it('accepts ready and the simple actions', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
    for (const action of ['add', 'refresh', 'toggleHide']) {
      assert.deepStrictEqual(parseWebviewMessage({ type: 'action', action }), { type: 'action', action });
    }
  });

  it('accepts diag and error reports from the webview, normalising their fields', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'diag', chartLib: true, chartRendered: false, holdingRows: 3, currencyButtons: 2, rangeButtons: 3 }), { type: 'diag', chartLib: true, chartRendered: false, holdingRows: 3, currencyButtons: 2, rangeButtons: 3 });
    assert.deepStrictEqual(parseWebviewMessage({ type: 'diag', chartLib: 'yes' }), { type: 'diag', chartLib: false, chartRendered: false, holdingRows: 0, currencyButtons: 0, rangeButtons: 0 });
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

  it('sets a strict CSP with a nonce and no remote origins', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("script-src 'nonce-NONCE123'"));
    assert.ok(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"));
    assert.ok(!/https?:\/\/(?!x\.vscode-cdn\.net)/.test(html));
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

  it('panel.js never uses innerHTML, eval or inline style attributes', () => {
    const js = fs.readFileSync(path.join(dir, 'panel.js'), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/.test(js));
    assert.ok(!/setAttribute\(\s*['"]style['"]/.test(js));
  });
});
