import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commandCodeRuntime } from '@/modules/providers/list/command-code/command-code-runtime.provider.js';
import { CommandCodeSessionsProvider } from '@/modules/providers/list/command-code/command-code-sessions.provider.js';

const sessionsProvider = new CommandCodeSessionsProvider();

const runtimeContext = {
  resolveProviderSessionId: (sessionId: string) => sessionId || null,
  resolveResumeModel: async (_sessionId: string, requestedModel?: string) => requestedModel || undefined,
  normalizeMessage: (raw: unknown, sessionId: string | null) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

/**
 * Stands in for the CLI on PATH and records the argv it was launched with, so a
 * test can assert on the prompt the run would really receive.
 */
async function createFakeCommandCodeExecutable(binDir: string) {
  const script = `
const capturePath = process.env.COMMAND_CODE_ARGS_CAPTURE;
if (capturePath) {
  require('node:fs').writeFileSync(capturePath, JSON.stringify({ args: process.argv.slice(2) }));
}
console.log(JSON.stringify({ type: 'event', event: { type: 'run_end' } }));
`;
  await writeFile(path.join(binDir, 'command-code.js'), script, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(
      path.join(binDir, 'command-code.cmd'),
      '@echo off\r\nnode "%~dp0command-code.js" %*\r\n',
      'utf8',
    );
    return;
  }

  const commandPath = path.join(binDir, 'command-code');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/command-code.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

type Fixture = {
  tempRoot: string;
  storeDir: string;
  capturePath: string;
  /** Where the run's attachment copies land, for assertions and cleanup. */
  stagedDir: string;
  restore: () => void;
};

/**
 * A fixture home holding one stored image, one stored file and one file
 * *outside* the upload store — the last one only to prove it is never handed to
 * the CLI.
 *
 * Only the home dir is redirected: test files run in parallel, so pointing the
 * OS temp dir at a folder this fixture deletes could take another file's
 * fixtures with it. The staged copies therefore land in the real temp dir,
 * under a folder named after this fixture's session.
 */
async function createAttachmentFixture(): Promise<Fixture> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'command-code-attachments-'));
  const storeDir = path.join(tempRoot, '.cloudcli', 'assets');
  await mkdir(storeDir, { recursive: true });
  await writeFile(path.join(storeDir, '1-shot.png'), 'PNG');
  await writeFile(path.join(storeDir, '1-brief.pdf'), 'PDF');
  await writeFile(path.join(tempRoot, 'outside.txt'), 'PRIVATE');

  const originalHomedir = os.homedir;
  (os as any).homedir = () => tempRoot;

  return {
    tempRoot,
    storeDir,
    capturePath: path.join(tempRoot, 'command-code-args.json'),
    stagedDir: path.join(os.tmpdir(), 'cloudcli-attachments', 'runtime-attachments'),
    restore: () => {
      (os as any).homedir = originalHomedir;
    },
  };
}

/** The shape the runtime writes through; typed because this test file is checked. */
type RuntimeWriter = {
  userId: string | null;
  sessionId: string | null;
  send(message: unknown): void;
  setSessionId(sessionId: string): void;
};

/** Runs the runtime against the fake CLI and returns the argv it recorded. */
async function runAndCapturePrompt(
  fixture: Fixture,
  options: Record<string, unknown>,
): Promise<string> {
  const tempRoot = await mkdtemp(path.join(fixture.tempRoot, 'bin-'));
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  const previousCapture = process.env.COMMAND_CODE_ARGS_CAPTURE;
  const writer: RuntimeWriter = {
    userId: null,
    sessionId: null,
    send() {},
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeCommandCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.COMMAND_CODE_ARGS_CAPTURE = fixture.capturePath;

    await commandCodeRuntime.run('Describe the attachment', {
      sessionId: 'runtime-attachments',
      cwd: fixture.tempRoot,
      ...options,
    }, writer, runtimeContext);

    const capture = JSON.parse(await readFile(fixture.capturePath, 'utf8'));
    return capture.args[capture.args.length - 1];
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousCapture === undefined) {
      delete process.env.COMMAND_CODE_ARGS_CAPTURE;
    } else {
      process.env.COMMAND_CODE_ARGS_CAPTURE = previousCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('spawnCommandCode hands attachments to the CLI as a temp-dir path list', { concurrency: false }, async () => {
  const fixture = await createAttachmentFixture();

  try {
    const prompt = await runAndCapturePrompt(fixture, {
      images: [{ path: '1-shot.png', name: 'shot.png' }],
      files: [{ path: '1-brief.pdf', name: 'brief.pdf' }],
    });

    assert.match(prompt, /<images_input>/);
    assert.match(prompt, /<files_input>/);
    assert.match(prompt, /1-shot\.png/);
    assert.match(prompt, /1-brief\.pdf/);

    // The path list must point at the staged copies: Command Code confines
    // reads to the workspace, and the upload store is outside it.
    assert.match(prompt, new RegExp(`${path.sep}cloudcli-attachments${path.sep}`));
    assert.equal(prompt.includes(fixture.storeDir), false);

    // The copy is really there for the agent to read.
    assert.equal(await readFile(path.join(fixture.stagedDir, '1-shot.png'), 'utf8'), 'PNG');
  } finally {
    fixture.restore();
    await rm(fixture.tempRoot, { recursive: true, force: true });
    await rm(fixture.stagedDir, { recursive: true, force: true });
  }
});

test('spawnCommandCode never stages a path from outside the upload store', { concurrency: false }, async () => {
  const fixture = await createAttachmentFixture();

  try {
    const prompt = await runAndCapturePrompt(fixture, {
      images: [{ path: path.join(fixture.tempRoot, 'outside.txt') }],
    });

    // Nothing was staged, so the turn runs without the attachment rather than
    // handing the agent a copy of a file it was never trusted with.
    assert.equal(prompt.includes('<images_input>'), false);
    assert.equal(prompt.includes('outside.txt'), false);
  } finally {
    fixture.restore();
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('spawnCommandCode leaves an attachment-free prompt exactly as given', { concurrency: false }, async () => {
  const fixture = await createAttachmentFixture();

  try {
    const prompt = await runAndCapturePrompt(fixture, {});

    assert.equal(prompt, 'Describe the attachment');
  } finally {
    fixture.restore();
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
});
