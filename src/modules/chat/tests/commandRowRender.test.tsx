import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { ChatMessage, DiffLine } from '@/shared/types';

const createDiff = createCachedDiffCalculator();

// A small, self-contained diff calculator: these rows never render a diff, and
// the cached one is built from the real implementation at import time.
const noDiff = (): DiffLine[] => createDiff('', '');

/** `normalizedToChatMessages` serializes tool arguments, so renderers see a JSON string. */
const serialize = (input: Record<string, unknown>) => JSON.stringify(input, null, 2);

const COMMAND = 'echo hi';
const TOOL_ID = 'call-1';

/**
 * Renders through MessageComponent, which is what decides whether a call and
 * its result become one row or two. Exporting is the only way to force the
 * command row open during a static render — on screen it is collapsed until the
 * user expands it, and the output is deliberately absent from the markup.
 */
const renderMessage = (toolName: string, toolResult: { content: string; isError: boolean }) => {
  const message = {
    type: 'assistant',
    content: '',
    timestamp: '2026-09-16T10:00:00.000Z',
    isToolUse: true,
    toolName,
    toolId: TOOL_ID,
    toolInput: serialize({ command: COMMAND, description: 'Echo test string' }),
    toolResult,
  } as unknown as ChatMessage;

  return renderToStaticMarkup(
    <TranscriptRenderContext.Provider value={{ isExporting: true }}>
      <MessageComponent
        message={message}
        prevMessage={null}
        createDiff={noDiff}
        provider="command-code"
      />
    </TranscriptRenderContext.Provider>,
  );
};

const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('command rows', () => {
  // Command Code names its shell tool `shell_command`, not `Bash`. Unmapped, the
  // call fell through to the generic parameter dump and rendered as `{}`.
  it('renders a Command Code shell call as a command row, not a parameter dump', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ToolRenderer, {
        toolName: 'shell_command',
        toolInput: serialize({ command: COMMAND, description: 'Echo test string' }),
        mode: 'input' as const,
        createDiff,
      }),
    );

    expect(markup).toContain(COMMAND);
    expect(markup).toContain('Echo test string');
    // The generic renderer prints the input as JSON, quotes and all.
    expect(markup).not.toContain('&quot;command&quot;');
  });

  it('still renders Bash as a command row', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ToolRenderer, {
        toolName: 'Bash',
        toolInput: serialize({ command: COMMAND }),
        mode: 'input' as const,
        createDiff,
      }),
    );

    expect(markup).toContain(COMMAND);
    expect(markup).not.toContain('&quot;command&quot;');
  });

  it('shows the output inside the command row instead of a second row', () => {
    const markup = renderMessage('shell_command', { content: 'OUTPUT-MARKER', isError: false });

    expect(markup).toContain(COMMAND);
    expect(countOccurrences(markup, 'OUTPUT-MARKER')).toBe(1);
    // The separate result section is the thing that would draw it again.
    expect(markup).not.toContain(`tool-result-${TOOL_ID}`);
  });

  // A failed call has a result section of its own that draws a red error row,
  // which would restate the failure the command row already shows.
  it('shows a failed call once, not as its own separate error row', () => {
    const markup = renderMessage('shell_command', { content: 'OUTPUT-MARKER', isError: true });

    expect(countOccurrences(markup, 'OUTPUT-MARKER')).toBe(1);
    expect(markup).not.toContain(`tool-result-${TOOL_ID}`);
  });

  // Guards the two assertions above: every other tool still gets the section,
  // so an absent anchor means it was suppressed, not that nothing renders one.
  it('keeps the separate result row for tools that are not command rows', () => {
    const markup = renderMessage('read_file', { content: 'OUTPUT-MARKER', isError: false });

    expect(markup).toContain(`tool-result-${TOOL_ID}`);
  });
});
