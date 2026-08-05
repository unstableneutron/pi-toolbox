export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ExecutorAuth =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; password: string };

export type ExecutorEndpointSource =
  | 'environment'
  | 'explicit-config'
  | 'project-config'
  | 'user-config'
  | 'executor-profile'
  | 'daemon-manifest'
  | 'localhost-default';

export type ExecutorEndpointPreference = 'auto' | 'environment' | 'config' | 'profile' | 'local';

export interface ExecutorEndpoint {
  mcpUrl: string;
  auth?: ExecutorAuth;
  requestTimeoutMs: number;
  yieldAfterMs: number;
  maxOutputBytes: number;
  maxOutputLines: number;
  source: ExecutorEndpointSource;
  sourcePath?: string;
  profileName?: string;
  authExpiresAt?: number;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export type ExecutorElicitationRequest =
  | {
      mode: 'form';
      message: string;
      requestedSchema: JsonObject;
    }
  | {
      mode: 'url';
      message: string;
      url: string;
      elicitationId: string;
    };

export interface ExecutorElicitationResponse {
  action: ElicitationAction;
  content?: JsonObject;
}

export interface ExecutorMcpResult {
  text: string;
  structuredContent: JsonValue;
  isError: boolean;
}

export interface ExecutorMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

export interface ExecutorMcpResource {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
}

export interface ExecutorMcpInspection {
  instructions?: string;
  tools: ExecutorMcpTool[];
  resources: ExecutorMcpResource[];
}
