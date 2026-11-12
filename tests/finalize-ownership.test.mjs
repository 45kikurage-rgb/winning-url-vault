import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("..",import.meta.url));
globalThis.fetch = () => { throw new Error("external fetch blocked"); };
const { default: worker } = await import(pathToFileURL(resolve(root, "src/index.js")));
const job = "00000000-0000-4000-8000-000000000001";
const url = "https://example.test/race-only";
const stageRead = "SELECT ji.item_id,i.value,i.canonical_value,i.value_type";
const finalizeRead = "SELECT s.item_id,s.result_json,s.error_reason";

function barrier() {
  let notifyEntered;
  let resume;
  const entered = new Promise(resolve => { notifyEntered = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  return { entered, resume, async wait() { notifyEntered(); await released; } };
}

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(resolve(root, "schema.sql"), "utf8"));
  sql.prepare("INSERT INTO analysis_jobs(id,client_request_id,input_total,accepted_count,status) VALUES(?,?,1,1,'processing')").run(job, job);
  sql.prepare("INSERT INTO items(id,value,canonical_value,value_type,status) VALUES('item',?,?,'url','queued')").run(url, url);
  sql.prepare("INSERT INTO analysis_job_items(job_id,item_id,ordinal,state) VALUES(?,'item',0,'staged')").run(job);
  sql.prepare("INSERT INTO analysis_staging(item_id,job_id,batch_no,error_reason) VALUES('item',?,0,'synthetic')").run(job);
  return sql;
}

function d1(sql, pauseAt, pause, beforeBatch) {
  return {
    prepare(query) {
      const stmt = sql.prepare(query);
      let args = [];
      return {
        query,
        bind(...values) { args = values; return this; },
        async first() { return stmt.get(...args) ?? null; },
        async all() {
          const results = stmt.all(...args);
          if (pauseAt && query.startsWith(pauseAt)) await pause.wait();
          return { results };
        },
        execute() { return stmt.run(...args); },
        async run() { return { meta: this.execute() }; }
      };
    },
    async batch(statements) {
      if (beforeBatch && statements.some(statement => statement.query.startsWith(pauseAt))) await pause.wait();
      sql.exec("BEGIN");
      try {
        const results = statements.map(stmt => stmt.execute());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function send(sql, type, options = {}) {
  const { pauseAt, pause, next = [], beforeBatch } = options;
  const outcome = [];
  const env = {
    DB: d1(sql, pauseAt, pause, beforeBatch),
    COUPON_ANALYZER: { async fetch() { return Response.json({ results: [] }); } },
    ANALYSIS_QUEUE: { async send(body) { next.push(body); } }
  };
  return worker.queue({ messages: [{
    body: { jobId: job, type, batchNo: 0 },
    ack() { outcome.push("ack"); },
    retry() { outcome.push("retry"); }
  }] }, env).then(() => outcome);
}

function status(sql) {
  const jobState = sql.prepare("SELECT status FROM analysis_jobs").get().status;
  const itemState = sql.prepare("SELECT state FROM analysis_job_items").get().state;
  const stages = sql.prepare("SELECT COUNT(*) n FROM analysis_staging").get().n;
  const audits = sql.prepare("SELECT COUNT(*) n FROM audit_log").get().n;
  return { jobState, itemState, stages, audits };
}

test("duplicate analyze cannot break an active finalizer or duplicate its history", async () => {
  const sql = fixture();
  const pause = barrier();
  const first = send(sql, "finalize", { pauseAt: finalizeRead, pause });
  await pause.entered;
  assert.equal(status(sql).jobState, "finalizing");
  const next = [];
  assert.deepEqual(await send(sql, "analyze", { next }), ["ack"]);
  assert.equal(status(sql).jobState, "finalizing");
  assert.equal(next.length, 0);
  assert.deepEqual(await send(sql,"finalize"), ["ack"]);
  pause.resume();
  assert.deepEqual(await first, ["ack"]);
  assert.deepEqual(status(sql), { jobState:"completed", itemState:"done", stages:0, audits:1 });
  sql.close();
});

test("late stage cannot recreate staging after completion", async () => {
  const sql = fixture();
  sql.exec("DELETE FROM analysis_staging; UPDATE analysis_job_items SET state='queued'");
  const pause = barrier();
  const next = [];
  const delayed = send(sql, "analyze", { pauseAt: stageRead, pause, next });
  await pause.entered;
  const actual = [];
  assert.deepEqual(await send(sql,"analyze",{next:actual}),["ack"]);
  assert.equal(actual.length,1);
  assert.deepEqual(await send(sql,"finalize"),["ack"]);
  pause.resume();
  assert.deepEqual(await delayed,["ack"]);
  assert.equal(next.length,0);
  assert.deepEqual(status(sql), { jobState:"completed", itemState:"done", stages:0, audits:1 });
  sql.close();
});

test("expired owner is fenced after a checkpoint and new owner completes without duplicating audit", async () => {
  const sql = fixture();
  const pause = barrier();
  const stale = send(sql,"finalize",{pauseAt:"DELETE FROM analysis_staging",pause,beforeBatch:true});
  await pause.entered;
  assert.deepEqual(status(sql), { jobState:"finalizing", itemState:"done", stages:1, audits:1 });
  sql.exec("UPDATE analysis_jobs SET finalize_until='2000-01-01T00:00:00.000Z'");
  assert.deepEqual(await send(sql,"finalize"),["ack"]);
  pause.resume();
  assert.deepEqual(await stale,["retry"]);
  assert.deepEqual(status(sql), { jobState:"completed", itemState:"done", stages:0, audits:1 });
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM analysis_finalize_guard").get().n,0);
  sql.close();
});

test("old ownerless finalizing jobs are left for review, not automatically reprocessed", async () => {
  const sql = fixture();
  sql.exec("UPDATE analysis_jobs SET status='finalizing'");
  assert.deepEqual(await send(sql,"finalize"),["ack"]);
  assert.deepEqual(status(sql), { jobState:"finalizing", itemState:"staged", stages:1, audits:0 });
  sql.close();
});
