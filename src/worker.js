import baseHandler from "./index.js";
import { handleLedgerRoute, processOutbox, resetLedgerTrialData } from "./ledger.js";

async function authenticationProbe(request, env) {
  const url = new URL(request.url);
  const probe = new Request(new URL("/api/status", url.origin), { method: "GET", headers: request.headers });
  return baseHandler.fetch(probe, env);
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/ledger/")) {
      const auth = await authenticationProbe(request, env);
      if (auth.status === 401) return auth;
      if (!auth.ok) return auth;
      return handleLedgerRoute(request, env);
    }
    if (path === "/api/trial/reset" && request.method === "POST") {
      const response = await baseHandler.fetch(request, env, ctx);
      if (response.ok) {
        const payload = await response.clone().json().catch(() => ({}));
        if (payload.ok) await resetLedgerTrialData(env);
      }
      return response;
    }
    return baseHandler.fetch(request, env, ctx);
  },
  async queue(batch, env, ctx) {
    if (typeof baseHandler.queue === "function") return baseHandler.queue(batch, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processOutbox(env, 50));
  }
};
