import { env } from '../config/env.js';
import { formatUsd } from '../domain/money.js';
import type { Mandate } from '../domain/mandate.js';

/**
 * Server-rendered pages for the approval flow.
 *
 * Design note. The signature element is the guardrail band: a single strip that
 * states, in one glance, everything the released credential can and cannot do —
 * merchant lock, spend ceiling, remaining uses, expiry. It appears on the
 * approval screen and again on the receipt, unchanged, so the approver sees the
 * same object before and after they consent. The rest of the page is kept quiet
 * so the band carries the weight.
 *
 * Palette is a cool institutional grey-blue with burnt amber reserved
 * exclusively for limits and caps, teal for released authority, carmine for
 * withdrawn authority. Colour is never decorative here: if something is amber
 * it is a constraint.
 */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const BASE_CSS = `
/* Tokens live in /tokens.css. Only page-specific rules belong here. */
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  font-family:var(--font-body);
  background:var(--paper); color:var(--ink);
  min-height:100vh; display:flex; align-items:center; justify-content:center;
  padding:24px; line-height:1.5;
}
.sheet{
  background:var(--card); width:100%; max-width:520px;
  border:1px solid var(--rule); border-radius:var(--radius); box-shadow:var(--shadow);
  overflow:hidden;
}
.masthead{
  padding:18px 24px; border-bottom:1px solid var(--rule);
  display:flex; align-items:baseline; justify-content:space-between; gap:12px;
}
.org{font-family:var(--font-display); font-weight:700; font-size:13px; letter-spacing:.14em; text-transform:uppercase}
.doctype{font-family:var(--font-mono); font-size:11px; color:var(--ink-3); letter-spacing:.06em}
.body{padding:28px 24px}
h1{font-family:var(--font-display); font-weight:800; font-size:27px; letter-spacing:-.02em; line-height:1.15; margin-bottom:10px}
.lede{color:var(--ink-2); font-size:15px; margin-bottom:22px}
.lede strong{color:var(--ink); font-weight:600}

/* Vertical presentation of the shared guardrail band, for the approval sheet. */
.band.sheet-band{
  flex-direction:column; align-items:stretch; gap:0;
  border:1px solid var(--rule); border-left:3px solid var(--limit);
  background:linear-gradient(180deg,#FCFDFE,#F5F8FA);
  border-radius:var(--radius); padding:16px 18px; margin-bottom:22px;
}
.band-title{font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--limit); margin-bottom:12px}
.band-row{display:flex; justify-content:space-between; align-items:baseline; gap:16px; padding:6px 0; border-bottom:1px dotted var(--rule); width:100%}
.band-row:last-child{border-bottom:0}
.band-k{font-size:12px; color:var(--ink-3); letter-spacing:.02em}
.band-v{font-family:var(--font-mono); font-size:13px; font-variant-numeric:tabular-nums; text-align:right; font-weight:500}
.band-meter{padding:10px 0 2px}

.reasons{list-style:none; margin-bottom:22px}
.reasons li{font-size:14px; color:var(--ink-2); padding:7px 0 7px 16px; border-left:2px solid var(--rule); margin-bottom:2px}

.actions{display:flex; gap:10px; flex-wrap:wrap}
button{
  font-family:var(--font-body); font-size:15px; font-weight:600;
  padding:13px 22px; border-radius:var(--radius); border:1px solid transparent;
  cursor:pointer; transition:transform .08s ease, box-shadow .15s ease, background .15s ease;
}
button:focus-visible{outline:2px solid var(--ink); outline-offset:2px}
button:active{transform:translateY(1px)}
.primary{background:var(--ok); color:#fff; flex:1; min-width:200px}
.primary:hover{background:var(--ok-hover)}
.primary:disabled{background:var(--ink-3); cursor:progress}
.secondary{background:transparent; color:var(--stop); border-color:var(--rule)}
.secondary:hover{background:var(--stop-soft); border-color:var(--stop)}
.secondary.armed{background:var(--stop); color:#fff; border-color:var(--stop)}

/* Decline reason. Hidden until Decline is pressed, so the default path stays
   one tap and the reason never reads as a required field. */
.why{
  margin-bottom:16px; border:1px solid var(--stop); border-left-width:3px;
  border-radius:var(--radius); background:var(--stop-soft); padding:14px 16px;
  animation:unfold .18s ease-out;
}
.why[hidden]{display:none}
@keyframes unfold{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.why label{display:block; font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--stop); margin-bottom:8px}
.why input{
  width:100%; font-family:var(--font-body); font-size:14px; padding:10px 12px;
  border:1px solid var(--rule); border-radius:var(--radius); background:var(--card); color:var(--ink);
}
.why input:focus{outline:2px solid var(--stop); outline-offset:-1px}
.why p{font-size:12px; color:var(--ink-2); margin-top:8px}

/* Fallback-code entry. Mirrors the decline reason box but in the accent, since
   it is part of approving rather than refusing. */
.codebox{ margin-bottom:16px; border:1px solid var(--rule); border-radius:var(--radius); background:var(--card); padding:14px 16px; animation:unfold .18s ease-out; }
.codebox[hidden]{display:none}
.codebox label{display:block; font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-2); margin-bottom:8px}
.codebox input{ width:100%; font-family:var(--font-mono, ui-monospace, monospace); font-size:22px; letter-spacing:.34em; text-align:center; padding:12px; border:1px solid var(--rule); border-radius:var(--radius); background:var(--bg, #fff); color:var(--ink); }
.codebox input:focus{outline:2px solid var(--accent, #5B54E8); outline-offset:-1px}
.codebox p{font-size:12px; color:var(--ink-2); margin-top:8px}
.gatemsg{ font-size:13px; color:var(--stop); margin-top:12px; }
.gatemsg[hidden]{display:none}
.alt{ margin-top:14px; }
.linklike{ background:none; border:0; padding:0; font-family:inherit; font-size:13px; color:var(--ink-2); text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.linklike:hover{ color:var(--ink); }
.linklike[hidden]{display:none}


/* Prava hosted setup. The iframe is where card entry and the Visa passkey
   actually happen — it is Prava's UI, not ours, and it is framed as the main
   event of the page rather than an implementation detail. */
.prava-panel{
  border:1px solid var(--rule); border-radius:var(--radius); overflow:hidden;
  margin-bottom:18px; background:var(--card);
}
.prava-panel-head{
  display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding:10px 14px; border-bottom:1px solid var(--rule); background:#F7FAFC;
}
.prava-panel-head .k{font-family:var(--font-display); font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-2)}
.prava-panel iframe{display:block; width:100%; height:520px; border:0; background:#fff}
.steps{list-style:none; margin-bottom:14px}
.steps li{display:flex; gap:10px; align-items:baseline; font-size:13px; color:var(--ink-2); padding:4px 0}
.steps .n{
  font-family:var(--font-mono); font-size:11px; font-weight:600; flex:none;
  width:20px; height:20px; border-radius:50%; border:1px solid var(--rule);
  display:inline-flex; align-items:center; justify-content:center; color:var(--ink-3);
}
.steps li.done .n{background:var(--ok); border-color:var(--ok); color:#fff}
.steps li.done{color:var(--ink)}
.simbadge{
  display:inline-flex; align-items:center; gap:7px; margin-bottom:14px;
  font-family:var(--font-mono); font-size:11px; letter-spacing:.06em;
  padding:5px 10px; border:1px dashed var(--limit); border-radius:2px; color:var(--limit);
}

.stamp{
  display:inline-flex; align-items:center; gap:7px;
  font-family:var(--font-display); font-size:11px; font-weight:700;
  letter-spacing:.12em; text-transform:uppercase;
  padding:6px 12px; border-radius:2px; margin-bottom:18px;
}
.stamp.ok{background:var(--ok-soft); color:var(--ok)}
.stamp.stop{background:var(--stop-soft); color:var(--stop)}
.stamp.wait{background:var(--limit-soft); color:var(--limit)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.dot.live{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

.foot{
  padding:14px 24px; border-top:1px solid var(--rule); background:#F7FAFC;
  font-family:var(--font-mono); font-size:11px; color:var(--ink-3);
  display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;
}
a{color:var(--ok)}
@media (max-width:520px){ .body{padding:22px 18px} h1{font-size:23px} }
@media (prefers-reduced-motion:reduce){ *{animation:none !important; transition:none !important} }
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

function shell(title: string, inner: string, extraScript = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>${FONTS}<link rel="stylesheet" href="/tokens.css"><style>${BASE_CSS}</style></head>
<body><main class="sheet">${inner}</main>${extraScript}</body></html>`;
}

