import { extname } from 'node:path';
import { RobustReadError } from './errors';
import { renderNotebook } from './notebook';
import type {
  AnydocModule,
  PdfInspectorModule,
  RobustReadConfig,
  RobustReadDependencies,
} from './types';

const WORD_EXTENSIONS = new Set(['.doc', '.docx', '.docm']);
const POWERPOINT_EXTENSIONS = new Set(['.ppt', '.pps', '.pot', '.pptx', '.pptm', '.ppsx', '.ppsm']);
const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb']);
const ANYDOC_FORMATS: Readonly<Record<string, string>> = {
  '.doc': 'doc',
  '.docx': 'docx',
  '.docm': 'docx',
  '.ppt': 'ppt',
  '.pps': 'ppt',
  '.pot': 'ppt',
  '.pptx': 'pptx',
  '.pptm': 'pptx',
  '.ppsx': 'pptx',
  '.ppsm': 'pptx',
  '.xls': 'xlsx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.xlsb': 'xlsx',
  '.odt': 'odt',
  '.ods': 'ods',
  '.odp': 'odp',
  '.rtf': 'rtf',
  '.epub': 'epub',
  '.csv': 'csv',
};

export interface ConvertedDocument {
  markdown: string;
  format: 'notebook' | 'pdf' | 'anydoc';
  omissions: string[];
  pdf?: {
    classification: string;
    confidence: number;
    pageCount: number;
    pagesNeedingOcr: number[];
    pagesWithTables: number[];
    pagesWithColumns: number[];
    hasEncodingIssues: boolean;
  };
}

export function structuredFormatForPath(filePath: string): 'notebook' | 'pdf' | 'anydoc' | null {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.ipynb') return 'notebook';
  if (extension === '.pdf') return 'pdf';
  return extension in ANYDOC_FORMATS ? 'anydoc' : null;
}

export function anydocFamilyForPath(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase();
  if (WORD_EXTENSIONS.has(extension)) return 'Word';
  if (POWERPOINT_EXTENSIONS.has(extension)) return 'PowerPoint';
  if (EXCEL_EXTENSIONS.has(extension)) return 'Excel';
  if (extension === '.odt' || extension === '.ods' || extension === '.odp') return 'OpenDocument';
  if (extension === '.rtf') return 'RTF';
  if (extension === '.epub') return 'EPUB';
  if (extension === '.csv') return 'CSV';
  return null;
}

function dependencyError(error: unknown, packageName: string): RobustReadError {
  const message = error instanceof Error ? error.message : String(error);
  const unsupported = /unsupported (architecture|platform)|not support.*platform/iu.test(message);
  return new RobustReadError(
    unsupported ? 'unsupported_platform' : 'missing_dependency',
    unsupported
      ? `${packageName} does not provide a native binary for this platform: ${message}`
      : `${packageName} is unavailable. Reinstall pi-fff-search with optional dependencies enabled. ${message}`,
    { cause: error },
  );
}

async function defaultLoadPdfInspector(): Promise<PdfInspectorModule> {
  try {
    return (await import('@firecrawl/pdf-inspector')) as PdfInspectorModule;
  } catch (error) {
    throw dependencyError(error, '@firecrawl/pdf-inspector');
  }
}

async function defaultLoadAnydoc(): Promise<AnydocModule> {
  try {
    return (await import('@firecrawl/anydoc')) as AnydocModule;
  } catch (error) {
    throw dependencyError(error, '@firecrawl/anydoc');
  }
}

function classifyPdfError(error: unknown): RobustReadError {
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypted|password/iu.test(message)) {
    return new RobustReadError(
      'encrypted',
      `Encrypted PDF cannot be extracted locally: ${message}`,
      {
        cause: error,
      },
    );
  }
  if (/decompress|zip bomb|compression ratio/iu.test(message)) {
    return new RobustReadError(
      'decompression_risk',
      `PDF extraction stopped for decompression safety: ${message}`,
      { cause: error },
    );
  }
  if (/limit|too large|resource/iu.test(message)) {
    return new RobustReadError(
      'resource_limited',
      `PDF extraction hit a resource limit: ${message}`,
      {
        cause: error,
      },
    );
  }
  return new RobustReadError('malformed', `Malformed or unsupported PDF: ${message}`, {
    cause: error,
  });
}

