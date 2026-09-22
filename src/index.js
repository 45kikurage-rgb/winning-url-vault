const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const normalize=s=>String(s||"").normalize("NFKC").replace(/[‐‑‒–—―ー-]/g,"-").replace(/\s+/g," ").trim().toLowerCase();

function classifyCode(value){
  const text=String(value||"").trim();
  if(/^cd[A-Za-z0-9]{12}$/.test(text)) return {type:"cokeon",normalized:text};
  if(/^[A-Za-z0-9]{16}$/.test(text)||/^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){3}$/.test(text)) return {type:"paypay_candidate",normalized:text};
  return null;
}

async function ensureSchema(env){
  // Production migrations should use schema.sql; this health check only verifies binding.
  return Boolean(env.DB);
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==="/api/status") return json({ok:await ensureSchema(env),version:"0.1.0"});
  if(url.pathname==="/api/classify-code"&&request.method==="POST"){
    const body=await request.json().catch(()=>({}));
    return json({ok:true,result:classifyCode(body.value)});
  }
  if(url.pathname==="/api/unresolved"&&request.method==="GET"){
    const rows=await env.DB.prepare(`SELECT i.id,i.value,i.received_at,u.reason,u.pattern_key,u.retry_count FROM unresolved_items u JOIN items i ON i.id=u.item_id ORDER BY i.received_at ASC LIMIT 500`).all();
    return json({ok:true,items:rows.results||[]});
  }
  if(url.pathname==="/api/cards"&&request.method==="GET"){
    const rows=await env.DB.prepare(`SELECT c.id,c.expires_on,c.price_label,p.display_name,p.raw_name,p.redeem_place,p.specification,COUNT(i.id) count FROM cards c JOIN product_master p ON p.id=c.product_id LEFT JOIN items i ON i.card_id=c.id AND i.status='active' GROUP BY c.id ORDER BY c.created_at DESC`).all();
    return json({ok:true,cards:rows.results||[]});
  }
  return env.ASSETS.fetch(request);
 }
};