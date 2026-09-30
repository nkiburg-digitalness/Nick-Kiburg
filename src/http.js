export class HttpError extends Error {
  constructor(message, { status, body, retryAfterSeconds } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** fetch() that throws HttpError on non-2xx and parses JSON responses. */
export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const detail = typeof data === 'object' && data ? (data.detail || data.message || data.title || JSON.stringify(data)) : text;
    throw new HttpError(`${method} ${url} → ${res.status}: ${String(detail).slice(0, 300)}`, {
      status: res.status,
      body: data,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
    });
  }
  return { status: res.status, data, headers: res.headers };
}
