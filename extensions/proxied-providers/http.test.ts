import { describe, expect, test } from 'vitest';

import {
  PROXIED_PROVIDER_ERROR_CODES,
  ProxiedProviderError,
  buildHeaderMap,
  joinBaseUrlAndPath,
  mergeResolvedHeaders,
} from './http';

describe('joinBaseUrlAndPath', () => {
  test('normalizes trailing slashes and preserves path prefixes', () => {
    expect(
      joinBaseUrlAndPath('https://proxy.example.com/root/', '/model/foo/converse-stream'),
    ).toBe('https://proxy.example.com/root/model/foo/converse-stream');
  });

  test('rejects invalid baseUrl schemes', () => {
    const call = () => joinBaseUrlAndPath('ftp://proxy.example.com/root', '/model/foo');
    expect(call).toThrow(ProxiedProviderError);
    expect(call).toThrowError(
      expect.objectContaining({
        code: PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      }),
    );
  });

  test('rejects invalid wrapperPath', () => {
    expect(() => joinBaseUrlAndPath('https://proxy.example.com/root', 'model/foo')).toThrow(
      ProxiedProviderError,
    );
  });

  test('rejects query strings in baseUrl', () => {
    const call = () => joinBaseUrlAndPath('https://proxy.example.com/root?x=1', '/model/foo');
    expect(call).toThrow(ProxiedProviderError);
    expect(call).toThrowError(
      expect.objectContaining({
        code: PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      }),
    );
  });

  test('rejects fragments in baseUrl', () => {
    const call = () => joinBaseUrlAndPath('https://proxy.example.com/root/#frag', '/model/foo');
    expect(call).toThrow(ProxiedProviderError);
    expect(call).toThrowError(
      expect.objectContaining({
        code: PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      }),
    );
  });
});

describe('mergeResolvedHeaders', () => {
  test('keeps resolved Authorization and collapses differently cased duplicates', () => {
    const headers = mergeResolvedHeaders(
      { 'content-type': 'application/json', authorization: 'Bearer default' },
      { Authorization: 'Bearer resolved', 'X-Test': 'one' },
      { 'x-test': 'generated', Accept: 'text/event-stream' },
    );

    expect(headers.get('authorization')).toBe('Bearer resolved');
    expect(headers.get('x-test')).toBe('one');
    expect(headers.get('accept')).toBe('text/event-stream');
  });

  test('does not let generated headers override resolved or defaults', () => {
    const headers = mergeResolvedHeaders(
      { Authorization: 'Bearer default', 'X-Env': 'default' },
      { authorization: 'Bearer resolved' },
      { AUTHORIZATION: 'Bearer generated', 'x-env': 'generated' },
    );

    expect(headers.get('authorization')).toBe('Bearer resolved');
    expect(headers.get('x-env')).toBe('default');
  });

  test('exposes stable proxy error codes', () => {
    const error = new ProxiedProviderError(
      PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      'bad baseUrl',
    );
    expect(error.code).toBe('PROXIED_PROVIDER_INVALID_BASE_URL');
  });

  test('buildHeaderMap performs case-insensitive lookup', () => {
    const map = buildHeaderMap({ Authorization: 'Bearer a', 'x-test': 'one' });
    expect(map.get('authorization')?.value).toBe('Bearer a');
    expect(map.get('X-Test')?.value).toBe('one');
  });
});