function masthead(doctype: string): string {
  return `<header class="masthead" style="display:flex;align-items:center;gap:10px"><img src="/logo.png" alt="CardGuard" style="width:26px;height:26px;border-radius:50%;object-fit:cover"><span class="org">${escapeHtml(env.ORG_NAME)}</span><span class="doctype" style="margin-left:auto">${escapeHtml(doctype)}</span></header>`;
}


function guardrailBand(mandate: Mandate): string {
  const remaining = Math.max(0, mandate.scope.maxUses - mandate.scope.usesConsumed);
  const pips = Array.from({ length: Math.min(mandate.scope.maxUses, 8) }, (_, i) =>
    `<span class="pip${i < mandate.scope.usesConsumed ? ' spent' : ''}"></span>`,
  ).join('');
  const minutes = Math.max(0, Math.round((new Date(mandate.scope.expiresAt).getTime() - Date.now()) / 60_000));

  // How much of the ceiling this single charge would consume. Drawn against the
  // full cap rather than rescaled, so the headroom is visible.
  const pct = mandate.scope.perTransactionCapCents
    ? Math.min(100, Math.round((mandate.amountCents / mandate.scope.perTransactionCapCents) * 100))
    : 0;

  return `<section class="band sheet-band">
  <div class="band-title">What this card can do</div>
  <div class="band-row"><span class="band-k">Merchant</span><span class="band-v">${escapeHtml(mandate.scope.merchant)} only</span></div>
  <div class="band-row"><span class="band-k">Ceiling</span><span class="band-v">${formatUsd(mandate.scope.perTransactionCapCents)}</span></div>
  <div class="band-row band-meter" style="display:block">
    <div class="meter-row"><span class="meter-k">This charge against the cap</span><span class="meter-v">${formatUsd(mandate.amountCents)} of ${formatUsd(mandate.scope.perTransactionCapCents)}</span></div>
    <div class="meter"><i style="width:${pct}%"></i></div>
  </div>
  <div class="band-row"><span class="band-k">Uses left</span><span class="band-v"><span class="pips">${pips}</span> &nbsp;${remaining} of ${mandate.scope.maxUses}</span></div>
  <div class="band-row"><span class="band-k">Expires</span><span class="band-v">${minutes} min</span></div>
  ${mandate.scope.recurrence !== 'one_time' ? `<div class="band-row"><span class="band-k">Billing</span><span class="band-v">${escapeHtml(mandate.scope.recurrence)}</span></div>` : ''}
</section>`;
}

