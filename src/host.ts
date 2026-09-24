/**
 * Turn an OLLAMA_HOST value ("0.0.0.0", "127.0.0.1:11434", "http://box:8080") into a base URL
 * we can connect to. Mirrors how the Ollama CLI reads the variable.
 */
export function normalizeHost(raw: string | undefined, defaultPort = 11434): string {
  let value = (raw ?? '').trim();
  if (!value) return `http://127.0.0.1:${defaultPort}`;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  // A server bound to every interface is reached through loopback.
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1';
  if (!url.port && url.protocol === 'http:') url.port = String(defaultPort);
  return url.origin;
}
