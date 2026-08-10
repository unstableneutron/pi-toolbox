import type { Stats } from 'node:fs';

export type StructuredFormat = 'notebook' | 'pdf' | 'anydoc';

export interface RobustReadConfig {
  maxLines: number;
  maxResponseBytes: number;
  maxLineCharacters: number;
  structuredSourceMaxBytes: number;
  siblingScanLimit: number;
  maxPathSuggestions: number;
  streamChunkBytes: number;
  notebookOutputMaxCharacters: number;
  deduplicateReads: boolean;
  enforceReadBeforeWrite: boolean;
  rejectStaleWrites: boolean;
}

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ValidatedTarget {
  requestedPath: string;
  absolutePath: string;
  canonicalPath: string;
  stats: Stats;
  recoveredFrom?: string;
}

export interface PaginatedText {
  text: string;
  startLine: number;
  endLine?: number;
  nextOffset?: number;
  totalLines?: number;
  hasMore: boolean;
  truncatedBy?: 'lines' | 'bytes';
  clampedLines: number[];
  invalidUtf8: boolean;
  responseBytes: number;
  sourceBytesRead?: number;
}

export interface RobustReadDetails {
  robustRead: true;
  canonicalPath: string;
  identity: FileIdentity;
  format: 'text' | 'image' | 'notebook' | 'pdf' | 'anydoc';
  requestedOffset: number;
  requestedLimit: number;
  nextOffset?: number;
  hasMore?: boolean;
  responseBytes?: number;
  sourceBytesRead?: number;
  invalidUtf8?: boolean;
  clampedLines?: number[];
  recoveredFromPath?: string;
  unchanged?: boolean;
  pdf?: {
    classification: string;
    confidence: number;
    pageCount: number;
    pagesNeedingOcr: number[];
    pagesWithTables: number[];
    pagesWithColumns: number[];
    hasEncodingIssues: boolean;
  };
  omissions?: string[];
}

export interface RobustTextRead {
  kind: 'text';
  content: string;
  details: RobustReadDetails;
}

export interface RobustImageRead {
  kind: 'image';
  target: ValidatedTarget;
  identity: FileIdentity;
  buffer: Buffer;
  mimeType: string;
  notice?: string;
}

export interface RobustDirectoryRead {
  kind: 'directory';
  target: ValidatedTarget;
}

export type RobustRead = RobustTextRead | RobustImageRead | RobustDirectoryRead;

export interface PdfInspectorModule {
  classifyPdf(buffer: Buffer): {
    pdfType: string;
    pageCount: number;
    pagesNeedingOcr: number[];
    confidence: number;
  };
  processPdf(buffer: Buffer): {
    pdfType: string;
    markdown?: string;
    pageCount: number;
    confidence: number;
    pagesNeedingOcr: number[];
    ocrReasonsByPage: Array<{ page: number; reasons: string[] }>;
    pagesWithTables: number[];
    pagesWithColumns: number[];
    hasEncodingIssues: boolean;
  };
  extractPagesMarkdown(buffer: Buffer): {
    pages: Array<{ page: number; markdown: string; needsOcr: boolean; ocrReason?: string }>;
    pagesWithTables: number[];
    pagesWithColumns: number[];
    pagesNeedingOcr: number[];
    ocrReasonsByPage: Array<{ page: number; reasons: string[] }>;
    isComplex: boolean;
  };
}

export interface AnydocModule {
  toMarkdownBytes(bytes: Uint8Array, format?: string): Promise<string>;
}

export interface RobustReadDependencies {
  loadPdfInspector?: () => Promise<PdfInspectorModule>;
  loadAnydoc?: () => Promise<AnydocModule>;
}

export function identityFromStats(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

export function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
