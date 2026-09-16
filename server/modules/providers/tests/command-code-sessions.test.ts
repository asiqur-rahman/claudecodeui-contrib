import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandCodeSessionsProvider } from '@/modules/providers/list/command-code/command-code-sessions.provider.js';

const SESSION_ID = 'command-code-session';
const TOOL_CALL_ID = 'call_00_GQe4aOlQbO1rFj66G22n1432';
const SHELL_INPUT = { command: 'echo hello-from-cc', description: 'Echo test string' };

/**
 * The frames these tests feed in are copied from a real
 * `command-code -p --output-format json` run — the exact invocation the provider
 * runtime spawns. One tool call is spread across several events and only
 * `tool_queued` carries the input, so the shape of each frame is the contract
 * under test rather than an invented fixture.
 */
const eventFrame = (event: Record<string, unknown>) => ({ type: 'event', event });

// ---------------------------------------------------------------- live events

test('command code live: the queued frame supplies the tool input', () => {
  const provider = new CommandCodeSessionsProvider();

  const messages = provider.normalizeMessage(eventFrame({
    type: 'tool_queued',
    toolCallId: TOOL_CALL_ID,
    toolName: 'shell_command',
    input: SHELL_INPUT,
  }), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_use');
  assert.equal(messages[0].toolName, 'shell_command');
  assert.equal(messages[0].toolId, TOOL_CALL_ID);
  assert.deepEqual(messages[0].toolInput, SHELL_INPUT);
});

test('command code live: tool_running does not draw a second row for the same call', () => {
  const provider = new CommandCodeSessionsProvider();

  // Carries no input — reading one off this frame is what left every row empty.
  const messages = provider.normalizeMessage(eventFrame({
    type: 'tool_running',
    toolCallId: TOOL_CALL_ID,
    toolName: 'shell_command',
    description: null,
  }), SESSION_ID);

  assert.deepEqual(messages, []);
});

test('command code live: a completed call attaches its output to the queued row', () => {
  const provider = new CommandCodeSessionsProvider();

  const messages = provider.normalizeMessage(eventFrame({
    type: 'tool_completed',
    toolCallId: TOOL_CALL_ID,
    toolName: 'shell_command',
    result: [{ type: 'text', text: 'hello-from-cc\n' }],
    deferred: false,
  }), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, TOOL_CALL_ID);
  assert.equal(messages[0].content, 'hello-from-cc\n');
  assert.equal(messages[0].isError, false);
});

test('command code live: an errored call reports its error text', () => {
  const provider = new CommandCodeSessionsProvider();

  const messages = provider.normalizeMessage(eventFrame({
    type: 'tool_errored',
    toolCallId: TOOL_CALL_ID,
    toolName: 'shell_command',
    error: 'spawn failed',
  }), SESSION_ID);

  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].content, 'spawn failed');
  assert.equal(messages[0].isError, true);
});

test('command code live: a denied call closes the row it opened', () => {
  const provider = new CommandCodeSessionsProvider();

  // Print mode without `--yolo` denies shell tools, and a denial is terminal:
  // without a result the row stays spinning for the rest of the run.
  const messages = provider.normalizeMessage(eventFrame({
    type: 'tool_denied',
    toolCallId: TOOL_CALL_ID,
    toolName: 'shell_command',
  }), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, TOOL_CALL_ID);
  assert.equal(messages[0].isError, true);
  assert.ok(messages[0].content);
});

test('command code live: a blocked call closes the row it opened', () => {
  const provider = new CommandCodeSessionsProvider();

  // A pre-tool hook blocking a call is terminal for it: the CLI emits no
  // running/completed event, so the queued row has nothing else to close it.
  const messages = provider.normalizeMessage(eventFrame({
    type: 'tool_hook_blocked',
    toolCallId: TOOL_CALL_ID,
    toolName: 'shell_command',
    hookOutput: 'Blocked: writes are frozen during the freeze window.',
  }), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, TOOL_CALL_ID);
  assert.equal(messages[0].content, 'Blocked: writes are frozen during the freeze window.');
  assert.equal(messages[0].isError, true);
});

// ---------------------------------------------------------------- transcripts

test('command code history: a persisted call keeps its input and pairs with its result', () => {
  const provider = new CommandCodeSessionsProvider();

  const messages = provider.normalizeMessage({
    type: 'message',
    id: 'row-1',
    timestamp: '2026-09-16T10:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: TOOL_CALL_ID, name: 'shell_command', input: SHELL_INPUT },
        { type: 'tool_result', tool_use_id: TOOL_CALL_ID, content: [{ type: 'text', text: 'hello-from-cc\n' }] },
      ],
    },
  }, SESSION_ID);

  const call = messages.find((message) => message.kind === 'tool_use');
  const result = messages.find((message) => message.kind === 'tool_result');

  assert.deepEqual(call?.toolInput, SHELL_INPUT);
  // Matching ids are what fetchHistory's pairing uses to fold the output into
  // the call; a result keyed by anything else renders as its own empty row.
  assert.equal(result?.toolId, call?.toolId);
  assert.equal(result?.content, 'hello-from-cc\n');
});
