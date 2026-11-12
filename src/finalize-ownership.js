const LEASE_MS = 5 * 60 * 1000;
const leaseEnd = () => new Date(Date.now() + LEASE_MS).toISOString();

const ready = `NOT EXISTS (SELECT 1 FROM analysis_job_items ji
  WHERE ji.job_id=analysis_jobs.id AND (ji.state NOT IN ('staged','done')
    OR (ji.state='staged' AND NOT EXISTS (SELECT 1 FROM analysis_staging s
      WHERE s.job_id=ji.job_id AND s.item_id=ji.item_id))))`;
const recoverable = `(status IN ('queued','processing') OR
  (status='finalizing' AND finalize_owner IS NOT NULL AND finalize_until<=?))`;

export async function claimFinalization(db, jobId) {
  const owner = crypto.randomUUID();
  const now = new Date().toISOString();
  const claimed = await db.prepare(`UPDATE analysis_jobs SET status='finalizing',finalize_owner=?,finalize_until=?,updated_at=?
    WHERE id=? AND ${recoverable} AND ${ready}`).bind(owner,leaseEnd(),now,jobId,now).run();
  if (!Number(claimed.meta?.changes)) return null;

  return {
    async write(statements, items = []) {
      const operations = [
        db.prepare(`INSERT INTO analysis_finalize_guard(job_id,current_owner) VALUES (?,EXISTS(
          SELECT 1 FROM analysis_jobs WHERE id=? AND status='finalizing' AND finalize_owner=?))`).bind(jobId,jobId,owner),
        ...statements
      ];
      if (items.length) {
        operations.push(db.prepare(`UPDATE analysis_job_items SET state='done',updated_at=?
          WHERE job_id=? AND state='staged' AND item_id IN (${items.map(() => "?").join(",")})`)
          .bind(new Date().toISOString(),jobId,...items));
      }
      operations.push(
        db.prepare("UPDATE analysis_jobs SET finalize_until=? WHERE id=? AND finalize_owner=?").bind(leaseEnd(),jobId,owner),
        db.prepare("DELETE FROM analysis_finalize_guard WHERE job_id=?").bind(jobId)
      );
      return (await db.batch(operations)).slice(1,1+statements.length);
    },
    async release(error) {
      await db.prepare(`UPDATE analysis_jobs SET status='processing',last_error=?,updated_at=?,
        finalize_owner=NULL,finalize_until=NULL WHERE id=? AND status='finalizing' AND finalize_owner=?`)
        .bind(error instanceof Error ? error.message : String(error),new Date().toISOString(),jobId,owner).run();
    }
  };
}

export async function recoverFinalizations(env, finalize) {
  const jobs = await env.DB.prepare(`SELECT id FROM analysis_jobs
    WHERE ${recoverable} AND ${ready} ORDER BY updated_at LIMIT 10`).bind(new Date().toISOString()).all();
  for (const {id} of jobs.results || []) {
    try {
      if (env.ANALYSIS_QUEUE?.send) await env.ANALYSIS_QUEUE.send({type:"finalize",jobId:id});
      else await finalize(env,id);
    } catch (error) {
      console.error("analysis recovery",id,error);
    }
  }
}
