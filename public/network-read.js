// Only safe, read-only listing requests may be retried. Never retry a write.
const SAFE_READ = /^\/api\/(?:cards|pending|unresolved|usage|jobs\/(?:latest|[a-f0-9-]+))$/i;

export function isTransientFetchError(error) {
  return error instanceof TypeError || error?.name === "AbortError";
}

export async function fetchReadWithRetry(fetcher, path, options = undefined, { pause = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 12000 } = {}) {
  const method = String(options?.method || "GET").toUpperCase();
  const canRetry = method === "GET" && SAFE_READ.test(String(path));
  if (!canRetry) return fetcher(path, options);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(path, { ...options, signal: controller.signal });
    } catch (error) {
      if (!isTransientFetchError(error) || attempt === 1) throw error;
      await pause(650);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("GET retry exhausted");
}
