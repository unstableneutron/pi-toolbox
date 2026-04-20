function normalizeBuffer(buffer: string): string {
  return buffer.replace(/\r\n/g, '\n');
}

function parseChunk(chunk: string): unknown {
  const data = chunk
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim();

  if (!data || data === '[DONE]') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export async function* parseSseJson(response: Response): AsyncGenerator<unknown> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      buffer = normalizeBuffer(buffer + decoder.decode(value, { stream: true }));
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const parsed = parseChunk(buffer.slice(0, boundary));
        if (parsed !== undefined) {
          yield parsed;
        }
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }

    const trailing = parseChunk(normalizeBuffer(buffer).trim());
    if (trailing !== undefined) {
      yield trailing;
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors.
    }
  }
}
