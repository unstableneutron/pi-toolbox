import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PROXIED_PROVIDER_ERROR_CODES } from './http';
import { createStreamSimpleProxiedBedrock } from './bedrock';

const baseModel = {
  id: 'global.anthropic.claude-opus-4-7',
  provider: 'facade',
  api: 'bedrock-converse-stream',
  baseUrl: 'https://proxy.example.com/api/v2/proxy/aws/bedrock',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
} as const;

const EXPECTED_NEUTRALIZED_ENV_VARS = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_ENDPOINT_URL',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'AWS_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'AWS_BEDROCK_SKIP_AUTH',
] as const;

describe('createStreamSimpleProxiedBedrock', () => {
  // Full env snapshot/restore — the wrapper mutates many AWS env vars, so
  // be conservative and put the world back exactly as we found it.
  let envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    // Remove any var added during the test
    for (const k of Object.keys(process.env)) {
      if (!(k in envSnapshot)) delete process.env[k];
    }
    // Restore any var that was originally present (or re-delete if it was unset)
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  test('sets bearer token, endpoint, region, and http1 flag before delegating', () => {
    const original = vi.fn(() => {
      // Captured at the exact moment pi-ai's streamSimpleBedrock would read
      // them (synchronously, before any await).
      expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('proxy-token');
      expect(process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBe(baseModel.baseUrl);
      expect(process.env.AWS_BEDROCK_FORCE_HTTP1).toBe('1');
      expect(process.env.AWS_REGION).toBe('us-east-1');
      expect(process.env.AWS_DEFAULT_REGION).toBe('us-east-1');
      return 'fake-stream' as any;
    });

    const stream = createStreamSimpleProxiedBedrock(original);
    const context = { messages: [] } as any;
    const options = {
      apiKey: 'proxy-token',
      headers: { Authorization: 'Bearer proxy-token' },
    } as any;

    const result = stream(baseModel as any, context, options);

    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith(baseModel, context, options);
    expect(result).toBe('fake-stream');
  });

  test('neutralizes dangerous AWS env vars before delegating', () => {
    // Seed a pathological shell: profile, creds, custom CA, proxy, skip-auth.
    process.env.AWS_PROFILE = 'some-profile';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA...';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_SESSION_TOKEN = 'session';
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/tmp/bogus-creds';
    process.env.AWS_CONFIG_FILE = '/tmp/bogus-config';
    process.env.AWS_ENDPOINT_URL = 'https://evil.example.com';
    process.env.AWS_USE_FIPS_ENDPOINT = 'true';
    process.env.AWS_USE_DUALSTACK_ENDPOINT = 'true';
    process.env.AWS_CA_BUNDLE = '/etc/ssl/bogus.pem';
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
    process.env.NO_PROXY = 'localhost';
    process.env.http_proxy = 'http://proxy.example.com:8080';
    process.env.https_proxy = 'http://proxy.example.com:8080';
    process.env.no_proxy = 'localhost';
    process.env.AWS_BEDROCK_SKIP_AUTH = '1';

    const original = vi.fn(() => {
      for (const name of EXPECTED_NEUTRALIZED_ENV_VARS) {
        expect(process.env[name], `expected ${name} to be cleared`).toBeUndefined();
      }
      return 'ok' as any;
    });

    const stream = createStreamSimpleProxiedBedrock(original);
    stream(
      baseModel as any,
      { messages: [] } as any,
      { headers: { Authorization: 'Bearer proxy-token' } } as any,
    );

    expect(original).toHaveBeenCalledTimes(1);
  });

  test('overrides AWS_REGION regardless of pre-existing value', () => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_DEFAULT_REGION = 'ap-southeast-2';

    const original = vi.fn(() => {
      expect(process.env.AWS_REGION).toBe('us-east-1');
      expect(process.env.AWS_DEFAULT_REGION).toBe('us-east-1');
      return 'ok' as any;
    });

    const stream = createStreamSimpleProxiedBedrock(original);
    stream(
      baseModel as any,
      { messages: [] } as any,
      { headers: { Authorization: 'Bearer proxy-token' } } as any,
    );

    expect(original).toHaveBeenCalledTimes(1);
  });

  test('accepts a lowercase authorization header', () => {
    const original = vi.fn(() => 'ok' as any);
    const stream = createStreamSimpleProxiedBedrock(original);

    stream(
      baseModel as any,
      { messages: [] } as any,
      { headers: { authorization: 'Bearer lowercase-token' } } as any,
    );

    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('lowercase-token');
    expect(original).toHaveBeenCalledOnce();
  });

  test('throws INVALID_BASE_URL when model.baseUrl is missing', () => {
    const stream = createStreamSimpleProxiedBedrock(vi.fn() as any);
    const modelWithoutBase = { ...baseModel, baseUrl: undefined };

    expect(() =>
      stream(
        modelWithoutBase as any,
        { messages: [] } as any,
        { headers: { Authorization: 'Bearer x' } } as any,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      }),
    );
  });

  test('throws MISSING_AUTH when Authorization header is absent', () => {
    const original = vi.fn() as any;
    const stream = createStreamSimpleProxiedBedrock(original);

    expect(() => stream(baseModel as any, { messages: [] } as any, {} as any)).toThrowError(
      expect.objectContaining({
        code: PROXIED_PROVIDER_ERROR_CODES.MISSING_AUTH,
      }),
    );
    expect(original).not.toHaveBeenCalled();
  });

  test('throws MISSING_AUTH when Authorization header is whitespace only', () => {
    const stream = createStreamSimpleProxiedBedrock(vi.fn() as any);

    expect(() =>
      stream(
        baseModel as any,
        { messages: [] } as any,
        { headers: { Authorization: 'Bearer    ' } } as any,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: PROXIED_PROVIDER_ERROR_CODES.MISSING_AUTH,
      }),
    );
  });

  test('neutralization and auth failure are independent: bad auth short-circuits before env mutation', () => {
    process.env.AWS_PROFILE = 'should-survive';

    const stream = createStreamSimpleProxiedBedrock(vi.fn() as any);

    expect(() =>
      stream(baseModel as any, { messages: [] } as any, { headers: {} } as any),
    ).toThrowError();

    // Env mutation happens AFTER the auth check, so a failing auth shouldn't
    // leave the shell in an unexpected state.
    expect(process.env.AWS_PROFILE).toBe('should-survive');
  });
});
