import type { FileHandle } from 'node:fs/promises';
import { RobustReadError } from './errors';
import { SessionReadLedger } from './ledger';
import { paginateString, paginateUtf8File } from './pagination';
import { openValidatedRegular, resolveValidatedTarget } from './path';
import { convertStructuredDocument, structuredFormatForPath } from './structured';
import type {
  FileIdentity,
  RobustRead,
  RobustReadConfig,
  RobustReadDependencies,
  RobustReadDetails,
  ValidatedTarget,
} from './types';
import { identityFromStats } from './types';

export interface RobustReadRequest {
  path: string;
  offset?: number;
  limit?: number;
  responsePrefix?: string;
  recoveredFromPath?: string;
}

export interface RobustReader {
  read(
    request: RobustReadRequest,
    context: { cwd: string; sessionId: string; signal?: AbortSignal },
  ): Promise<RobustRead>;
}

async function imageMimeType(handle: FileHandle): Promise<string | null> {
  const header = Buffer.alloc(16);
  const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
  const bytes = header.subarray(0, bytesRead);
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 6 &&
    (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  return null;
}

async function readStructuredBytes(
  handle: FileHandle,
  target: ValidatedTarget,
  config: RobustReadConfig,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (target.stats.size > config.structuredSourceMaxBytes) {
    throw new RobustReadError(
      'resource_limited',
      `Structured source is ${target.stats.size.toLocaleString('en-US')} bytes; limit is ${config.structuredSourceMaxBytes.toLocaleString('en-US')} bytes.`,
      { requestedPath: target.requestedPath },
    );
  }

  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= config.structuredSourceMaxBytes) {
    if (signal?.aborted) throw new RobustReadError('aborted', 'Operation aborted');
    const remaining = config.structuredSourceMaxBytes + 1 - position;
    const chunk = Buffer.allocUnsafe(Math.min(config.streamChunkBytes, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position > config.structuredSourceMaxBytes) {
    throw new RobustReadError(
      'resource_limited',
      `Structured source exceeded the ${config.structuredSourceMaxBytes.toLocaleString('en-US')}-byte limit while reading.`,
      { requestedPath: target.requestedPath },
    );
  }
  return Buffer.concat(chunks, position);
}

function detailsFor(
  target: ValidatedTarget,
  identity: FileIdentity,
  format: RobustReadDetails['format'],
  request: RobustReadRequest,
  config: RobustReadConfig,
): RobustReadDetails {
  return {
    robustRead: true,
    canonicalPath: target.canonicalPath,
    identity,
    format,
    requestedOffset: request.offset ?? 1,
    requestedLimit: Math.min(request.limit ?? config.maxLines, config.maxLines),
    recoveredFromPath: request.recoveredFromPath ?? target.recoveredFrom,
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function recoveryNotice(target: ValidatedTarget): string | null {
  return target.recoveredFrom
    ? `Path (fixed): ${target.canonicalPath}\nAuto-resolved Unicode/punctuation-equivalent path '${target.recoveredFrom}'.`
    : null;
}

function boundedNotice(raw: string | null, maxResponseBytes: number): string | null {
  if (!raw || maxResponseBytes < 4) return null;
  const reservedContentBytes = Math.min(128, Math.floor(maxResponseBytes / 2));
  const budget = Math.max(0, maxResponseBytes - reservedContentBytes - 2);
  if (Buffer.byteLength(raw, 'utf8') <= budget) return raw;
  const marker = '… [path notice shortened]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  return `${truncateUtf8(raw, Math.max(0, budget - markerBytes))}${marker}`;
}

function regionKey(request: RobustReadRequest, config: RobustReadConfig): string {
  return `${request.offset ?? 1}:${Math.min(request.limit ?? config.maxLines, config.maxLines)}`;
}

export function createRobustReader(
  config: RobustReadConfig,
  dependencies: RobustReadDependencies = {},
  ledger = new SessionReadLedger(),
): RobustReader {
  return {
    async read(request, context) {
      const target = await resolveValidatedTarget(request.path, context.cwd, config);
      if (target.stats.isDirectory()) return { kind: 'directory', target };

      const handle = await openValidatedRegular(target);
      const identity = identityFromStats(target.stats);
      try {
        const readRegion = regionKey(request, config);
        const notice = boundedNotice(
          request.responsePrefix ?? recoveryNotice(target),
          config.maxResponseBytes,
        );
        const noticeBytes = notice ? Buffer.byteLength(`${notice}\n\n`, 'utf8') : 0;
        const pageConfig = noticeBytes
          ? { ...config, maxResponseBytes: config.maxResponseBytes - noticeBytes }
          : config;
        const mimeType = await imageMimeType(handle);
        if (mimeType) {
          if (
            config.deduplicateReads &&
            ledger.isUnchanged(context.sessionId, target.canonicalPath, identity, readRegion)
          ) {
            const details = detailsFor(target, identity, 'image', request, config);
            details.unchanged = true;
            const unchanged =
              '[Image unchanged since this session read the same region. Refer to the earlier image attachment.]';
            const content = notice ? `${notice}\n\n${unchanged}` : unchanged;
            details.responseBytes = Buffer.byteLength(content, 'utf8');
            return {
              kind: 'text',
              content,
              details,
            };
          }
          const buffer = await handle.readFile();
          ledger.recordRead(
            context.sessionId,
            target.canonicalPath,
            identity,
            readRegion,
            target.absolutePath,
          );
          return { kind: 'image', target, identity, buffer, mimeType, notice: notice ?? undefined };
        }

        const format = structuredFormatForPath(target.canonicalPath);
        if (
          config.deduplicateReads &&
          ledger.isUnchanged(context.sessionId, target.canonicalPath, identity, readRegion)
        ) {
          const details = detailsFor(target, identity, format ?? 'text', request, config);
          details.unchanged = true;
          const unchanged =
            '[File unchanged since this session read the same region. Refer to the earlier read result.]';
          const content = notice ? `${notice}\n\n${unchanged}` : unchanged;
          details.responseBytes = Buffer.byteLength(content, 'utf8');
          return {
            kind: 'text',
            content,
            details,
          };
        }

        let paginated;
        let details: RobustReadDetails;
        if (format) {
          const bytes = await readStructuredBytes(handle, target, config, context.signal);
          const converted = await convertStructuredDocument(
            bytes,
            target.canonicalPath,
            config,
            dependencies,
          );
          paginated = paginateString(converted.markdown, request, pageConfig);
          details = detailsFor(target, identity, converted.format, request, config);
          details.omissions = converted.omissions;
          details.pdf = converted.pdf;
        } else {
          paginated = await paginateUtf8File(
            handle,
            { ...request, signal: context.signal },
            pageConfig,
          );
          details = detailsFor(target, identity, 'text', request, config);
        }

        details.nextOffset = paginated.nextOffset;
        details.hasMore = paginated.hasMore;
        details.responseBytes = paginated.responseBytes + noticeBytes;
        details.sourceBytesRead = paginated.sourceBytesRead;
        details.invalidUtf8 = paginated.invalidUtf8;
        details.clampedLines = paginated.clampedLines;
        ledger.recordRead(
          context.sessionId,
          target.canonicalPath,
          identity,
          readRegion,
          target.absolutePath,
        );
        return {
          kind: 'text',
          content: notice ? `${notice}\n\n${paginated.text}` : paginated.text,
          details,
        };
      } finally {
        if (handle.fd >= 0) await handle.close().catch(() => undefined);
      }
    },
  };
}
