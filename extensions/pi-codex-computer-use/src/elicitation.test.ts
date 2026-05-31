import { describe, expect, test, vi } from 'vitest';

import { answerComputerUseElicitation } from './elicitation';

describe('answerComputerUseElicitation', () => {
  test('asks the Pi UI before allowing a Computer Use app', async () => {
    const confirm = vi.fn(async () => true);

    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex to use Finder?',
        serverName: 'computer-use',
        requestedSchema: { type: 'object', properties: {} },
      },
      { hasUI: true, ui: { confirm } },
    );

    expect(confirm).toHaveBeenCalledWith(
      'Allow Computer Use?',
      'Allow Codex to use Finder?\n\nThis grants Codex Computer Use access to operate the named local app through the Codex native CUA service for this request.',
    );
    expect(result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
  });

  test('asks the Pi UI before allowing browser runtime access through node_repl', async () => {
    const confirm = vi.fn(async () => true);

    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex browser access?',
        serverName: 'node_repl',
        requestedSchema: { type: 'object', properties: {} },
      },
      { hasUI: true, ui: { confirm } },
    );

    expect(confirm).toHaveBeenCalledWith(
      'Allow Codex Browser Use?',
      'Allow Codex browser access?\n\nThis grants Codex browser/runtime access through the Codex native Node REPL bridge for this request.',
    );
    expect(result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
  });

  test('declines when no interactive UI is available', async () => {
    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex to use Finder?',
        serverName: 'computer-use',
        requestedSchema: { type: 'object', properties: {} },
      },
      { hasUI: false },
    );

    expect(result).toEqual({ action: 'decline', content: null, _meta: null });
  });
});