function footer(mandate: Mandate): string {
  return `<footer class="foot"><span>${escapeHtml(mandate.id)}</span><span>${mandate.prava.sessionId ? escapeHtml(mandate.prava.sessionId) : 'no session'}</span></footer>`;
}

// ---------------------------------------------------------------------------

/**
 * The approval screen.
 *
 * This is a GET, so it must not authorize anything by being loaded. Messaging
 * clients, link previewers, and security scanners all fetch URLs that arrive in
 * a text message; if GET released the card, Apple's link preview would approve
 * every purchase before the human saw it. The consent lives behind the POST
 * that this button issues.
 */
export function approvalPage(mandate: Mandate, token: string): string {
  const who = mandate.requesterName ?? mandate.requesterPhone;
  const reasons = mandate.policyReasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('');

  // A live Prava setup session exists when the client returned an iframe URL
  // and the session is not the sim_ placeholder. That URL is Prava's hosted
  // surface: card entry, then the Visa passkey, then the mandate is created
  // upstream. This page's job is to put that surface front and centre and to
  // refuse to offer a Confirm button until Prava reports the ceremony done.
  const pravaUrl = mandate.prava.authorizationUrl;
  const live = Boolean(pravaUrl && mandate.prava.sessionId && !mandate.prava.sessionId.startsWith('sim_'));

  const pravaBlock = live
    ? `<ol class="steps" id="steps">
  <li id="step1"><span class="n">1</span><span>Enter the payment card and verify with your <strong>Visa passkey</strong> in Prava below. This creates the mandate — a standing authorization scoped to ${escapeHtml(mandate.scope.merchant)}, capped at ${formatUsd(mandate.scope.perTransactionCapCents)}, ${mandate.scope.maxUses} use${mandate.scope.maxUses === 1 ? '' : 's'}.</span></li>
  <li id="step2"><span class="n">2</span><span>Confirm, and the agent charges the mandate for single-use credentials and checks out.</span></li>
</ol>
<div class="prava-panel">
  <div class="prava-panel-head">
    <span class="k">Prava · mandate setup ${escapeHtml(mandate.prava.sessionId ?? '')}</span>
    <a href="${escapeHtml(pravaUrl!)}" target="_blank" rel="noopener">Open in a new tab ↗</a>
  </div>
  <iframe id="prava" src="${escapeHtml(pravaUrl!)}" title="Prava mandate setup"
    allow="publickey-credentials-get *; publickey-credentials-create *; payment *; clipboard-write *"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>
</div>`
    : `<span class="simbadge">◌ simulated session — PRAVA_API_KEY not configured; no real mandate will be created</span>`;

  const approveButton = live
    ? `<button class="primary" id="approve" disabled>Waiting for your passkey in Prava…</button>`
    : `<button class="primary" id="approve">Approve with fingerprint</button>`;

  const fallbackBits = live
    ? ''
    : `<div class="codebox" id="codebox" hidden>
    <label for="code">Enter the code from your message</label>
    <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="6-digit code">
    <p>Your approval message ends with a fallback code. Type it, then Approve.</p>
  </div>`;

  const altRow = live
    ? ''
    : `<p class="alt"><button type="button" class="linklike" id="usecode">No fingerprint on this device? Use a code</button></p>`;

  const liveScript = `<script>
(function(){
  var token=${JSON.stringify(token)};
  var approve=document.getElementById('approve');
  var decline=document.getElementById('decline');
  var why=document.getElementById('why');
  var reason=document.getElementById('reason');
  var gatemsg=document.getElementById('gatemsg');
  var step1=document.getElementById('step1');
  var step2=document.getElementById('step2');
  var armed=false, ready=false, stopped=false;

  function setMsg(t){ if(!gatemsg) return; if(t){ gatemsg.textContent=t; gatemsg.hidden=false; } else { gatemsg.textContent=''; gatemsg.hidden=true; } }

  async function post(action){
    var body={action:action, reason:(reason&&reason.value||'').trim()};
    var res=await fetch('/authorize/'+encodeURIComponent(token),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var html=await res.text(); document.open(); document.write(html); document.close();
  }

  // Poll Prava through our token-guarded status endpoint. The Confirm button
  // stays dead until Prava itself reports the passkey ceremony complete and
  // the mandate created. Nothing on this page can shortcut that.
  async function poll(){
    if(stopped) return;
    try{
      var res=await fetch('/authorize/'+encodeURIComponent(token)+'/status');
      if(res.ok){
        var s=await res.json();
        if(s.prava==='authorized'){
          ready=true;
          if(step1) step1.classList.add('done');
          approve.disabled=false;
          approve.textContent='Confirm — release the card';
          setMsg('');
          return; // stop polling
        }
        if(s.state && s.state!=='PENDING_APPROVAL'){ stopped=true; location.reload(); return; }
      }
    }catch(e){}
    setTimeout(poll, 2500);
  }
  poll();

  approve.addEventListener('click', async function(){
    if(!ready){ setMsg('Finish the card + passkey step in the Prava panel above first.'); return; }
    approve.disabled=true; decline.disabled=true; approve.textContent='Releasing…';
    if(step2) step2.classList.add('done');
    try{ await post('approve'); }
    catch(e){ approve.textContent='Could not reach the server. Try again.'; approve.disabled=false; decline.disabled=false; }
  });

  decline.addEventListener('click',function(){
    if(!armed){ armed=true; why.hidden=false; decline.classList.add('armed'); decline.textContent='Confirm decline'; if(reason) reason.focus(); return; }
    approve.disabled=true; decline.disabled=true; decline.textContent='Declining…';
    post('decline').catch(function(){ decline.textContent='Could not reach the server. Try again.'; approve.disabled=false; decline.disabled=false; });
  });
  if(reason){ reason.addEventListener('keydown',function(ev){ if(ev.key==='Enter'){ ev.preventDefault(); decline.click(); } }); }
})();
</script>`;

  const simScript = `<script>
(function(){
  var token=${JSON.stringify(token)};
  var approve=document.getElementById('approve');
  var decline=document.getElementById('decline');
  var why=document.getElementById('why');
  var reason=document.getElementById('reason');
  var codebox=document.getElementById('codebox');
  var code=document.getElementById('code');
  var usecode=document.getElementById('usecode');
  var gatemsg=document.getElementById('gatemsg');
  var armed=false, codeMode=false;
  var CK='cardguard.pk.'+location.hostname;

  function setMsg(t){ if(!gatemsg) return; if(t){ gatemsg.textContent=t; gatemsg.hidden=false; } else { gatemsg.textContent=''; gatemsg.hidden=true; } }
  function rand(n){ var a=new Uint8Array(n); window.crypto.getRandomValues(a); return a; }
  function bufToB64u(buf){ var b=new Uint8Array(buf),s=''; for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }
  function b64uToBuf(str){ str=str.replace(/-/g,'+').replace(/_/g,'/'); while(str.length%4)str+='='; var bin=atob(str),b=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++)b[i]=bin.charCodeAt(i); return b.buffer; }

  async function fingerprint(){
    if(!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext)) return {ok:false, why:'unsupported'};
    var available=false;
    try{ available=await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }catch(e){}
    if(!available) return {ok:false, why:'no-sensor'};
    var rpId=location.hostname, stored=null;
    try{ stored=localStorage.getItem(CK); }catch(e){}
    try{
      if(stored){
        await navigator.credentials.get({publicKey:{
          challenge:rand(32), rpId:rpId, timeout:60000, userVerification:'required',
          allowCredentials:[{id:b64uToBuf(stored), type:'public-key'}]
        }});
      } else {
        var cred=await navigator.credentials.create({publicKey:{
          challenge:rand(32),
          rp:{id:rpId, name:'CardGuard'},
          user:{id:rand(16), name:'approver', displayName:'CardGuard approver'},
          pubKeyCredParams:[{alg:-7,type:'public-key'},{alg:-257,type:'public-key'}],
          authenticatorSelection:{authenticatorAttachment:'platform', userVerification:'required', residentKey:'preferred'},
          timeout:60000
        }});
        try{ localStorage.setItem(CK, bufToB64u(cred.rawId)); }catch(e){}
      }
      return {ok:true};
    }catch(err){ return {ok:false, why:(err&&err.name)||'failed'}; }
  }

  async function post(action, extra){
    var body=Object.assign({action:action, reason:(reason&&reason.value||'').trim()}, extra||{});
    var res=await fetch('/authorize/'+encodeURIComponent(token),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var html=await res.text(); document.open(); document.write(html); document.close();
  }

  function enterCodeMode(msg){
    codeMode=true; if(codebox)codebox.hidden=false; if(usecode)usecode.hidden=true;
    approve.textContent='Approve with code'; if(msg)setMsg(msg); else setMsg(''); if(code)code.focus();
  }

  async function doApprove(){
    setMsg('');
    if(codeMode){
      var v=(code&&code.value||'').replace(/\\D/g,'');
      if(v.length<6){ setMsg('Enter the 6-digit code from your message.'); if(code)code.focus(); return; }
      approve.disabled=true; decline.disabled=true; approve.textContent='Verifying code…';
      try{ await post('approve',{code:v}); }
      catch(e){ approve.textContent='Could not reach the server. Try again.'; approve.disabled=false; decline.disabled=false; }
      return;
    }
    approve.disabled=true; decline.disabled=true; approve.textContent='Waiting for fingerprint…';
    var r=await fingerprint();
    if(!r.ok){
      approve.disabled=false; decline.disabled=false; approve.textContent='Approve with fingerprint';
      if(r.why==='unsupported' || r.why==='no-sensor'){ enterCodeMode('This device has no fingerprint or Face ID, so enter the code from your message instead.'); }
      else if(r.why==='NotAllowedError' || r.why==='AbortError'){ setMsg('Fingerprint cancelled — approval not sent. Try again, or use the code.'); }
      else { setMsg('Could not read your fingerprint. Try again, or use the code below.'); if(usecode)usecode.hidden=false; }
      return;
    }
    approve.textContent='Approving…';
    try{ await post('approve'); }
    catch(e){ approve.textContent='Could not reach the server. Try again.'; approve.disabled=false; decline.disabled=false; }
  }

  approve.addEventListener('click', doApprove);
  if(usecode) usecode.addEventListener('click', function(){ enterCodeMode(''); });
  if(code) code.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); doApprove(); } });

  decline.addEventListener('click',function(){
    if(!armed){ armed=true; why.hidden=false; decline.classList.add('armed'); decline.textContent='Confirm decline'; if(reason) reason.focus(); return; }
    approve.disabled=true; decline.disabled=true; decline.textContent='Declining…';
    post('decline').catch(function(){ decline.textContent='Could not reach the server. Try again.'; approve.disabled=false; decline.disabled=false; });
  });
  if(reason){ reason.addEventListener('keydown',function(ev){ if(ev.key==='Enter'){ ev.preventDefault(); decline.click(); } }); }
})();
</script>`;

  return shell(
    `Approve ${formatUsd(mandate.amountCents)} at ${mandate.scope.merchant}`,
    `${masthead('AUTHORIZATION REQUEST')}
<div class="body">
  <span class="stamp wait"><span class="dot live"></span>${live ? 'Awaiting your Visa passkey via Prava' : 'Awaiting your passkey'}</span>
  <h1>Release ${formatUsd(mandate.amountCents)} to ${escapeHtml(mandate.scope.merchant)}?</h1>
  <p class="lede"><strong>${escapeHtml(who)}</strong> asked for ${escapeHtml(mandate.purpose)}${mandate.seats ? ` for ${mandate.seats} seats` : ''}.</p>
  ${guardrailBand(mandate)}
  <ul class="reasons">${reasons}</ul>
  ${pravaBlock}
  <div class="why" id="why" hidden>
    <label for="reason">Why are you declining?</label>
    <input id="reason" type="text" maxlength="200" autocomplete="off"
           placeholder="e.g. we already have seats on the team plan">
    <p>Optional, but the requester sees this verbatim. Press Decline again to confirm.</p>
  </div>
  ${fallbackBits}
  <div class="actions">
    ${approveButton}
    <button class="secondary" id="decline">Decline</button>
  </div>
  <p class="gatemsg" id="gatemsg" hidden></p>
  ${altRow}
</div>
${footer(mandate)}`,
    live ? liveScript : simScript,
  );
}

