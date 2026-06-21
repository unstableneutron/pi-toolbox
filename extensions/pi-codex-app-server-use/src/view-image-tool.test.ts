import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  registerViewImageTool,
  supportsViewImageInputs,
  type ViewImageToolDeps,
} from './view-image-tool';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const CLI_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';

function createRegisteredViewImageTool(deps?: ViewImageToolDeps) {
  const registeredTools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
  registerViewImageTool(
    {
      registerTool(tool: { name: string; execute?: (...args: any[]) => Promise<any> }) {
        registeredTools.push(tool);
      },
    },
    deps,
  );
  const tool = registeredTools.find((registeredTool) => registeredTool.name === 'view_image');
  if (!tool?.execute) throw new Error('view_image tool was not registered');
  return { registeredTools, tool };
}

describe('view_image tool', () => {
  test('registers Codex-compatible description and prompt snippet', () => {
    const { registeredTools } = createRegisteredViewImageTool();

    expect(registeredTools).toMatchObject([
      {
        name: 'view_image',
        description: 'View image.',
        promptSnippet: 'View image.',
      },
    ]);
  });

  test('returns Pi image content for a local image path', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-view-image-test-'));
    const imagePath = path.join(directory, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));
    const { tool } = createRegisteredViewImageTool();

    try {
      const result = await tool.execute?.(
        'call-1',
        { file_path: 'pixel.png' },
        undefined,
        undefined,
        {
          cwd: directory,
          model: { input: ['image'] },
        },
      );

      expect(result).toMatchObject({
        content: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64, detail: 'original' }],
        details: { pathTool: { viewImage: true } },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('prefers view_image CLI output when the command is available', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-view-image-test-'));
    const imagePath = path.join(directory, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));
    const { tool } = createRegisteredViewImageTool({
      findCli: () => '/mock/bin/view_image',
      runCli: () => ({
        status: 0,
        stdout: JSON.stringify({
          image_url: `data:image/jpeg;base64,${CLI_JPEG_BASE64}`,
          detail: 'original',
        }),
        stderr: '',
      }),
    });

    try {
      const result = await tool.execute?.('call-1', { path: 'pixel.png' }, undefined, undefined, {
        cwd: directory,
        model: { input: ['image'] },
      });

      expect(result).toMatchObject({
        content: [
          { type: 'image', mimeType: 'image/jpeg', data: CLI_JPEG_BASE64, detail: 'original' },
        ],
        details: { pathTool: { viewImage: true } },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('falls back to JS image loading when view_image CLI is missing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-view-image-test-'));
    const imagePath = path.join(directory, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));
    const { tool } = createRegisteredViewImageTool({ findCli: () => undefined });

    try {
      const result = await tool.execute?.('call-1', { path: 'pixel.png' }, undefined, undefined, {
        cwd: directory,
        model: { input: ['image'] },
      });

      expect(result).toMatchObject({
        content: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64, detail: 'original' }],
        details: { pathTool: { viewImage: true } },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('falls back to JS image loading when view_image CLI fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-view-image-test-'));
    const imagePath = path.join(directory, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));
    const { tool } = createRegisteredViewImageTool({
      findCli: () => '/mock/bin/view_image',
      runCli: () => ({ status: 1, stdout: '', stderr: 'boom' }),
    });

    try {
      const result = await tool.execute?.('call-1', { path: 'pixel.png' }, undefined, undefined, {
        cwd: directory,
        model: { input: ['image'] },
      });

      expect(result).toMatchObject({
        content: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64, detail: 'original' }],
        details: { pathTool: { viewImage: true } },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('falls back to JS image loading when view_image CLI returns invalid output', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-view-image-test-'));
    const imagePath = path.join(directory, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));
    const { tool } = createRegisteredViewImageTool({
      findCli: () => '/mock/bin/view_image',
      runCli: () => ({
        status: 0,
        stdout: JSON.stringify({ image_url: 'not-a-data-url' }),
        stderr: '',
      }),
    });

    try {
      const result = await tool.execute?.('call-1', { path: 'pixel.png' }, undefined, undefined, {
        cwd: directory,
        model: { input: ['image'] },
      });

      expect(result).toMatchObject({
        content: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64, detail: 'original' }],
        details: { pathTool: { viewImage: true } },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects models without image input support', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-view-image-test-'));
    const imagePath = path.join(directory, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'));
    const { tool } = createRegisteredViewImageTool();

    try {
      await expect(
        tool.execute?.('call-1', { path: 'pixel.png' }, undefined, undefined, {
          cwd: directory,
          model: { input: ['text'] },
        }),
      ).rejects.toThrow('view_image is not allowed because you do not support image inputs');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('detects image-capable models', () => {
    expect(supportsViewImageInputs({ input: ['image'] } as any)).toBe(true);
    expect(supportsViewImageInputs({ input: ['text'] } as any)).toBe(false);
    expect(supportsViewImageInputs(undefined)).toBe(false);
  });
});
