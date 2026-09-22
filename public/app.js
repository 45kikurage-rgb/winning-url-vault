const $=id=>document.getElementById(id);
async function api(path,options){const r=await fetch(path,options);const d=await r.json();if(!r.ok||d.ok===false)throw new Error(d.error||"API error");return d}
function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function load(){
 try{
  const [cards,unknown]=await Promise.all([api("/api/cards"),api("/api/unresolved")]);
  const total=cards.cards.reduce((n,c)=>n+Number(c.count||0),0);
  $("total").textContent=total.toLocaleString()+"件";$("unknown").textContent=unknown.items.length.toLocaleString()+"件";$("unknownBottom").textContent=unknown.items.length.toLocaleString()+"件";
  $("cards").innerHTML=cards.cards.length?cards.cards.map(c=>`<article class="coupon"><h3>${esc(c.display_name)}</h3><div class="meta">${esc(c.redeem_place)} / 期限 ${esc(c.expires_on||"未設定")}</div><div class="count">${Number(c.count||0).toLocaleString()}件</div></article>`).join(""):'<div class="empty">まだカードはありません</div>';
  $("unknownList").innerHTML=unknown.items.slice(0,5).map(x=>`<div class="meta">${esc(x.reason)} / ${esc(x.pattern_key||"未知パターン")}</div>`).join("");
 }catch(e){$("cards").innerHTML='<div class="empty">DB設定後に利用できます</div>'}
}
$("retry").onclick=()=>alert("再解析は解析API接続後に有効化します。確定済みカードは対象にしません。");
load();