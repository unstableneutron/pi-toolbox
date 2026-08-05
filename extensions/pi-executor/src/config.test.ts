import { describe, expect, test } from 'vitest';

import { endpointAuthorizationHeader, resolveExecutorEndpoint } from './config';

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

function reader(files: Record<string, unknown>) {
  return async (path: string): Promise<string> => {
    if (!(path in files)) throw missing(path);
    return JSON.stringify(files[path]);
  };
}

describe('Executor endpoint resolution', () => {
  test('discovers the authenticated active daemon manifest', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {},
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.executor/server-control/server.json': {
          connection: {
            kind: 'http',
            origin: 'http://localhost:4789',
            auth: { kind: 'bearer', token: 'daemon-secret' },
          },
        },
      }),
    });

    expect(endpoint).toEqual({
      mcpUrl: 'http://localhost:4789/mcp',
      auth: { kind: 'bearer', token: 'daemon-secret' },
      requestTimeoutMs: 300_000,
      yieldAfterMs: 20_000,
      maxOutputBytes: 12_288,
      maxOutputLines: 300,
      source: 'daemon-manifest',
      sourcePath: '/home/test/.executor/server-control/server.json',
    });
  });

  test('merges user and project config before applying environment overrides', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {
        PI_EXECUTOR_TOKEN: 'environment-secret',
        PI_EXECUTOR_REQUEST_TIMEOUT_MS: '9000',
        PI_EXECUTOR_YIELD_AFTER_MS: '3000',
        PI_EXECUTOR_MAX_OUTPUT_BYTES: '2048',
        PI_EXECUTOR_MAX_OUTPUT_LINES: '50',
      },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          mcpUrl: 'https://executor.example.com/mcp',
          token: 'user-secret',
          requestTimeoutMs: 5000,
        },
        '/repo/.pi/pi-executor.json': {
          requestTimeoutMs: 7000,
        },
      }),
    });

    expect(endpoint).toMatchObject({
      mcpUrl: 'https://executor.example.com/mcp',
      auth: { kind: 'bearer', token: 'environment-secret' },
      requestTimeoutMs: 9000,
      yieldAfterMs: 3000,
      maxOutputBytes: 2048,
      maxOutputLines: 50,
      source: 'project-config',
    });
    expect(endpoint.sourcePath).toBe('/repo/.pi/pi-executor.json');
  });

  test('does not send inherited credentials to a project-overridden endpoint', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {},
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          mcpUrl: 'https://trusted.example.com/mcp',
          token: 'user-secret',
        },
        '/repo/.pi/pi-executor.json': {
          mcpUrl: 'https://project.example.com/mcp',
        },
      }),
    });

    expect(endpoint.mcpUrl).toBe('https://project.example.com/mcp');
    expect(endpoint.auth).toBeUndefined();
  });

  test('ignores project configuration when the project is untrusted', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {},
      homeDir: '/home/test',
      allowProjectConfig: false,
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          mcpUrl: 'https://trusted.example.com/mcp',
          token: 'user-secret',
        },
        '/repo/.pi/pi-executor.json': {
          mcpUrl: 'https://project.example.com/mcp',
          token: 'project-secret',
        },
      }),
    });

    expect(endpoint).toMatchObject({
      mcpUrl: 'https://trusted.example.com/mcp',
      auth: { kind: 'bearer', token: 'user-secret' },
      source: 'user-config',
    });
  });

  test('does not carry file credentials to an environment-overridden URL', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: { PI_EXECUTOR_MCP_URL: 'https://environment.example.com/mcp' },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          mcpUrl: 'https://trusted.example.com/mcp',
          token: 'user-secret',
        },
      }),
    });

    expect(endpoint.mcpUrl).toBe('https://environment.example.com/mcp');
    expect(endpoint.auth).toBeUndefined();
  });

  test('allows an auth override to replace the inherited auth method', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {
        PI_EXECUTOR_USERNAME: 'alice',
        PI_EXECUTOR_PASSWORD: 'basic-secret',
      },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          mcpUrl: 'https://executor.example.com/mcp',
          token: 'bearer-secret',
        },
      }),
    });

    expect(endpoint.auth).toEqual({
      kind: 'basic',
      username: 'alice',
      password: 'basic-secret',
    });
  });

  test('supports basic authentication', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {
        PI_EXECUTOR_MCP_URL: 'https://executor.example.com/mcp',
        PI_EXECUTOR_USERNAME: 'alice',
        PI_EXECUTOR_PASSWORD: 'secret',
      },
      homeDir: '/home/test',
      readTextFile: reader({}),
    });

    expect(endpoint.auth).toEqual({ kind: 'basic', username: 'alice', password: 'secret' });
    expect(endpointAuthorizationHeader(endpoint.auth)).toBe('Basic YWxpY2U6c2VjcmV0');
  });

  test('rejects credential-bearing non-loopback plain HTTP by default', async () => {
    await expect(
      resolveExecutorEndpoint('/repo', {
        env: {
          PI_EXECUTOR_MCP_URL: 'http://executor.internal:4789/mcp',
          PI_EXECUTOR_TOKEN: 'secret',
        },
        homeDir: '/home/test',
        readTextFile: reader({}),
      }),
    ).rejects.toThrow('Refusing to send Executor credentials over non-loopback HTTP');
  });

  test('uses the Executor default server profile without duplicate endpoint configuration', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {},
      homeDir: '/home/test',
      now: () => 1_000_000,
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': { allowInsecureHttp: true },
        '/home/test/.executor/server-connections.json': {
          defaultProfile: 'tcbs-nonprod',
          profiles: [
            {
              name: 'tcbs-nonprod',
              connection: {
                kind: 'http',
                origin: 'http://executor.internal:4788',
                auth: { kind: 'oauth', accessToken: 'oauth-secret', expiresAt: 2000 },
              },
            },
          ],
        },
      }),
    });

    expect(endpoint).toMatchObject({
      mcpUrl: 'http://executor.internal:4788/mcp',
      auth: { kind: 'bearer', token: 'oauth-secret' },
      authExpiresAt: 2_000_000,
      source: 'executor-profile',
      profileName: 'tcbs-nonprod',
      sourcePath: '/home/test/.executor/server-connections.json',
    });
  });

  test('lets the source selector prefer config over an environment endpoint', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {
        PI_EXECUTOR_ENDPOINT_SOURCE: 'config',
        PI_EXECUTOR_MCP_URL: 'https://environment.example.com/mcp',
      },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          mcpUrl: 'https://configured.example.com/custom-mcp',
        },
      }),
    });

    expect(endpoint).toMatchObject({
      mcpUrl: 'https://configured.example.com/custom-mcp',
      source: 'user-config',
    });
  });

  test('lets the source selector force the local daemon', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {
        PI_EXECUTOR_ENDPOINT_SOURCE: 'local',
        PI_EXECUTOR_MCP_URL: 'https://ignored.example.com/mcp',
      },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.executor/server-control/server.json': {
          connection: {
            kind: 'http',
            origin: 'http://localhost:4789',
            auth: { kind: 'bearer', token: 'local-secret' },
          },
        },
      }),
    });

    expect(endpoint).toMatchObject({
      mcpUrl: 'http://localhost:4789/mcp',
      auth: { kind: 'bearer', token: 'local-secret' },
      source: 'daemon-manifest',
    });
  });

  test('lets an environment token override expired profile authentication', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {
        PI_EXECUTOR_ENDPOINT_SOURCE: 'profile',
        PI_EXECUTOR_TOKEN: 'replacement-token',
      },
      homeDir: '/home/test',
      now: () => 2_000_001,
      readTextFile: reader({
        '/home/test/.executor/server-connections.json': {
          defaultProfile: 'remote',
          profiles: [
            {
              name: 'remote',
              connection: {
                kind: 'http',
                origin: 'https://executor.example.com',
                auth: { kind: 'oauth', accessToken: 'expired', expiresAt: 2000 },
              },
            },
          ],
        },
      }),
    });

    expect(endpoint.auth).toEqual({ kind: 'bearer', token: 'replacement-token' });
    expect(endpoint.authExpiresAt).toBeUndefined();
  });

  test('does not copy a daemon token to a different local profile port', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: { PI_EXECUTOR_ENDPOINT_SOURCE: 'profile' },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.executor/server-connections.json': {
          defaultProfile: 'other-local',
          profiles: [
            {
              name: 'other-local',
              connection: { kind: 'http', origin: 'http://127.0.0.1:4790' },
            },
          ],
        },
        '/home/test/.executor/server-control/server.json': {
          connection: {
            kind: 'http',
            origin: 'http://localhost:4789',
            auth: { kind: 'bearer', token: 'wrong-server-token' },
          },
        },
      }),
    });

    expect(endpoint.mcpUrl).toBe('http://127.0.0.1:4790/mcp');
    expect(endpoint.auth).toBeUndefined();
  });

  test('reports an expired Executor profile login', async () => {
    await expect(
      resolveExecutorEndpoint('/repo', {
        env: { PI_EXECUTOR_ENDPOINT_SOURCE: 'profile' },
        homeDir: '/home/test',
        now: () => 2_000_001,
        readTextFile: reader({
          '/home/test/.executor/server-connections.json': {
            defaultProfile: 'remote',
            profiles: [
              {
                name: 'remote',
                connection: {
                  kind: 'http',
                  origin: 'https://executor.example.com',
                  auth: { kind: 'oauth', accessToken: 'expired', expiresAt: 2000 },
                },
              },
            ],
          },
        }),
      }),
    ).rejects.toThrow('executor login --server remote');
  });

  test('defaults to the conventional localhost MCP endpoint', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {},
      homeDir: '/home/test',
      readTextFile: reader({}),
    });

    expect(endpoint).toMatchObject({
      mcpUrl: 'http://127.0.0.1:4789/mcp',
      source: 'localhost-default',
    });
  });
});
