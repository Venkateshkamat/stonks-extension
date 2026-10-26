import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const root = path.join(__dirname, '..', '..', '..');
const wf = parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8'));
const steps: Array<{ name: string; run?: string; if?: string; env?: Record<string, string>; uses?: string; with?: Record<string, unknown> }> = wf.jobs.publish.steps;
const step = (re: RegExp) => {
  const s = steps.find((x) => re.test(x.name));
  assert.ok(s, `no step matching ${re}`);
  return s;
};

describe('publish workflow', () => {
  it('runs on a published release (not pre-releases) or manually with a tag', () => {
    assert.deepStrictEqual(wf.on.release.types, ['published']);
    assert.strictEqual(wf.on.workflow_dispatch.inputs.tag.required, true);
    assert.ok(String(wf.jobs.publish.if).includes('prerelease'));
  });

  it('uses least privilege and the same tag never publishes twice at once', () => {
    assert.deepStrictEqual(wf.permissions, { contents: 'write' });
    assert.strictEqual(wf.concurrency['cancel-in-progress'], false);
  });

  it('builds on Node 22, runs the unit tests and checks the tag and package before publishing', () => {
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node'));
    assert.strictEqual(node?.with?.['node-version'], 22);
    assert.strictEqual(step(/Install/).run, 'npm ci');
    assert.strictEqual(step(/Compile/).run, 'npm run compile');
    assert.strictEqual(step(/Unit tests/).run, 'npm test');
    assert.ok(step(/tag matches/).run?.includes('check-release.js version'));
    assert.ok(step(/package contents/).run?.includes('check-release.js vsix'));
    const names = steps.map((s) => s.name);
    assert.ok(names.indexOf('Unit tests') < names.findIndex((n) => /Publish to the VS Code/.test(n)));
    assert.ok(names.findIndex((n) => /package contents/.test(n)) < names.findIndex((n) => /Publish to the VS Code/.test(n)));
  });

  it('publishes to both stores independently, skipping versions that exist, then attaches the vsix', () => {
    const vsce = step(/VS Code Marketplace/);
    const ovsx = step(/Open VSX/);
    assert.ok(vsce.run?.includes('vsce publish --packagePath') && vsce.run.includes('--skip-duplicate'));
    assert.ok(ovsx.run?.includes('ovsx publish') && ovsx.run.includes('--skip-duplicate'));
    assert.strictEqual(vsce.env?.VSCE_PAT, '${{ secrets.VSCE_PAT }}');
    assert.strictEqual(ovsx.env?.OVSX_PAT, '${{ secrets.OVSX_PAT }}');
    // Independent: each runs even when the other failed.
    assert.ok(vsce.if?.includes('!cancelled()') && ovsx.if?.includes('!cancelled()'));
    assert.ok(step(/Attach/).run?.includes('gh release upload'));
  });

  it('never creates tags or releases or creates an Open VSX namespace', () => {
    const all = steps.map((s) => s.run ?? '').join('\n');
    assert.ok(!/git tag|git push|gh release create|create-namespace/.test(all));
  });
});
