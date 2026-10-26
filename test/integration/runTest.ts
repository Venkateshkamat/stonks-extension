/**
 * Launcher: runs the in-host suite (./suite) inside an INSTALLED VS Code or Cursor via @vscode/test-electron.
 * Nothing is downloaded. Usage: node out/test/integration/runTest.js [vscode|cursor]
 *
 * Isolation: a private --user-data-dir and --extensions-dir under .vscode-test/ plus --disable-extensions, so the
 * user's real profile, settings and extensions are never touched and a running instance does not conflict.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import { runTests } from '@vscode/test-electron';

/** Drops known-harmless host chatter (the editors' built-in AI/agent services log constantly) so test output stays readable. */
const NOISE = /^(\[AgentHost\]|\[ChatModelSelection\]|Unknown channel:)/;
function quietStdout(): Writable {
  let pending = '';
  return new Writable({
    write(chunk, _enc, cb) {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) if (!NOISE.test(l)) process.stdout.write(l + '\n');
      cb();
    },
    final(cb) {
      if (pending && !NOISE.test(pending)) process.stdout.write(pending + '\n');
      cb();
    },
  });
}

type Target = 'vscode' | 'cursor';

const EXECUTABLES: Record<Target, string> = {
  vscode: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  cursor: '/Applications/Cursor.app/Contents/MacOS/Cursor',
};

async function main(): Promise<void> {
  const target = (process.argv[2] ?? 'vscode') as Target;
  if (!(target in EXECUTABLES)) throw new Error(`Unknown target "${target}" (expected vscode or cursor)`);
  const executable = process.env.STONKS_EDITOR_PATH ?? EXECUTABLES[target];
  if (!fs.existsSync(executable)) throw new Error(`${target} executable not found at ${executable}`);

  const repo = path.resolve(__dirname, '..', '..', '..');
  // Keep these paths short: the editor's IPC socket lives inside user-data-dir and macOS limits socket paths to ~100 chars.
  const root = path.join(repo, '.vscode-test');
  const tag = target === 'vscode' ? 'vs' : 'cu';
  const userData = path.join(root, `ud-${tag}`);
  const extensions = path.join(root, `ext-${tag}`);
  const workspace = path.join(root, `ws-${tag}`);
  for (const d of [userData, extensions, workspace]) fs.mkdirSync(d, { recursive: true });

  // Electron apps launched from an Electron-hosted terminal can inherit this and would then run as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;

  console.log(`[stonks-it] target=${target} executable=${executable}`);
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: repo,
    stdout: quietStdout(),
    extensionTestsPath: path.join(__dirname, 'suite', 'index'),
    extensionTestsEnv: { STONKS_INTEGRATION_TEST: '1', STONKS_IT_TARGET: target },
    launchArgs: [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--disable-extensions'],
  });
}

main().catch((e) => {
  console.error('[stonks-it] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
