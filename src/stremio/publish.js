// Announcing the addon to Stremio's community catalogue (the same call the old SDK made).

/**
 * @param {string} manifestUrl  public address of /manifest.json
 * @param {typeof fetch} [fetchImpl]
 */
export async function publishToCentral(manifestUrl, fetchImpl = globalThis.fetch, apiUrl = 'https://api.strem.io') {
  const response = await fetchImpl(`${apiUrl}/api/addonPublish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transportUrl: manifestUrl, transportName: 'http' }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? `HTTP ${response.status}`);
  return body.result;
}
