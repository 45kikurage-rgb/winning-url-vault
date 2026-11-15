// Single-browser ECDSA key. Private material is non-extractable and retained
// only in this site's IndexedDB; no password or raw private key leaves the browser.
const KEYDB="winning-url-vault-device-auth-v1",SECRET_KEY="winning-vault-device-setup";
const enc=new TextEncoder();
const base64url=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
function store(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(KEYDB,1);
    request.onupgradeneeded=()=>request.result.createObjectStore("keys");
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>resolve(request.result);
  });
}
async function keyOperation(mode,value,name="primary"){
  const db=await store();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction("keys",mode);
    const q=mode==="readonly"?tx.objectStore("keys").get(name):
      tx.objectStore("keys").put(value,name);
    tx.oncomplete=()=>resolve(q.result);
    tx.onabort=()=>reject(tx.error||new Error("端末鍵の保存が中断されました"));
    q.onerror=()=>reject(q.error);
    tx.onerror=()=>reject(tx.error);
  });}finally{db.close();}
}
async function stagePairing(candidate){
  const db=await store();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction("keys","readwrite"),records=tx.objectStore("keys");
    const q=records.get("pairing");let staged;
    q.onsuccess=()=>{
      staged=q.result?.privateKey&&q.result.pairingCode?q.result:candidate;
      if(staged===candidate)records.put(candidate,"pairing");
    };
    tx.oncomplete=()=>resolve(staged);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error("端末鍵の保存が中断されました"));
  });}finally{db.close();}
}
async function call(path,body){
  const res=await fetch(path,{method:"POST",credentials:"same-origin",
    headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});
  const json=await res.json().catch(()=>({}));
  if(!res.ok||!json.ok){
    const error=new Error(json.error||"端末認証に失敗しました");
    error.status=res.status;
    throw error;
  }
  return json;
}
export async function hasDeviceKey(){
  try{return Boolean((await keyOperation("readonly"))?.privateKey);}catch{return false;}
}
async function authenticateKeys(keys){
  const challenge=await call("/api/auth/device/challenge");
  const signature=base64url(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
    keys.privateKey,enc.encode(challenge.message)));
  await call("/api/auth/device/verify",{challenge:challenge.challenge,signature});
}
function unregistered(error){return error.status===401||error.status===404;}
async function promotePairing(keys){
  const db=await store();
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction("keys","readwrite"),records=tx.objectStore("keys");
    // Only promote the candidate we actually authenticated. Another tab may
    // already have completed it; never replace a newer candidate or primary.
    const q=records.get("pairing");
    q.onsuccess=()=>{
      if(q.result?.publicJwk?.x!==keys.publicJwk.x||q.result?.publicJwk?.y!==keys.publicJwk.y)return;
      records.put({privateKey:keys.privateKey,publicJwk:keys.publicJwk},"primary");
      records.delete("pairing");
    };
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error("端末鍵の保存が中断されました"));
  });}finally{db.close();}
  try{sessionStorage.removeItem(SECRET_KEY);}catch{}
}
export async function loginWithDeviceKey(){
  const primary=await keyOperation("readonly");
  if(primary?.privateKey){
    try{await authenticateKeys(primary);return true;}
    catch(error){if(!unregistered(error))throw error;}
  }
  const pending=await keyOperation("readonly",undefined,"pairing");
  if(!pending?.privateKey){
    if(primary?.privateKey)throw new Error("この端末の鍵と一致しません");
    return false;
  }
  await authenticateKeys(pending);
  await promotePairing(pending);
  return true;
}
export async function prepareDevicePairing(){
  if(!crypto?.subtle||!indexedDB)throw new Error("このブラウザーは安全な端末鍵を作成できません");
  let pending=await keyOperation("readonly",undefined,"pairing");
  if(!pending?.privateKey||!pending.pairingCode){
    const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
    const publicJwk=await crypto.subtle.exportKey("jwk",pair.publicKey);
    pending={privateKey:pair.privateKey,publicJwk,pairingCode:base64url(crypto.getRandomValues(new Uint8Array(32)))};
    pending=await stagePairing(pending);
  }
  // The pending code and non-extractable key survive a tab close together.
  // The registered primary remains intact until the candidate logs in.
  const digest=await crypto.subtle.digest("SHA-256",enc.encode(pending.pairingCode));
  return {hash:hex(digest)};
}
export async function finishDevicePairing(){
  let keys=await keyOperation("readonly",undefined,"pairing");
  // Finish a setup started by the previous version without regenerating it.
  if(!keys){
    const pairingCode=sessionStorage.getItem(SECRET_KEY);
    const legacy=pairingCode?await keyOperation("readonly"):null;
    if(legacy?.privateKey&&legacy.publicJwk)keys=await stagePairing({...legacy,pairingCode});
  }
  if(!keys?.pairingCode||!keys?.privateKey||!keys?.publicJwk)
    throw new Error("端末登録の準備からやり直してください");
  try{await authenticateKeys(keys);}
  catch(error){
    if(!unregistered(error))throw error;
    // A lost enrollment response is recovered by authentication above on the
    // next attempt, without consuming the one-time pairing code twice.
    await call("/api/auth/device/enroll",{pairingCode:keys.pairingCode,publicJwk:keys.publicJwk});
    await authenticateKeys(keys);
  }
  await promotePairing(keys);
  return true;
}
