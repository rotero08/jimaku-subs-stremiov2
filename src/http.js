// Outgoing HTTP: a timeout on everything, a ceiling on how much is read, and errors that carry
// what a caller needs to decide what to do next.

export class HttpError extends Error {
  constructor(message, { status = 0, headers = new Headers(), url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
    this.url = url;
  }
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(`response is ${declared} bytes, over the ${maxBytes} byte limit`, { status: 413 });
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(`response is over the ${maxBytes} byte limit`, { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetches `url` and returns { status, headers, body (Buffer) }. Redirects are followed by hand, up to
 * `maxRedirects`, and `allowRedirect(url)` may veto each hop (used to stay on trusted hosts).
 */
export async function request(fetchImpl, url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 6000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirects = 3,
    allowRedirect = () => true,
  } = options;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let response;
    try {
      response = await fetchImpl(current, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const cause = error?.cause;
      const why = cause?.code ?? cause?.errors?.[0]?.code ?? cause?.message ?? error?.message;
      throw new HttpError(timedOut ? `timed out after ${timeoutMs} ms` : `network error: ${why}`, { url: current });
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'), current).href;
      await response.body?.cancel().catch(() => {});
      if (hop === maxRedirects || !allowRedirect(next)) {
        throw new HttpError(`redirect to ${new URL(next).host} refused`, { status: response.status, url: current });
      }
      current = next;
      continue;
    }
    return { status: response.status, headers: response.headers, body: await readLimited(response, maxBytes), url: current };
  }
  throw new HttpError('too many redirects', { url });
}

/** GET JSON, returning { data, headers }; a non-2xx answer becomes an HttpError carrying the status and headers. */
export async function requestJson(fetchImpl, url, options = {}) {
  const result = await request(fetchImpl, url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new HttpError(`HTTP ${result.status}`, { status: result.status, headers: result.headers, url });
  }
  try {
    return { data: JSON.parse(result.body.toString('utf8')), headers: result.headers };
  } catch {
    throw new HttpError('the answer was not valid JSON', { status: result.status, headers: result.headers, url });
  }
}

/** GET JSON and return just the parsed body. */
export async function getJson(fetchImpl, url, options = {}) {
  return (await requestJson(fetchImpl, url, options)).data;
}