function renderPdf(
  classification: ReturnType<PdfInspectorModule['classifyPdf']>,
  processed: ReturnType<PdfInspectorModule['processPdf']>,
  pages: ReturnType<PdfInspectorModule['extractPagesMarkdown']>,
): ConvertedDocument {
  const reasons = new Map<number, string[]>();
  for (const entry of [...processed.ocrReasonsByPage, ...pages.ocrReasonsByPage]) {
    reasons.set(entry.page, [...new Set([...(reasons.get(entry.page) ?? []), ...entry.reasons])]);
  }
  const pagesNeedingOcr = [
    ...new Set([...processed.pagesNeedingOcr, ...pages.pagesNeedingOcr]),
  ].sort((left, right) => left - right);
  const pagesWithTables = [
    ...new Set([...processed.pagesWithTables, ...pages.pagesWithTables]),
  ].sort((left, right) => left - right);
  const pagesWithColumns = [
    ...new Set([...processed.pagesWithColumns, ...pages.pagesWithColumns]),
  ].sort((left, right) => left - right);
  const header = [
    '# PDF extraction (local text layer only)',
    `- Classification: ${classification.pdfType}`,
    `- Confidence: ${classification.confidence.toFixed(3)}`,
    `- Pages: ${classification.pageCount}`,
    `- Pages requiring OCR/vision: ${pagesNeedingOcr.length > 0 ? pagesNeedingOcr.join(', ') : 'none'}`,
    `- Pages with tables: ${pagesWithTables.length > 0 ? pagesWithTables.join(', ') : 'none detected'}`,
    `- Pages with columns: ${pagesWithColumns.length > 0 ? pagesWithColumns.join(', ') : 'none detected'}`,
    `- Encoding diagnostics: ${processed.hasEncodingIssues ? 'issues detected; affected text may be unreliable' : 'no issues detected'}`,
  ];
  const renderedPages = pages.pages.map((page) => {
    const pageNumber = page.page + 1;
    const pageReasons = reasons.get(pageNumber) ?? (page.ocrReason ? [page.ocrReason] : []);
    const needsOcr = page.needsOcr || pagesNeedingOcr.includes(pageNumber);
    const title = `## Page ${pageNumber}${needsOcr ? ` — OCR/vision needed${pageReasons.length > 0 ? ` (${pageReasons.join(', ')})` : ''}` : ''}`;
    const markdown = page.markdown.trim();
    if (markdown) return `${title}\n\n${markdown}`;
    return `${title}\n\n[No reliable local text-layer content was extracted from this page.]`;
  });
  if (pagesNeedingOcr.length > 0) {
    renderedPages.push(
      `## OCR/vision guidance\n\nPages ${pagesNeedingOcr.join(', ')} require local OCR or page rendering with a vision-capable tool. No hosted or local OCR was invoked, and unread pages are not represented as extracted text.`,
    );
  }
  return {
    markdown: [...header, '', ...renderedPages].join('\n'),
    format: 'pdf',
    omissions:
      pagesNeedingOcr.length > 0
        ? [`PDF pages requiring OCR/vision: ${pagesNeedingOcr.join(', ')}`]
        : [],
    pdf: {
      classification: classification.pdfType,
      confidence: classification.confidence,
      pageCount: classification.pageCount,
      pagesNeedingOcr,
      pagesWithTables,
      pagesWithColumns,
      hasEncodingIssues: processed.hasEncodingIssues,
    },
  };
}

function classifyAnydocError(error: unknown, family: string): RobustReadError {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  if (code === 'encrypted')
    return new RobustReadError('encrypted', `${family} document is encrypted: ${message}`);
  if (code === 'resourceLimit') {
    const decompression = /decompress|compression|zip|archive/iu.test(message);
    return new RobustReadError(
      decompression ? 'decompression_risk' : 'resource_limited',
      `${family} conversion stopped at a safety limit: ${message}`,
      { cause: error },
    );
  }
  if (code === 'unsupported')
    return new RobustReadError('unsupported', `${family} format is unsupported: ${message}`);
  if (code === 'missingPart' || code === 'malformed') {
    return new RobustReadError('malformed', `${family} document is malformed: ${message}`);
  }
  return new RobustReadError('malformed', `${family} conversion failed: ${message}`, {
    cause: error,
  });
}

export async function convertStructuredDocument(
  bytes: Buffer,
  sourcePath: string,
  config: RobustReadConfig,
  dependencies: RobustReadDependencies = {},
): Promise<ConvertedDocument> {
  const format = structuredFormatForPath(sourcePath);
  if (format === 'notebook') {
    const notebook = renderNotebook(bytes, sourcePath, config);
    return { ...notebook, format: 'notebook' };
  }
  if (format === 'pdf') {
    let inspector: PdfInspectorModule;
    try {
      inspector = await (dependencies.loadPdfInspector ?? defaultLoadPdfInspector)();
    } catch (error) {
      if (error instanceof RobustReadError) throw error;
      throw dependencyError(error, '@firecrawl/pdf-inspector');
    }
    try {
      const classification = inspector.classifyPdf(bytes);
      const processed = inspector.processPdf(bytes);
      const pages = inspector.extractPagesMarkdown(bytes);
      return renderPdf(classification, processed, pages);
    } catch (error) {
      if (error instanceof RobustReadError) throw error;
      throw classifyPdfError(error);
    }
  }
  if (format === 'anydoc') {
    const extension = extname(sourcePath).toLowerCase();
    const anydocFormat = ANYDOC_FORMATS[extension];
    const family = anydocFamilyForPath(sourcePath) ?? 'Structured';
    let anydoc: AnydocModule;
    try {
      anydoc = await (dependencies.loadAnydoc ?? defaultLoadAnydoc)();
    } catch (error) {
      if (error instanceof RobustReadError) throw error;
      throw dependencyError(error, '@firecrawl/anydoc');
    }
    try {
      const markdown = await anydoc.toMarkdownBytes(bytes, anydocFormat);
      return { markdown, format: 'anydoc', omissions: [] };
    } catch (error) {
      throw classifyAnydocError(error, family);
    }
  }
  throw new RobustReadError('unsupported', `Unsupported structured format: ${sourcePath}`);
}
