import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';

export function buildRequestHeaders(model: Model<Api>, options?: SimpleStreamOptions): Headers {
  const headers = new Headers(model.headers ?? {});
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    headers.set(key, value);
  }
  if (!headers.has('authorization') && options?.apiKey) {
    headers.set('authorization', `Bearer ${options.apiKey}`);
  }
  return headers;
}

export function buildWebSocketHeaders(model: Model<Api>, options?: SimpleStreamOptions): Headers {
  const headers = buildRequestHeaders(model, options);
  headers.delete('accept');
  headers.delete('content-type');
  return headers;
}
