import { WorkerEntrypoint } from "cloudflare:workers";
import { readMyBestRevenue } from "./mybest-daily-revenue.js";
export { default } from "./index.js";

export class MyBestRevenueAPI extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const month = url.searchParams.get("month") ?? "";
    if (request.method !== "GET" || url.pathname !== "/monthly" ||
        !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return new Response(null, { status: 400 });
    const db = this.env.DB.withSession ? this.env.DB.withSession("first-primary") : this.env.DB;
    const data = await readMyBestRevenue(db, month);
    return data ? Response.json(data, { headers: { "Cache-Control": "no-store" } })
      : new Response(null, { status: 409 });
  }
}
