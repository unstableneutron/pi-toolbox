import { describe, expect, test, vi } from 'vitest';

import { answerComputerUseElicitation } from './elicitation';

describe('answerComputerUseElicitation', () => {
  test('auto-approves Computer Use by default without prompting', async () => {
    const confirm = vi.fn(async () => false);

    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex to use Finder?',
        serverName: 'computer-use',
        requestedSchema: { type: 'object', properties: {} },
      },
      { hasUI: false, ui: { confirm } },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
  });

  test('auto-approves browser runtime access by default without prompting', async () => {
    const confirm = vi.fn(async () => false);

    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex browser access?',
        serverName: 'node_repl',
        requestedSchema: { type: 'object', properties: {} },
      },
      { hasUI: false, ui: { confirm } },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
  });

  test('asks the Pi UI when auto-approval is disabled with zero', async () => {
    const confirm = vi.fn(async () => true);

    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex to use Finder?',
        serverName: 'computer-use',
        requestedSchema: { type: 'object', properties: {} },
      },
      { env: { PI_CODEX_COMPUTER_USE_AUTO_APPROVE: '0' }, hasUI: true, ui: { confirm } },
    );

    expect(confirm).toHaveBeenCalledWith(
      'Allow Computer Use?',
      'Allow Codex to use Finder?\n\nThis grants Codex Computer Use access to operate the named local app through the Codex native CUA service for this request.',
    );
    expect(result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
  });

  test('asks the Pi UI when auto-approval is disabled with false', async () => {
    const confirm = vi.fn(async () => true);

    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex browser access?',
        serverName: 'node_repl',
        requestedSchema: { type: 'object', properties: {} },
      },
      { env: { PI_CODEX_COMPUTER_USE_AUTO_APPROVE: 'false' }, hasUI: true, ui: { confirm } },
    );

    expect(confirm).toHaveBeenCalledWith(
      'Allow Codex Browser Use?',
      'Allow Codex browser access?\n\nThis grants Codex browser/runtime access through the Codex native Node REPL bridge for this request.',
    );
    expect(result).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
  });

  test('auto-approves only listed servers when env var contains multiple options', async () => {
    const confirm = vi.fn(async () => true);

    const computerUseResult = await answerComputerUseElicitation(
      {
        message: 'Allow Codex to use Finder?',
        serverName: 'computer-use',
        requestedSchema: { type: 'object', properties: {} },
      },
      {
        env: { PI_CODEX_COMPUTER_USE_AUTO_APPROVE: 'computer-use,node_repl' },
        hasUI: false,
        ui: { confirm },
      },
    );

    const nodeReplResult = await answerComputerUseElicitation(
      {
        message: 'Allow Codex browser access?',
        serverName: 'node_repl',
        requestedSchema: { type: 'object', properties: {} },
      },
      {
        env: { PI_CODEX_COMPUTER_USE_AUTO_APPROVE: 'computer-use,node_repl' },
        hasUI: false,
        ui: { confirm },
      },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(computerUseResult).toEqual({
      action: 'accept',
      content: {},
      _meta: { persist: 'always' },
    });
    expect(nodeReplResult).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
  });

  test('falls back to prompting for servers not listed in a scoped env var', async () => {
    const confirm = vi.fn(async () => false);

    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex browser access?',
        serverName: 'node_repl',
        requestedSchema: { type: 'object', properties: {} },
      },
      {
        env: { PI_CODEX_COMPUTER_USE_AUTO_APPROVE: 'computer-use' },
        hasUI: true,
        ui: { confirm },
      },
    );

    expect(confirm).toHaveBeenCalledWith(
      'Allow Codex Browser Use?',
      'Allow Codex browser access?\n\nThis grants Codex browser/runtime access through the Codex native Node REPL bridge for this request.',
    );
    expect(result).toEqual({ action: 'decline', content: null, _meta: null });
  });

  test('declines when auto-approval is disabled and no interactive UI is available', async () => {
    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex to use Finder?',
        serverName: 'computer-use',
        requestedSchema: { type: 'object', properties: {} },
      },
      { env: { PI_CODEX_COMPUTER_USE_AUTO_APPROVE: '0' }, hasUI: false },
    );

    expect(result).toEqual({ action: 'decline', content: null, _meta: null });
  });

  test('uses the misspelled PUSE env var alias when the canonical env var is absent', async () => {
    const result = await answerComputerUseElicitation(
      {
        message: 'Allow Codex to use Finder?',
        serverName: 'computer-use',
        requestedSchema: { type: 'object', properties: {} },
      },
      { env: { PI_CODEX_COMPUTER_PUSE_AUTO_APPROVE: 'false' }, hasUI: false },
    );

    expect(result).toEqual({ action: 'decline', content: null, _meta: null });
  });
});
