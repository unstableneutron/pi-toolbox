declare module 'fff-router' {
  import type { TSchema } from 'typebox';

  export type Result<T, TError extends { code: string; message: string } = PublicError> =
    | { ok: true; value: T }
    | { ok: false; error: TError };

  export type PublicToolName = 'fff_find_files' | 'fff_search_terms' | 'fff_grep';
  export type PublicOutputMode = 'compact' | 'json';

  export type PublicErrorCode =
    | 'INVALID_REQUEST'
    | 'WITHIN_NOT_FOUND'
    | 'OUTSIDE_ALLOWED_SCOPE'
    | 'BACKEND_UNAVAILABLE'
    | 'SEARCH_FAILED'
    | 'INTERNAL_ERROR';

  export type PublicError = {
    code: PublicErrorCode;
    message: string;
  };

  export type PublicRequestBase = {
    within?: string[];
    glob?: string;
    extensions: string[];
    excludePaths: string[];
    limit: number;
    cursor: null;
    outputMode: PublicOutputMode;
  };

  export type PublicFindFilesRequest = PublicRequestBase & {
    tool: 'fff_find_files';
    query: string;
  };

  export type PublicSearchTermsRequest = PublicRequestBase & {
    tool: 'fff_search_terms';
    terms: string[];
    contextLines: number;
  };

  export type PublicGrepRequest = PublicRequestBase & {
    tool: 'fff_grep';
    patterns: string[];
    literal: boolean;
    caseSensitive: boolean;
    contextLines: number;
  };

  export type PublicToolRequest =
    | PublicFindFilesRequest
    | PublicSearchTermsRequest
    | PublicGrepRequest;

  export type PublicCompactFindFilesResult = {
    mode: 'compact';
    base_path: string;
    next_cursor: null;
    items: Array<{ path: string }>;
  };

  export type PublicCompactTextMatch = {
    path: string;
    line: number;
    text: string;
  };

  export type PublicCompactSearchTermsResult = {
    mode: 'compact';
    base_path: string;
    next_cursor: null;
    items: PublicCompactTextMatch[];
  };

  export type PublicCompactGrepResult = {
    mode: 'compact';
    base_path: string;
    next_cursor: null;
    items: PublicCompactTextMatch[];
  };

  export type PublicCompactRenderedTextResult = {
    mode: 'compact';
    base_path: string;
    next_cursor: null;
    text: string;
  };

  export type PublicJsonReadRecommendation = {
    path: string;
    absolute_path: string;
    reason?: string;
  };

  export type PublicJsonItem = Record<string, unknown>;

  export type PublicJsonResult<TItem extends PublicJsonItem = PublicJsonItem> = {
    mode: 'json';
    base_path: string;
    next_cursor: null;
    backend_used: string;
    fallback_applied: boolean;
    fallback_reason?: 'backend_error';
    stats: {
      result_count: number;
      shown_count?: number;
      total_count?: number;
    };
    read_recommendation?: PublicJsonReadRecommendation;
    items: TItem[];
  };

  export type PublicToolResult =
    | PublicCompactFindFilesResult
    | PublicCompactSearchTermsResult
    | PublicCompactGrepResult
    | PublicCompactRenderedTextResult
    | PublicJsonResult<PublicJsonItem>;

  export type PublicToolDefinition<TInputSchema = unknown> = {
    name: PublicToolName;
    description: string;
    snippet: string;
    inputSchema: TInputSchema;
  };

  export type SearchCoordinatorResult = Result<PublicToolResult, PublicError>;

  export type ResolvedWithinFromCaller = {
    resolvedWithin: string;
  };

  export const ENABLE_SEARCH_TERMS: boolean;
  export const findFilesInputSchema: TSchema;
  export const searchTermsInputSchema: TSchema;
  export const grepInputSchema: TSchema;
  export const PUBLIC_TOOL_DEFINITIONS: readonly PublicToolDefinition<TSchema>[];

  export function normalizePublicToolInput(
    tool: PublicToolName,
    input: unknown,
  ): Result<PublicToolRequest, PublicError>;

  export function resolveWithinFromCaller(args: {
    callerCwd: string;
    within?: string | null;
    env?: NodeJS.ProcessEnv;
  }): Promise<Result<ResolvedWithinFromCaller, PublicError>>;

  export function ensureDaemonRunning(env?: NodeJS.ProcessEnv): Promise<void>;

  export function callPublicToolOverHttp(
    request: PublicToolRequest,
    env?: NodeJS.ProcessEnv,
  ): Promise<SearchCoordinatorResult>;
}