/** Shown after a successful approval. */
export function approvedPage(mandate: Mandate): string {
  return shell(
    'Approved',
    `${masthead('AUTHORIZATION GRANTED')}
<div class="body">
  <span class="stamp ok"><span class="dot"></span>Approved</span>
  <h1>${formatUsd(mandate.amountCents)} released to ${escapeHtml(mandate.scope.merchant)}</h1>
  <p class="lede">The card is live and the agent is checking out now. ${escapeHtml(mandate.requesterName ?? mandate.requesterPhone)} gets the receipt by message either way.</p>
  ${guardrailBand(mandate)}
  <p class="lede">Changed your mind? <a href="/dashboard">Revoke it from the dashboard</a> — that kills the card even mid-checkout.</p>
</div>
${footer(mandate)}`,
  );
}

export function declinedPage(mandate: Mandate, note?: string): string {
  return shell(
    'Declined',
    `${masthead('AUTHORIZATION DECLINED')}
<div class="body">
  <span class="stamp stop"><span class="dot"></span>Declined</span>
  <h1>Nothing was released</h1>
  <p class="lede">No card was issued for ${escapeHtml(mandate.scope.merchant)} and no money moved. ${escapeHtml(mandate.requesterName ?? mandate.requesterPhone)} has been told${note?.trim() ? ', including your reason' : ''}.</p>
  ${note?.trim() ? `<ul class="reasons"><li>${escapeHtml(note.trim())}</li></ul>` : ''}
</div>
${footer(mandate)}`,
  );
}

