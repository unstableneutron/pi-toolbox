import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { renderViewImageCall, renderViewImageResult } from './rendering';

export const VIEW_IMAGE_TOOL_NAME = 'view_image';

const VIEW_IMAGE_UNSUPPORTED_MESSAGE =
  'view_image is not allowed because you do not support image inputs';
const VIEW_IMAGE_CLI_MAX_BUFFER = 64 * 1024 * 1024;
const VIEW_IMAGE_CLI_TIMEOUT_MS = 30_000;

const VIEW_IMAGE_PARAMETERS = Type.Object({
  path: Type.String(),
  detail: Type.Optional(Type.String()),
});

interface ViewImageParams {
  path: string;
  detail?: string | undefined;
}

interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
  detail: 'original';
}

interface ViewImageCliResult {
  status: number | null;
  stdout: string;
  stderr?: string | undefined;
  error?: Error | undefined;
}

export interface ViewImageToolDeps {
  findCli?: (() => string | undefined) | undefined;
  runCli?:
    | ((
        cliPath: string,
        params: ViewImageParams,
        cwd: string,
        signal: AbortSignal | undefined,
      ) => ViewImageCliResult)
    | undefined;
}

function parseViewImageParams(params: unknown): ViewImageParams {
  if (
    !params ||
    typeof params !== 'object' ||
    !('path' in params) ||
    typeof params.path !== 'string'
  ) {
    throw new Error("view_image requires a string 'path' parameter");
  }
  const rawDetail = 'detail' in params ? params.detail : undefined;
  if (rawDetail !== null && rawDetail !== undefined && typeof rawDetail !== 'string') {
    throw new Error('view_image.detail must be a string when provided');
  }
  if (typeof rawDetail === 'string' && rawDetail !== 'original') {
    throw new Error(`view_image.detail only supports \`original\`, got \`${rawDetail}\``);
  }
  return { path: params.path, ...(typeof rawDetail === 'string' ? { detail: rawDetail } : {}) };
}

function prepareViewImageArguments(args: unknown): ViewImageParams {
  if (!args || typeof args !== 'object') return args as ViewImageParams;
  const record = args as Record<string, unknown>;
  const prepared: Record<string, unknown> = { ...record };
  if (!('path' in prepared)) {
    if ('file_path' in prepared) prepared.path = prepared.file_path;
    else if ('image_path' in prepared) prepared.path = prepared.image_path;
  }
  return prepared as unknown as ViewImageParams;
}

function resolveImagePath(cwd: string, imagePath: string): string {
  return path.isAbsolute(imagePath) ? imagePath : path.resolve(cwd, imagePath);
}

function hasPrefix(bytes: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function inferMimeType(filePath: string, bytes: Buffer): string | undefined {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  return undefined;
}

function isSupportedImageMimeType(mimeType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType);
}

function executableNames(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
}

function isExecutableFile(filePath: string): boolean {
  try {
    const metadata = fs.statSync(filePath);
    if (!metadata.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateCliDirectories(): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  return [...new Set(dirs)];
}

function findViewImageCli(): string | undefined {
  for (const directory of candidateCliDirectories()) {
    for (const executableName of executableNames(VIEW_IMAGE_TOOL_NAME)) {
      const candidate = path.join(directory, executableName);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function runViewImageCli(
  cliPath: string,
  params: ViewImageParams,
  cwd: string,
  signal: AbortSignal | undefined,
): ViewImageCliResult {
  const result = spawnSync(cliPath, [JSON.stringify(params)], {
    cwd,
    encoding: 'utf8',
    maxBuffer: VIEW_IMAGE_CLI_MAX_BUFFER,
    signal,
    timeout: VIEW_IMAGE_CLI_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? undefined,
    error: result.error,
  };
}

function parseCliImageContent(stdout: string): PiImageContent {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('view_image returned non-object JSON');
  const record = parsed as Record<string, unknown>;
  if (typeof record.image_url !== 'string') {
    throw new Error('view_image did not return an image_url');
  }
  if (record.detail !== undefined && record.detail !== 'original') {
    throw new Error('view_image returned unsupported detail');
  }

  const match = record.image_url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) throw new Error('view_image returned a non-base64 data URL');
  const [, mimeType, data] = match;
  if (!mimeType || !isSupportedImageMimeType(mimeType)) {
    throw new Error('view_image returned an unsupported image MIME type');
  }
  if (!data) throw new Error('view_image returned empty image data');

  return { type: 'image', mimeType, data, detail: 'original' };
}

function loadImageContentFromCli(
  params: ViewImageParams,
  cwd: string,
  signal: AbortSignal | undefined,
  deps: ViewImageToolDeps,
): PiImageContent | undefined {
  const cliPath = (deps.findCli ?? findViewImageCli)();
  if (!cliPath) return undefined;
  const result = (deps.runCli ?? runViewImageCli)(cliPath, params, cwd, signal);
  if (result.error || result.status !== 0) return undefined;
  try {
    return parseCliImageContent(result.stdout);
  } catch {
    return undefined;
  }
}

function loadImageContent(params: ViewImageParams, cwd: string): PiImageContent {
  const absolutePath = resolveImagePath(cwd, params.path);
  let metadata: fs.Stats;
  try {
    metadata = fs.statSync(absolutePath);
  } catch {
    throw new Error(`unable to locate image at \`${absolutePath}\``);
  }
  if (!metadata.isFile()) {
    throw new Error(`image path \`${absolutePath}\` is not a file`);
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch {
    throw new Error(`unable to read image at \`${absolutePath}\``);
  }

  const mimeType = inferMimeType(absolutePath, bytes);
  if (!mimeType) {
    throw new Error('view_image expected an image file. Use exec_command for text files.');
  }

  return {
    type: 'image',
    mimeType,
    data: bytes.toString('base64'),
    detail: 'original',
  };
}

export function supportsViewImageInputs(model: ExtensionContext['model']): boolean {
  return Array.isArray(model?.input) && model.input.includes('image');
}

export function registerViewImageTool(
  pi: { registerTool(tool: any): void },
  deps: ViewImageToolDeps = {},
): void {
  pi.registerTool({
    name: VIEW_IMAGE_TOOL_NAME,
    label: VIEW_IMAGE_TOOL_NAME,
    description:
      'View a local image after this deferred capability is enabled. Requires an image-capable model.',
    parameters: VIEW_IMAGE_PARAMETERS,
    prepareArguments: prepareViewImageArguments as (args: unknown) => ViewImageParams,
    renderCall: renderViewImageCall,
    renderResult: renderViewImageResult,
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!supportsViewImageInputs(ctx.model)) {
        throw new Error(VIEW_IMAGE_UNSUPPORTED_MESSAGE);
      }
      const typedParams = parseViewImageParams(prepareViewImageArguments(params));
      const cliContent = loadImageContentFromCli(typedParams, ctx.cwd, _signal, deps);
      return {
        content: [cliContent ?? loadImageContent(typedParams, ctx.cwd)],
        details: { pathTool: { viewImage: true } },
      };
    },
  });
}
