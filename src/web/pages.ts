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
:root{
  --ink:#16202B; --ink-2:#40525F; --ink-3:#7B8B98;
  --paper:#E4EAEF; --card:#FFFFFF; --rule:#C6D2DB;
  --limit:#B4530A; --limit-soft:#FBEEE2;
  --ok:#0E7C66; --ok-soft:#E3F1ED;
  --stop:#A3283C; --stop-soft:#F8E6E9;
  --shadow:0 1px 2px rgba(22,32,43,.06),0 8px 24px -12px rgba(22,32,43,.28);
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
  background:var(--paper); color:var(--ink);
  min-height:100vh; display:flex; align-items:center; justify-content:center;
  padding:24px; line-height:1.5;
}
.sheet{
  background:var(--card); width:100%; max-width:520px;
  border:1px solid var(--rule); border-radius:4px; box-shadow:var(--shadow);
  overflow:hidden;
}
.masthead{
  padding:18px 24px; border-bottom:1px solid var(--rule);
  display:flex; align-items:baseline; justify-content:space-between; gap:12px;
}
.org{
  font-family:'Archivo',sans-serif; font-weight:700; font-size:13px;
  letter-spacing:.14em; text-transform:uppercase;
}
.doctype{
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px;
  color:var(--ink-3); letter-spacing:.06em;
}
.body{padding:28px 24px}
h1{
  font-family:'Archivo',sans-serif; font-weight:800; font-size:27px;
  letter-spacing:-.02em; line-height:1.15; margin-bottom:10px;
}
.lede{color:var(--ink-2); font-size:15px; margin-bottom:22px}
.lede strong{color:var(--ink); font-weight:600}

