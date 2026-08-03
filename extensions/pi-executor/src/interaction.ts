import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type {
  ElicitationAction,
  ExecutorElicitationRequest,
  ExecutorElicitationResponse,
  JsonObject,
  JsonValue,
} from './types';

const execFileAsync = promisify(execFile);
const ACTIONS: ElicitationAction[] = ['accept', 'decline', 'cancel'];

export type OpenUrl = (url: string) => Promise<void>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaTemplate(schema: JsonObject): JsonValue {
  if ('default' in schema) return schema.default ?? null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0] ?? null;
  if (schema.type === 'object' || isObject(schema.properties)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        isObject(value) ? schemaTemplate(value as JsonObject) : null,
      ]),
    ) as JsonObject;
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  return '';
}

function parseResponseObject(raw: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Executor response must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) throw new Error('Executor response must be a JSON object');
  return parsed as JsonObject;
}

function normalizeAction(action: string | undefined): ElicitationAction {
  return ACTIONS.includes(action as ElicitationAction) ? (action as ElicitationAction) : 'cancel';
}

function validateBrowserUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Executor browser interaction URL must use http or https');
  }
  return url.toString();
}

export function browserCommandForPlatform(
  platform: NodeJS.Platform,
  url: string,
): { executable: string; args: string[] } {
  const validated = validateBrowserUrl(url);
  if (platform === 'darwin') return { executable: '/usr/bin/open', args: [validated] };
  if (platform === 'win32') {
    return {
      executable: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', validated],
    };
  }
  return { executable: 'xdg-open', args: [validated] };
}

export async function openUrlWithSystemBrowser(url: string): Promise<void> {
  const command = browserCommandForPlatform(process.platform, url);
  await execFileAsync(command.executable, command.args);
}

export function createElicitationHandler(
  ctx: ExtensionContext,
  openUrl: OpenUrl = openUrlWithSystemBrowser,
): (request: ExecutorElicitationRequest) => Promise<ExecutorElicitationResponse> {
  return async (request) => {
    if (!ctx.hasUI) return { action: 'cancel' };

    if (request.mode === 'url') {
      let url: string;
      try {
        url = validateBrowserUrl(request.url);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'warning');
        return { action: 'decline' };
      }

      const domain = new URL(url).hostname;
      ctx.ui.notify(
        [
          'Executor is requesting an external browser interaction.',
          `Reason: ${request.message}`,
          `Domain: ${domain}`,
          `URL: ${url}`,
        ].join('\n'),
        'warning',
      );
      const selected = normalizeAction(
        await ctx.ui.select('Open this Executor URL?', ACTIONS, { timeout: undefined }),
      );
      if (selected !== 'accept') return { action: selected };

      try {
        await openUrl(url);
        ctx.ui.notify(`Opened Executor interaction in your browser:\n${url}`, 'info');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Open this Executor URL manually:\n${url}\n\n${message}`, 'warning');
      }
      return { action: 'accept' };
    }

    const properties = isObject(request.requestedSchema.properties)
      ? request.requestedSchema.properties
      : {};
    if (Object.keys(properties).length === 0) {
      const selected = await ctx.ui.select(request.message || 'Executor interaction', ACTIONS, {
        timeout: undefined,
      });
      return { action: normalizeAction(selected) };
    }

    ctx.ui.notify(request.message, 'info');
    const initial = JSON.stringify(schemaTemplate(request.requestedSchema), null, 2);
    const edited = await ctx.ui.editor('Executor response JSON', initial);
    if (edited === undefined) return { action: 'cancel' };
    const selected = normalizeAction(
      await ctx.ui.select('Submit Executor response', ACTIONS, { timeout: undefined }),
    );
    if (selected !== 'accept') return { action: selected };

    try {
      return { action: 'accept', content: parseResponseObject(edited) };
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'warning');
      return { action: 'cancel' };
    }
  };
}
