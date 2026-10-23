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
async function keyOperation(mode,value){
  const db=await store();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction("keys",mode);
    const q=mode==="readonly"?tx.objectStore("keys").get("primary"):
      tx.objectStore("keys").put(value,"primary");
    q.onsuccess=()=>resolve(q.result);
    q.onerror=()=>reject(q.error);
    tx.onerror=()=>reject(tx.error);
  });}finally{db.close();}
}
async function call(path,body){
  const res=await fetch(path,{method:"POST",credentials:"same-origin",
    headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});
  const json=await res.json().catch(()=>({}));
  if(!res.ok||!json.ok)throw new Error(json.error||"端末認証に失敗しました");
  return json;
}
export async function hasDeviceKey(){
  try{return Boolean((await keyOperation("readonly"))?.privateKey);}catch{return false;}
}
export async function loginWithDeviceKey(){
  const keys=await keyOperation("readonly");
  if(!keys?.privateKey)return false;
  const challenge=await call("/api/auth/device/challenge");
  const signature=base64url(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
    keys.privateKey,enc.encode(challenge.message)));
  await call("/api/auth/device/verify",{challenge:challenge.challenge,signature});
  return true;
}
export async function prepareDevicePairing(){
  if(!crypto?.subtle||!indexedDB)throw new Error("このブラウザーは安全な端末鍵を作成できません");
  const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
  const publicJwk=await crypto.subtle.exportKey("jwk",pair.publicKey);
  const code=base64url(crypto.getRandomValues(new Uint8Array(32)));
  await keyOperation("readwrite",{privateKey:pair.privateKey,publicJwk});
  sessionStorage.setItem(SECRET_KEY,code);
  const digest=await crypto.subtle.digest("SHA-256",enc.encode(code));
  return {hash:hex(digest)};
}
export async function finishDevicePairing(){
  const pairingCode=sessionStorage.getItem(SECRET_KEY);
  const keys=await keyOperation("readonly");
  if(!pairingCode||!keys?.privateKey||!keys?.publicJwk)
    throw new Error("端末登録の準備からやり直してください");
  await call("/api/auth/device/enroll",{pairingCode,publicJwk:keys.publicJwk});
  sessionStorage.removeItem(SECRET_KEY);
  if(!await loginWithDeviceKey())throw new Error("端末鍵の保存に失敗しました");
  return true;
}
