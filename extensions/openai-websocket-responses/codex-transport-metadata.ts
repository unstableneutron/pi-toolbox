import {
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type StreamOptions,
} from '@earendil-works/pi-ai';

const CODEX_API = 'openai-codex-responses';
const SOURCE_ID = 'extension:openai-websocket-responses/codex-transport-metadata';

type StreamLike<TOptions extends StreamOptions> = (
  model: Model<Api>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

const WEBSOCKET_UPGRADE_RESPONSE: ProviderResponse = {
  status: 101,
  headers: {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'x-pi-observed-transport': 'websocket',
  },
};

function envFlagEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw === '1' || raw?.toLowerCase() === 'true' || raw?.toLowerCase() === 'yes';
}

export function shouldPatchOpenAICodexTransportMetadata(): boolean {
  return envFlagEnabled('OPENAI_WEBSOCKET_RESPONSES_PATCH_CODEX_TRANSPORT_METADATA');
}

function shouldSynthesizeWebSocketResponse(options: StreamOptions | undefined): boolean {
  return options?.transport !== 'sse';
}

export function wrapCodexStreamWithTransportMetadata<TOptions extends StreamOptions>(
  streamFn: StreamLike<TOptions>,
): StreamLike<TOptions> {
  return (model, context, options) => {
    let sawResponse = false;
    let emittedSyntheticResponse = false;
    const originalOnResponse = options?.onResponse;
    const wrappedOptions = {
      ...options,
      onResponse: async (response: ProviderResponse, responseModel: Model<Api>) => {
        sawResponse = true;
        await originalOnResponse?.(response, responseModel);
      },
    } as TOptions;

    const source = streamFn(model, context, wrappedOptions);
    const proxy = createAssistantMessageEventStream();

    const emitSyntheticResponse = async (): Promise<void> => {
      if (sawResponse || emittedSyntheticResponse || !shouldSynthesizeWebSocketResponse(options)) {
        return;
      }
      sawResponse = true;
      emittedSyntheticResponse = true;
      await originalOnResponse?.(WEBSOCKET_UPGRADE_RESPONSE, model);
    };

    void (async () => {
      try {
        for await (const event of source) {
          if (event.type === 'start') {
            await emitSyntheticResponse();
          }
          proxy.push(event);
        }
      } finally {
        proxy.end();
      }
    })();

    return proxy;
  };
}

export function installOpenAICodexTransportMetadataPatch(): boolean {
  if (!shouldPatchOpenAICodexTransportMetadata()) {
    return false;
  }

  const provider = getApiProvider(CODEX_API);
  if (!provider) {
    return false;
  }

  registerApiProvider(
    {
      api: CODEX_API,
      stream: wrapCodexStreamWithTransportMetadata(provider.stream),
      streamSimple: wrapCodexStreamWithTransportMetadata(provider.streamSimple),
    },
    SOURCE_ID,
  );
  return true;
}
