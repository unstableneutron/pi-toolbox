import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_ROBUST_READ_CONFIG } from './config';
import { createRobustReader } from './reader';
import {
  anydocFamilyForPath,
  convertStructuredDocument,
  structuredFormatForPath,
} from './structured';
import type { PdfInspectorModule } from './types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function pdfModule(
  options: {
    classification?: 'TextBased' | 'Mixed' | 'Scanned' | 'ImageBased';
    processError?: Error;
  } = {},
): PdfInspectorModule {
  const classification = options.classification ?? 'TextBased';
  const ocrPages = classification === 'TextBased' ? [] : classification === 'Mixed' ? [2] : [1, 2];
  return {
    classifyPdf: () => ({
      pdfType: classification,
      pageCount: 2,
      pagesNeedingOcr: ocrPages.map((page) => page - 1),
      confidence: 0.875,
    }),
    processPdf: () => {
      if (options.processError) throw options.processError;
      return {
        pdfType: classification,
        markdown: 'combined',
        pageCount: 2,
        confidence: 0.875,
        pagesNeedingOcr: ocrPages,
        ocrReasonsByPage: ocrPages.map((page) => ({
          page,
          reasons: ['scanned_page', 'low_text'],
        })),
        pagesWithTables: [1],
        pagesWithColumns: [1],
        hasEncodingIssues: classification === 'Mixed',
      };
    },
    extractPagesMarkdown: () => ({
      pages: [
        { page: 0, markdown: 'Page one text', needsOcr: false },
        {
          page: 1,
          markdown: classification === 'Mixed' ? 'Partial text layer' : '',
          needsOcr: ocrPages.includes(2),
          ocrReason: ocrPages.includes(2) ? 'scanned_page' : undefined,
        },
      ],
      pagesWithTables: [1],
      pagesWithColumns: [1],
      pagesNeedingOcr: ocrPages,
      ocrReasonsByPage: ocrPages.map((page) => ({
        page,
        reasons: ['scanned_page', 'image_only'],
      })),
      isComplex: true,
    }),
  };
}

