import { describe, expect, test } from 'vitest';

import { ComputerUseSession } from './session';

const transientProcessError = {
  content: [
    {
      type: 'text',
      text: 'Error Domain=NSOSStatusErrorDomain Code=-600 "procNotFound: no eligible process with specified descriptor"',
    },
  ],
  isError: true,
};

const successfulListApps = {
  content: [{ type: 'text', text: 'Finder — /System/Library/CoreServices/Finder.app/' }],
};

function makeSessionWithClient(responses: unknown[]) {
  const session = new ComputerUseSession();
  const calls: unknown[] = [];
  const client = {
    setElicitationHandler() {
      return () => {};
    },
    async callMcpTool(input: unknown) {
      calls.push(input);
      return responses.shift();
    },
  };

  (session as any).client = client;
  (session as any).threadId = 'thread-1';

  return { session, calls };
}

describe('ComputerUseSession.callTool', () => {
  test('retries transient Computer Use process errors for observation tools', async () => {
    const { session, calls } = makeSessionWithClient([transientProcessError, successfulListApps]);

    const result = await session.callTool({ cwd: '/tmp', hasUI: false } as any, 'list_apps', {});

    expect(result.rawResult).toBe(successfulListApps);
    expect(calls).toHaveLength(2);
  });

  test('throws after Codex returns a final MCP error result', async () => {
    const { session } = makeSessionWithClient([transientProcessError, transientProcessError]);

    await expect(
      session.callTool({ cwd: '/tmp', hasUI: false } as any, 'list_apps', {}),
    ).rejects.toThrow('procNotFound: no eligible process with specified descriptor');
  });
});