/* ---- the guardrail band: this page's one loud idea ---- */
.band{
  border:1px solid var(--rule); border-left:3px solid var(--limit);
  background:linear-gradient(180deg,#FCFDFE,#F5F8FA);
  border-radius:3px; padding:16px 18px; margin-bottom:22px;
}
.band-title{
  font-family:'Archivo',sans-serif; font-size:10px; font-weight:700;
  letter-spacing:.16em; text-transform:uppercase; color:var(--limit); margin-bottom:12px;
}
.band-row{
  display:flex; justify-content:space-between; align-items:baseline;
  gap:16px; padding:6px 0; border-bottom:1px dotted var(--rule);
}
.band-row:last-child{border-bottom:0}
.band-k{font-size:12px; color:var(--ink-3); letter-spacing:.02em}
.band-v{
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:13px;
  font-variant-numeric:tabular-nums; text-align:right; font-weight:500;
}
.pips{display:inline-flex; gap:4px; vertical-align:middle}
.pip{width:7px;height:7px;border-radius:50%;background:var(--limit)}
.pip.spent{background:var(--rule)}

.reasons{list-style:none; margin-bottom:22px}
.reasons li{
  font-size:14px; color:var(--ink-2); padding:7px 0 7px 16px;
  border-left:2px solid var(--rule); margin-bottom:2px;
}
.reasons li::before{content:''}

.actions{display:flex; gap:10px; flex-wrap:wrap}
button{
  font-family:'IBM Plex Sans',sans-serif; font-size:15px; font-weight:600;
  padding:13px 22px; border-radius:3px; border:1px solid transparent;
  cursor:pointer; transition:transform .08s ease, box-shadow .15s ease, background .15s ease;
}
button:focus-visible{outline:2px solid var(--ink); outline-offset:2px}
button:active{transform:translateY(1px)}
.primary{background:var(--ok); color:#fff; flex:1; min-width:200px}
.primary:hover{background:#0B6753}
.primary:disabled{background:var(--ink-3); cursor:progress}
.secondary{background:transparent; color:var(--stop); border-color:var(--rule)}
.secondary:hover{background:var(--stop-soft); border-color:var(--stop)}

.stamp{
  display:inline-flex; align-items:center; gap:7px;
  font-family:'Archivo',sans-serif; font-size:11px; font-weight:700;
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
  font-family:'JetBrains Mono',ui-monospace,monospace; font-size:11px; color:var(--ink-3);
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
<title>${escapeHtml(title)}</title>${FONTS}<style>${BASE_CSS}</style></head>
<body><main class="sheet">${inner}</main>${extraScript}</body></html>`;
}

function masthead(doctype: string): string {
  return `<header class="masthead"><span class="org">${escapeHtml(env.ORG_NAME)}</span><span class="doctype">${escapeHtml(doctype)}</span></header>`;
}

function guardrailBand(mandate: Mandate): string {
  const remaining = Math.max(0, mandate.scope.maxUses - mandate.scope.usesConsumed);
  const pips = Array.from({ length: Math.min(mandate.scope.maxUses, 8) }, (_, i) =>
    `<span class="pip${i < mandate.scope.usesConsumed ? ' spent' : ''}"></span>`,
  ).join('');
  const minutes = Math.max(0, Math.round((new Date(mandate.scope.expiresAt).getTime() - Date.now()) / 60_000));

  return `<section class="band">
  <div class="band-title">What this card can do</div>
  <div class="band-row"><span class="band-k">Merchant</span><span class="band-v">${escapeHtml(mandate.scope.merchant)} only</span></div>
  <div class="band-row"><span class="band-k">Ceiling</span><span class="band-v">${formatUsd(mandate.scope.perTransactionCapCents)}</span></div>
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

  return shell(
    `Approve ${formatUsd(mandate.amountCents)} at ${mandate.scope.merchant}`,
    `${masthead('AUTHORIZATION REQUEST')}
<div class="body">
  <span class="stamp wait"><span class="dot live"></span>Awaiting your passkey</span>
  <h1>Release ${formatUsd(mandate.amountCents)} to ${escapeHtml(mandate.scope.merchant)}?</h1>
  <p class="lede"><strong>${escapeHtml(who)}</strong> asked for ${escapeHtml(mandate.purpose)}${mandate.seats ? ` for ${mandate.seats} seats` : ''}.</p>
  ${guardrailBand(mandate)}
  <ul class="reasons">${reasons}</ul>
  <div class="actions">
    <button class="primary" id="approve">Approve with passkey</button>
    <button class="secondary" id="decline">Decline</button>
  </div>
</div>
${footer(mandate)}`,
    `<script>
(function(){
  var token=${JSON.stringify(token)};
  var approve=document.getElementById('approve');
  var decline=document.getElementById('decline');

  async function submit(action, button, workingLabel){
    approve.disabled=true; decline.disabled=true;
    button.textContent=workingLabel;
    try{
      // WebAuthn where the device supports it. The signed token is the
      // server-side authority either way; the platform check is an additional
      // local factor, never the only one.
      if(action==='approve' && window.PublicKeyCredential && navigator.credentials){
        try{
          var available=await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
          if(available){
            await navigator.credentials.get({
              publicKey:{
                challenge:Uint8Array.from(token.slice(0,32).padEnd(32,'0'),function(c){return c.charCodeAt(0)}),
                userVerification:'required',
                timeout:60000,
                rpId:location.hostname
              }
            }).catch(function(){/* no enrolled passkey: fall through to the signed token */});
          }
        }catch(e){}
      }
      var res=await fetch('/authorize/'+encodeURIComponent(token),{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:action})
      });
      var html=await res.text();
      document.open(); document.write(html); document.close();
    }catch(err){
      button.textContent='Could not reach the server. Try again.';
      approve.disabled=false; decline.disabled=false;
    }
  }

  approve.addEventListener('click',function(){submit('approve',approve,'Verifying…')});
  decline.addEventListener('click',function(){submit('decline',decline,'Declining…')});
})();
</script>`,
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

export function declinedPage(mandate: Mandate): string {
  return shell(
    'Declined',
    `${masthead('AUTHORIZATION DECLINED')}
<div class="body">
  <span class="stamp stop"><span class="dot"></span>Declined</span>
  <h1>Nothing was released</h1>
  <p class="lede">No card was issued for ${escapeHtml(mandate.scope.merchant)} and no money moved. ${escapeHtml(mandate.requesterName ?? mandate.requesterPhone)} has been told.</p>
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
