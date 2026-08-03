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
  | 'daemon-manifest';

export interface ExecutorEndpoint {
  baseUrl: string;
  auth?: ExecutorAuth;
  requestTimeoutMs: number;
  source: ExecutorEndpointSource;
  sourcePath?: string;
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

export interface ExecutorMcpInspection {
  instructions?: string;
  tools: Array<{ name: string; description?: string }>;
}
