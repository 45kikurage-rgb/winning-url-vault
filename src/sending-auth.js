const encoder = new TextEncoder();
export class IntakeError extends Error {
  constructor(code, status, message) { super(message); this.code=code; this.status=status; }
}
export async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function sendingIdentity(request, env) {
  const match=/^Bearer (wuv_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization')||'');
  if(!match) throw new IntakeError('TOKEN_INVALID',401,'送信専用トークンを確認してください');
  const token=await env.DB.prepare('SELECT device_id FROM sending_tokens WHERE token_hash=? AND revoked_at IS NULL').bind(await digest(match[1])).first();
  if(!token) throw new IntakeError('TOKEN_INVALID',401,'送信専用トークンが無効です');
  return {ownerKey:`device:${token.device_id}`,deviceId:token.device_id};
}
export async function limitSending(env, deviceId) {
  const window=Math.floor(Date.now()/60000);
  const row=await env.DB.prepare(`INSERT INTO sending_rate_limits(device_id,window,attempts) VALUES (?,?,1)
    ON CONFLICT(device_id) DO UPDATE SET window=excluded.window,
    attempts=CASE WHEN sending_rate_limits.window=excluded.window THEN sending_rate_limits.attempts+1 ELSE 1 END
    RETURNING attempts`).bind(deviceId,window).first();
  if(row.attempts>120) throw new IntakeError('RATE_LIMITED',429,'送信が集中しています。少し待って再送してください');
}
export async function listSendingTokens(env) {
  return (await env.DB.prepare('SELECT id,device_id,created_at,revoked_at FROM sending_tokens ORDER BY device_id,created_at DESC').all()).results||[];
}
export async function issueSendingToken(env, body) {
  const deviceId=body?.deviceId;
  if(typeof deviceId!=='string'||!/^\d{2,4}$/.test(deviceId)) throw new IntakeError('INVALID_REQUEST',400,'端末番号を2〜4桁で入力してください');
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const token='wuv_'+btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const tokenId=crypto.randomUUID(),createdAt=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE sending_tokens SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').bind(createdAt,deviceId),
    env.DB.prepare('INSERT INTO sending_tokens(id,device_id,token_hash,created_at) VALUES (?,?,?,?)').bind(tokenId,deviceId,await digest(token),createdAt)
  ]);
  return {id:tokenId,deviceId,token,createdAt};
}
export async function revokeSendingToken(env, tokenId) {
  await env.DB.prepare('UPDATE sending_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(new Date().toISOString(),tokenId).run();
}