describe('structured format routing', () => {
  test('routes every requested Anydoc extension to its canonical family format', async () => {
    const expected: Record<string, [string, string]> = {
      '.doc': ['Word', 'doc'],
      '.docx': ['Word', 'docx'],
      '.docm': ['Word', 'docx'],
      '.ppt': ['PowerPoint', 'ppt'],
      '.pps': ['PowerPoint', 'ppt'],
      '.pot': ['PowerPoint', 'ppt'],
      '.pptx': ['PowerPoint', 'pptx'],
      '.pptm': ['PowerPoint', 'pptx'],
      '.ppsx': ['PowerPoint', 'pptx'],
      '.ppsm': ['PowerPoint', 'pptx'],
      '.xls': ['Excel', 'xlsx'],
      '.xlsx': ['Excel', 'xlsx'],
      '.xlsm': ['Excel', 'xlsx'],
      '.xlsb': ['Excel', 'xlsx'],
      '.odt': ['OpenDocument', 'odt'],
      '.ods': ['OpenDocument', 'ods'],
      '.odp': ['OpenDocument', 'odp'],
      '.rtf': ['RTF', 'rtf'],
      '.epub': ['EPUB', 'epub'],
      '.csv': ['CSV', 'csv'],
    };
    for (const [extension, [family, format]] of Object.entries(expected)) {
      const convert = vi.fn(async () => `converted ${extension}`);
      const result = await convertStructuredDocument(
        Buffer.from(`synthetic ${family} fixture`),
        `fixture${extension}`,
        DEFAULT_ROBUST_READ_CONFIG,
        { loadAnydoc: async () => ({ toMarkdownBytes: convert }) },
      );
      expect(structuredFormatForPath(`fixture${extension}`)).toBe('anydoc');
      expect(anydocFamilyForPath(`fixture${extension}`)).toBe(family);
      expect(convert).toHaveBeenCalledWith(expect.any(Buffer), format);
      expect(result.markdown).toBe(`converted ${extension}`);
    }
  });

  test.each(['TextBased', 'Mixed', 'Scanned', 'ImageBased'] as const)(
    'preserves %s PDF classification and page-specific extraction diagnostics',
    async (classification) => {
      const result = await convertStructuredDocument(
        Buffer.from('%PDF fixture'),
        'fixture.pdf',
        DEFAULT_ROBUST_READ_CONFIG,
        { loadPdfInspector: async () => pdfModule({ classification }) },
      );
      expect(result.markdown).toContain(`Classification: ${classification}`);
      expect(result.markdown).toContain('## Page 1');
      expect(result.pdf).toMatchObject({ classification, confidence: 0.875, pageCount: 2 });
      if (classification !== 'TextBased') {
        expect(result.markdown).toContain('OCR/vision needed');
        expect(result.markdown).toContain('low_text');
        expect(result.markdown).toContain('image_only');
        expect(result.markdown).toContain('No hosted or local OCR was invoked');
      }
    },
  );

  test('always routes PDF directly to PDF Inspector, never Anydoc', async () => {
    const anydoc = vi.fn(async () => 'wrong');
    await convertStructuredDocument(
      Buffer.from('%PDF fixture'),
      'fixture.pdf',
      DEFAULT_ROBUST_READ_CONFIG,
      {
        loadPdfInspector: async () => pdfModule(),
        loadAnydoc: async () => ({ toMarkdownBytes: anydoc }),
      },
    );
    expect(anydoc).not.toHaveBeenCalled();
  });

  test('distinguishes malformed and encrypted PDFs', async () => {
    await expect(
      convertStructuredDocument(Buffer.from('bad'), 'bad.pdf', DEFAULT_ROBUST_READ_CONFIG, {
        loadPdfInspector: async () => pdfModule({ processError: new Error('invalid PDF header') }),
      }),
    ).rejects.toMatchObject({ code: 'malformed' });
    await expect(
      convertStructuredDocument(Buffer.from('locked'), 'locked.pdf', DEFAULT_ROBUST_READ_CONFIG, {
        loadPdfInspector: async () =>
          pdfModule({ processError: new Error('document is encrypted; password required') }),
      }),
    ).rejects.toMatchObject({ code: 'encrypted' });
  });

  test('classifies Anydoc resource/decompression limits and malformed/encrypted inputs', async () => {
    const failure = async (code: string, message: string) => {
      const error = Object.assign(new Error(message), { code });
      return convertStructuredDocument(
        Buffer.from('fixture'),
        'fixture.docx',
        DEFAULT_ROBUST_READ_CONFIG,
        { loadAnydoc: async () => ({ toMarkdownBytes: async () => Promise.reject(error) }) },
      );
    };
    await expect(
      failure('resourceLimit', 'ZIP decompression ratio exceeded'),
    ).rejects.toMatchObject({
      code: 'decompression_risk',
    });
    await expect(failure('resourceLimit', 'node count limit')).rejects.toMatchObject({
      code: 'resource_limited',
    });
    await expect(failure('malformed', 'bad relationships')).rejects.toMatchObject({
      code: 'malformed',
    });
    await expect(failure('encrypted', 'password protected')).rejects.toMatchObject({
      code: 'encrypted',
    });
  });

  test('reports missing native dependencies and unsupported platforms lazily', async () => {
    await expect(
      convertStructuredDocument(Buffer.from('x'), 'x.pdf', DEFAULT_ROBUST_READ_CONFIG, {
        loadPdfInspector: async () =>
          Promise.reject(new Error('Cannot find module native binding')),
      }),
    ).rejects.toMatchObject({ code: 'missing_dependency' });
    await expect(
      convertStructuredDocument(Buffer.from('x'), 'x.docx', DEFAULT_ROBUST_READ_CONFIG, {
        loadAnydoc: async () => Promise.reject(new Error('Unsupported architecture on Solaris')),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  test('rejects oversized structured sources before loading a converter', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'robust-read-source-limit-'));
    temporaryDirectories.push(cwd);
    await writeFile(join(cwd, 'large.docx'), Buffer.alloc(11, 1));
    const loadAnydoc = vi.fn(async () => ({ toMarkdownBytes: async () => 'not reached' }));
    const reader = createRobustReader(
      { ...DEFAULT_ROBUST_READ_CONFIG, structuredSourceMaxBytes: 10 },
      { loadAnydoc },
    );
    await expect(
      reader.read({ path: 'large.docx' }, { cwd, sessionId: 'session' }),
    ).rejects.toMatchObject({ code: 'resource_limited' });
    expect(loadAnydoc).not.toHaveBeenCalled();
  });

  test('keeps ordinary text available when both optional converters are missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'robust-read-optional-'));
    temporaryDirectories.push(cwd);
    await writeFile(join(cwd, 'plain.txt'), 'still readable');
    const reader = createRobustReader(DEFAULT_ROBUST_READ_CONFIG, {
      loadPdfInspector: async () => Promise.reject(new Error('missing')),
      loadAnydoc: async () => Promise.reject(new Error('missing')),
    });
    const result = await reader.read({ path: 'plain.txt' }, { cwd, sessionId: 'session' });
    expect(result.kind === 'text' && result.content).toBe('still readable');
  });
});
