import * as assert from 'assert';
import { LastValue } from '../../src/panel/lastValue';
import { changedFields, StatusBarModel } from '../../src/statusBarModel';

describe('LastValue', () => {
  it('reports a value as changed only when it differs from the previous one', () => {
    const v = new LastValue();
    assert.strictEqual(v.changed({ a: 1, b: [1, 2] }), true);
    assert.strictEqual(v.changed({ a: 1, b: [1, 2] }), false, 'a deep-equal copy is not a change');
    assert.strictEqual(v.changed({ a: 1, b: [1, 3] }), true);
    v.reset();
    assert.strictEqual(v.changed({ a: 1, b: [1, 3] }), true, 'after a reset (webview reloaded) everything is sent again');
  });
});

describe('changedFields', () => {
  const m: StatusBarModel = { text: '$(graph) +1.00%', tooltip: 'Stonks', tone: 'gain' };

  it('returns everything for an item that has shown nothing yet', () => {
    assert.deepStrictEqual(changedFields({}, m), m);
  });

  it('returns nothing when the item already shows this model', () => {
    assert.deepStrictEqual(changedFields({ ...m }, { ...m }), {});
  });

  it('returns only the fields that changed', () => {
    assert.deepStrictEqual(changedFields(m, { ...m, tooltip: 'Stonks\nUpdated 10:31' }), { tooltip: 'Stonks\nUpdated 10:31' });
    assert.deepStrictEqual(changedFields(m, { ...m, text: '$(graph) +1.10%', tone: 'gain' }), { text: '$(graph) +1.10%' });
    assert.deepStrictEqual(changedFields(m, { ...m, tone: 'loss' }), { tone: 'loss' });
  });
});