/** Bad, expired, or replayed token. */
export function invalidTokenPage(reason: string): string {
  const copy: Record<string, { title: string; body: string }> = {
    expired: {
      title: 'This link has expired',
      body: `Approval links last ${env.MANDATE_TTL_MINUTES} minutes so an unattended link cannot be used later. Ask for the purchase again to get a fresh one.`,
    },
    bad_signature: {
      title: 'This link is not valid',
      body: 'The signature does not match. Open the link directly from the message you were sent rather than a copy.',
    },
    malformed: {
      title: 'This link is not valid',
      body: 'The link is incomplete. Open it directly from the message you were sent.',
    },
    used: {
      title: 'Already decided',
      body: 'This mandate has already been approved, declined, or expired. Check the dashboard for its current state.',
    },
    bad_code: {
      title: 'That code did not match',
      body: 'The approval code was incorrect. Open the link again from your message and re-enter the code exactly as shown.',
    },
    prava_incomplete: {
      title: 'Finish the Prava step first',
      body: 'Nothing was released. The card and Visa passkey step in Prava has not completed yet, and no spend authority exists until Prava confirms the mandate. Open the approval link again and finish the Prava panel.',
    },
  };
  const c = copy[reason] ?? copy.malformed!;

  return shell(
    c.title,
    `${masthead('AUTHORIZATION')}
<div class="body">
  <span class="stamp stop"><span class="dot"></span>Not valid</span>
  <h1>${escapeHtml(c.title)}</h1>
  <p class="lede">${escapeHtml(c.body)}</p>
  <div class="actions"><button class="primary" onclick="location.href='/dashboard'">Open the dashboard</button></div>
</div>`,
  );
}
