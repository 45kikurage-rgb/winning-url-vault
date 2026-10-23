// Single-browser private signing key. The Cloudflare administrator authorizes
// first pairing by setting DEVICE_PAIRING_SHA256. No open registration endpoint.
const enc=new TextEncoder();
const MAX_SESSION=2592000, TTL=120;
const response=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{
  "content-type":"application/json; charset=utf-8","cache-control":"no-store",
  "x-content-type-options":"nosniff","referrer-policy":"no-referrer"}});
const deny=(x,s=403)=>response({ok:false,error:x},s);
const hex=x=>Array.from(new Uint8Array(x),b=>b.toString(16).padStart(2,"0")).join("");
const b64=x=>btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64=x=>Uint8Array.from(atob(x.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const eq=(a,b)=>{
  const x=enc.encode(String(a||"")),y=enc.encode(String(b||""));
  let diff=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]||0)^(y[i]||0);
  return diff===0;
};
const sha=async x=>hex(await crypto.subtle.digest("SHA-256",enc.encode(x)));
async function mac(x,s){
  const k=await crypto.subtle.importKey("raw",enc.encode(s),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return b64(await crypto.subtle.sign("HMAC",k,enc.encode(x)));
}
const originOK=req=>req.headers.get("origin")===new URL(req.url).origin;
const cookie=value=>"wuv_session="+value+"; Max-Age="+MAX_SESSION+"; Path=/; HttpOnly; Secure; SameSite=Strict";

export async function registeredDevice(env){
  return env.DB.prepare("SELECT credential_id,public_jwk,pairing_fingerprint FROM vault_login_device WHERE id=1").first();
}
export async function deviceSessionValid(env,token,device){
  if(!device||!env.SESSION_SECRET)return false;
  const p=String(token||"").split(".");
  if(p.length!==4||p[0]!=="dev"||p[1]!==device.credential_id)return false;
  const expiry=Number(p[2]),now=Math.floor(Date.now()/1000);
  if(!Number.isSafeInteger(expiry)||expiry<=now||expiry>now+MAX_SESSION+60)return false;
  return eq(p[3],await mac("vault-device-cookie:"+p[1]+":"+p[2],env.SESSION_SECRET));
}
export async function newDeviceCookie(env,deviceId){
  if(!env.SESSION_SECRET)throw new Error("SESSION_SECRET missing");
  const expiry=Math.floor(Date.now()/1000)+MAX_SESSION;
  const sig=await mac("vault-device-cookie:"+deviceId+":"+expiry,env.SESSION_SECRET);
  return cookie("dev."+deviceId+"."+expiry+"."+sig);
}
export async function enrollDevice(req,env){
  if(!originOK(req))return deny("同じ管理サイトから操作してください");
  const expected=String(env.DEVICE_PAIRING_SHA256||"");
  if(!/^[a-f0-9]{64}$/i.test(expected)||!env.SESSION_SECRET)
    return deny("Cloudflareで端末登録ハッシュを設定してください",503);
  const b=await req.json().catch(()=>({}));
  const code=String(b.pairingCode||""),jwk=b.publicJwk;
  if(!/^[A-Za-z0-9_-]{43}$/.test(code)||!eq(await sha(code),expected))
    return deny("端末登録ハッシュが一致しません",403);
  if(!jwk||jwk.kty!=="EC"||jwk.crv!=="P-256"||
    !/^[A-Za-z0-9_-]{43}$/.test(jwk.x||"")||!/^[A-Za-z0-9_-]{43}$/.test(jwk.y||""))
    return deny("端末鍵が不正です",400);
  try{
    await crypto.subtle.importKey("jwk",{kty:"EC",crv:"P-256",x:jwk.x,y:jwk.y,ext:true},
      {name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  }catch{return deny("端末鍵の確認に失敗しました",400);}
  const fp=await sha("pairing-used:"+expected),credentialId=crypto.randomUUID();
  const query=[
    "INSERT INTO vault_login_device(id,credential_id,public_jwk,pairing_fingerprint,created_at)",
    "VALUES(1,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET",
    "credential_id=excluded.credential_id,public_jwk=excluded.public_jwk,",
    "pairing_fingerprint=excluded.pairing_fingerprint,created_at=excluded.created_at",
    "WHERE vault_login_device.pairing_fingerprint<>excluded.pairing_fingerprint"
  ].join(" ");
  const result=await env.DB.prepare(query).bind(credentialId,JSON.stringify({
    kty:"EC",crv:"P-256",x:jwk.x,y:jwk.y
  }),fp).run();
  if(Number(result.meta?.changes||0)!==1)
    return deny("登録コードは使用済みです。別端末へ変更するにはCloudflareで新しいハッシュを設定してください",409);
  return response({ok:true,registered:true});
}
export async function challengeDevice(req,env){
  if(!originOK(req))return deny("同じ管理サイトから操作してください");
  const device=await registeredDevice(env);
  if(!device||!env.SESSION_SECRET)return deny("登録端末がありません",404);
  const nonce=crypto.randomUUID(),expiry=Math.floor(Date.now()/1000)+TTL;
  const signed=device.credential_id+"."+nonce+"."+expiry;
  const challenge=signed+"."+await mac("vault-login:"+signed,env.SESSION_SECRET);
  return response({ok:true,challenge,message:"aruno-vault-device-login-v1:"+challenge});
}
export async function verifyDevice(req,env){
  if(!originOK(req))return deny("同じ管理サイトから操作してください");
  const body=await req.json().catch(()=>({}));
  const challenge=String(body.challenge||""),signature=String(body.signature||"");
  const p=challenge.split("."),now=Math.floor(Date.now()/1000);
  if(p.length!==4||!/^[0-9a-f-]{36}$/i.test(p[0])||
    !/^[0-9a-f-]{36}$/i.test(p[1])||!Number.isSafeInteger(Number(p[2]))||
    Number(p[2])<=now||Number(p[2])>now+TTL||
    !/^[A-Za-z0-9_-]{1,256}$/.test(signature))
    return deny("端末認証の期限が切れました",401);
  const device=await registeredDevice(env);
  if(!device||device.credential_id!==p[0]||!env.SESSION_SECRET)
    return deny("端末が登録されていません",401);
  const signed=p.slice(0,3).join(".");
  if(!eq(p[3],await mac("vault-login:"+signed,env.SESSION_SECRET)))
    return deny("認証確認に失敗しました",401);
  try{
    const key=await crypto.subtle.importKey("jwk",JSON.parse(device.public_jwk),
      {name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
    const verified=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,
      unb64(signature),enc.encode("aruno-vault-device-login-v1:"+challenge));
    if(!verified)return deny("この端末の鍵と一致しません",401);
  }catch{return deny("この端末の鍵と一致しません",401);}
  // Atomic one-time nonce acceptance after successful signature verification.
  const inserted=await env.DB.prepare(
    "INSERT OR IGNORE INTO vault_login_nonces(nonce,expires_at) VALUES (?,?)"
  ).bind(p[1],Number(p[2])).run();
  if(Number(inserted.meta?.changes||0)!==1)
    return deny("認証コードの再利用はできません",409);
  const result=response({ok:true,authenticated:true,mode:env.OPERATION_MODE||"trial"});
  result.headers.append("set-cookie",await newDeviceCookie(env,device.credential_id));
  return result;
}
