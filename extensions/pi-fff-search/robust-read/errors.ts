export type RobustReadErrorCode =
  | 'not_found'
  | 'broken_symlink'
  | 'symlink_loop'
  | 'ambiguous_path'
  | 'not_regular'
  | 'directory'
  | 'changed_during_read'
  | 'unsupported'
  | 'malformed'
  | 'encrypted'
  | 'resource_limited'
  | 'decompression_risk'
  | 'missing_dependency'
  | 'unsupported_platform'
  | 'aborted';

export class RobustReadError extends Error {
  readonly code: RobustReadErrorCode;
  readonly requestedPath?: string;
  readonly candidates?: string[];

  constructor(
    code: RobustReadErrorCode,
    message: string,
    options: { cause?: unknown; requestedPath?: string; candidates?: string[] } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RobustReadError';
    this.code = code;
    this.requestedPath = options.requestedPath;
    this.candidates = options.candidates;
  }
}

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof RobustReadError &&
    (error.code === 'not_found' || error.code === 'broken_symlink' || error.code === 'symlink_loop')
  );
}
