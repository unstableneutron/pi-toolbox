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
      baseUrl: 'http://localhost:4789',
      auth: { kind: 'bearer', token: 'daemon-secret' },
      requestTimeoutMs: 600_000,
      source: 'daemon-manifest',
      sourcePath: '/home/test/.executor/server-control/server.json',
    });
  });

  test('merges user and project config before applying environment overrides', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {
        PI_EXECUTOR_TOKEN: 'environment-secret',
        PI_EXECUTOR_REQUEST_TIMEOUT_MS: '9000',
      },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          url: 'https://executor.example.com',
          token: 'user-secret',
          requestTimeoutMs: 5000,
        },
        '/repo/.pi/pi-executor.json': {
          requestTimeoutMs: 7000,
        },
      }),
    });

    expect(endpoint).toMatchObject({
      baseUrl: 'https://executor.example.com',
      auth: { kind: 'bearer', token: 'environment-secret' },
      requestTimeoutMs: 9000,
      source: 'environment',
    });
    expect(endpoint.sourcePath).toBeUndefined();
  });

  test('does not send inherited credentials to a project-overridden endpoint', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {},
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          url: 'https://trusted.example.com',
          token: 'user-secret',
        },
        '/repo/.pi/pi-executor.json': {
          url: 'https://project.example.com',
        },
      }),
    });

    expect(endpoint.baseUrl).toBe('https://project.example.com');
    expect(endpoint.auth).toBeUndefined();
  });

  test('ignores project configuration when the project is untrusted', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: {},
      homeDir: '/home/test',
      allowProjectConfig: false,
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          url: 'https://trusted.example.com',
          token: 'user-secret',
        },
        '/repo/.pi/pi-executor.json': {
          url: 'https://project.example.com',
          token: 'project-secret',
        },
      }),
    });

    expect(endpoint).toMatchObject({
      baseUrl: 'https://trusted.example.com',
      auth: { kind: 'bearer', token: 'user-secret' },
      source: 'user-config',
    });
  });

  test('does not carry file credentials to an environment-overridden URL', async () => {
    const endpoint = await resolveExecutorEndpoint('/repo', {
      env: { PI_EXECUTOR_URL: 'https://environment.example.com' },
      homeDir: '/home/test',
      readTextFile: reader({
        '/home/test/.pi/agent/pi-executor.json': {
          url: 'https://trusted.example.com',
          token: 'user-secret',
        },
      }),
    });

    expect(endpoint.baseUrl).toBe('https://environment.example.com');
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
          url: 'https://executor.example.com',
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
        PI_EXECUTOR_URL: 'https://executor.example.com',
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
          PI_EXECUTOR_URL: 'http://executor.internal:4789',
          PI_EXECUTOR_TOKEN: 'secret',
        },
        homeDir: '/home/test',
        readTextFile: reader({}),
      }),
    ).rejects.toThrow('Refusing to send Executor credentials over non-loopback HTTP');
  });

  test('reports a useful error when neither config nor daemon exists', async () => {
    await expect(
      resolveExecutorEndpoint('/repo', {
        env: {},
        homeDir: '/home/test',
        readTextFile: reader({}),
      }),
    ).rejects.toThrow('/home/test/.executor/server-control/server.json');
  });
});
