import { describe, expect, test, vi } from 'vitest';

import { browserCommandForPlatform, createElicitationHandler } from './interaction';

function context(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue('accept'),
      editor: vi.fn().mockResolvedValue('{"approved":true}'),
    },
    ...overrides,
  };
}

describe('Executor elicitation', () => {
  test('cancels automatically outside interactive Pi sessions', async () => {
    const handler = createElicitationHandler(context({ hasUI: false }) as never);
    await expect(
      handler({
        mode: 'form',
        message: 'Approve?',
        requestedSchema: { type: 'object' },
      }),
    ).resolves.toEqual({ action: 'cancel' });
  });

  test('collects form response JSON through the Pi UI', async () => {
    const ctx = context();
    const handler = createElicitationHandler(ctx as never);
    const result = await handler({
      mode: 'form',
      message: 'Approve?',
      requestedSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
      },
    });

    expect(result).toEqual({ action: 'accept', content: { approved: true } });
    expect(ctx.ui.editor).toHaveBeenCalledWith(
      'Executor response JSON',
      '{\n  "approved": false\n}',
    );
  });

  test('opens URL interactions and waits for explicit confirmation', async () => {
    const ctx = context();
    const openUrl = vi.fn(async () => undefined);
    const handler = createElicitationHandler(ctx as never, openUrl);
    const result = await handler({
      mode: 'url',
      message: 'Authenticate',
      url: 'https://executor.example.com/auth',
      elicitationId: 'elic-1',
    });

    expect(ctx.ui.select.mock.invocationCallOrder[0]).toBeLessThan(
      openUrl.mock.invocationCallOrder[0]!,
    );
    expect(openUrl).toHaveBeenCalledWith('https://executor.example.com/auth');
    expect(result).toEqual({ action: 'accept' });
  });

  test('uses a direct Windows launcher instead of cmd.exe', () => {
    const command = browserCommandForPlatform(
      'win32',
      'https://executor.example.com/auth?a=1&b=2|3^4',
    );

    expect(command).toEqual({
      executable: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'https://executor.example.com/auth?a=1&b=2|3^4'],
    });
  });
});
