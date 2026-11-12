/* ReintegrAIt Step 2: Matched services (storyboard Step 2 and the first part of Step 3).
   Loaded after the main script in index.html and uses its helpers: Store, SIM, state, app, go, render,
   logEvent, toast, esc, fmt, parseDate, iso, TODAY, TODAY_ISO, clients, mock, secs.
   - Matches, drafts and provider replies come from SIM.matched_services (simulated_responses.json).
   - Eligibility checks (✓ ✗ ?) and the ranking are simple rules in this file.
   - Referrals, case file entries and reminders are saved as Referral, Interaction and Goal records.
   - Turn-downs, added services and changes to a service's openings and credibility are kept in memory for this session. */

const MS = { boards: {}, svc: {} };   // boards: per-client UI state. svc: per-provider changes this session (pooled facts about services, never about clients).
const MS_PRI = { Urgent: 0, Soon: 1, Later: 2 };
const MS_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const msCfg = () => SIM.matched_services;
const msNow = () => Date.now();

/* ---------- Needs ---------- */
function msCategory(text) {
  const cats = msCfg().categories, head = String(text).split(":")[0].trim().toLowerCase();
  const byPrefix = cats.find(c => c.toLowerCase() === head);
  if (byPrefix) return byPrefix;
  const t = String(text).toLowerCase();
  for (const [c, b] of Object.entries(msCfg().needs)) if ((b.keywords || []).some(k => new RegExp("\\b" + k + "\\b").test(t))) return c;
  return "Other";
}
const msLine = text => { const t = String(text).replace(/^[^:]{1,20}:\s*/, ""); return t.charAt(0).toUpperCase() + t.slice(1); };
function msNoteSource(text) {
  const n = SIM.new_client_intake.note, x = n.immediate_needs.find(i => i.text === text);
  return x && x.source ? SIM.new_client_intake.transcript.find(l => l.id === x.source) : null;
}
function msBoard(c) {
  if (!MS.boards[c.id]) {
    MS.boards[c.id] = { open: null, openedAt: msNow(), sentFirst: false, turned: {}, overrides: {}, added: {}, panel: null, declining: null, overriding: null, quote: null, reply: {}, answerKind: {} };
    MS.boards[c.id].fresh = true;
  }
  return MS.boards[c.id];
}
function msRefFor(needId) {
  const r = Store.where("Referral", x => x.NeedId === needId);
  return r.length ? r[r.length - 1] : null;
}
function msNeeds(c) {
  const recs = Store.where("Need", n => n.ClientId === c.id && (n.Status === "Open" || n.Status === "Handled"));
  const list = recs.map((rec, i) => {
    const ref = msRefFor(rec.Id), cat = rec.Category || msCategory(rec.Text);
    const status = rec.Status === "Handled" ? "handled" : ref && ref.Status === "Accepted" ? "done" : ref && ref.Status === "Sent" ? "pending" : "open";
    return { rec, cat, line: msLine(rec.Text), src: msNoteSource(rec.Text), ref, status, idx: i };
  });
  const rank = n => n.rec.BoardRank != null ? n.rec.BoardRank : (MS_PRI[n.rec.Priority] ?? 1) * 100 + n.idx;
  return list.sort((a, b) => (a.status === "handled") - (b.status === "handled") || rank(a) - rank(b));
}
const msClientHasOpenNeed = (c, cat) => msNeeds(c).some(n => n.cat === cat && n.status !== "handled");

/* ---------- Facts and eligibility rules ---------- */
function msFacts(c) {
  const base = { age: { value: Number(c.age), source: "Client record" }, gender: { value: c.gender, source: "Client record" }, enrolled: { value: true, source: "Client record" } };
  const extra = (msCfg().client_facts || {})[c.name] || {};
  const f = { ...extra, ...base };
  if (extra.age) f.age = extra.age;
  if (!c.gender || c.gender === "Not stated") delete f.gender;
  return f;
}
function msCheck(rule, F) {
  if (rule.always) return "y";
  const f = F[rule.fact];
  if (!f || f.value === undefined || f.value === null || f.value === "") return "q";
  let ok;
  if ("equals" in rule) ok = f.value === rule.equals;
  else if (rule.in) ok = rule.in.includes(f.value);
  else { const v = Number(f.value); ok = (rule.min == null || v >= rule.min) && (rule.max == null || v <= rule.max); }
  if (ok && rule.also) { const g = F[rule.also]; if (!g) return "q"; ok = g.value === true; }
  if (ok && rule.also_min_age != null) { if (!F.age) return "q"; ok = Number(F.age.value) >= rule.also_min_age; }
  return ok ? "y" : "n";
}

/* ---------- Services: availability, credibility, score ---------- */
const msSvcState = s => (MS.svc[s.name] = MS.svc[s.name] || { accepted: 0, total: 0, ratings: [], last: null, avail: null });
function msAvail(s) { const o = msSvcState(s).avail; return o || s.availability || { kind: "unknown", text: "Unknown, call to check", updated: null, simulated: true }; }
function msHist(s) {
  if (s.type === "Internal" || !s.history) return null;
  const h = s.history, d = msSvcState(s);
  const raters = (h.raters || 0) + d.ratings.length;
  const rating = raters ? (((h.rating || 0) * (h.raters || 0)) + d.ratings.reduce((a, b) => a + b, 0)) / raters : null;
  return { accepted: h.accepted + d.accepted, total: h.total + d.total, reply_days: h.reply_days, rating, raters, last: d.last };
}
function msCredText(h) {
  if (!h) return "";
  if (!h.total) return "No referral history yet";
  const days = h.reply_days == null ? "" : h.reply_days === 0 ? " · Answers the same day" : ` · Responds within ${h.reply_days} day${h.reply_days === 1 ? "" : "s"}`;
  const rated = h.rating ? ` · Rated ${h.rating.toFixed(1)}/5 by ${h.raters} case manager${h.raters === 1 ? "" : "s"}` : "";
  return `Accepted ${h.accepted} of ${h.total} referrals${days}${rated}`;
}
const msDaysOld = upd => upd ? Math.round((TODAY - parseDate(upd)) / 864e5) : null;
function msEval(s, c, F) {
  const W = msCfg().ranking, checks = (s.rules || []).map(r => ({ r, v: msCheck(r, F) }));
  const fails = checks.filter(x => x.v === "n");
  const docOnly = fails.length > 0 && fails.every(x => x.r.document) && msClientHasOpenNeed(c, "ID");
  const match = fails.length === 0 || docOnly;
  const a = msAvail(s), h = msHist(s);
  let score = W.availability_points[a.kind] ?? W.availability_points.unknown;
  if (h && h.total) score += W.acceptance_weight * (h.accepted / h.total) + (h.rating ? W.rating_weight * (h.rating - 3) : 0);
  else if (s.type === "Internal") score += W.internal_credibility;
  score += W.per_mile * (s.distance_mi || 0);
  score += W.document_gap * fails.filter(x => x.r.document).length + W.unknown_rule * checks.filter(x => x.v === "q").length;
  return { s, checks, fails, docOnly, match, score, avail: a, hist: h };
}
/* All services for one need, sorted into the card grid, Not a match and Turned down. */
function msMatches(c, need) {
  const B = msBoard(c), F = msFacts(c), block = msCfg().needs[need.cat];
  const pool = [...(block ? block.candidates : []), ...(B.added[need.rec.Id] || [])];
  const declinedByProvider = Store.where("Referral", r => r.NeedId === need.rec.Id && r.Status === "Declined");
  const turned = B.turned[need.rec.Id] || {};
  const all = pool.map(s => msEval(s, c, F));
  const out = [], down = [];
  all.forEach(e => {
    const pd = declinedByProvider.find(r => r.ServiceId === e.s.id);
    if (pd) down.push({ e, reason: "Provider said no: " + pd.DeclineReason, undo: false });
    else if (turned[e.s.id]) down.push({ e, reason: turned[e.s.id], undo: true });
    else out.push(e);
  });
  const ranked = out.filter(e => e.match).sort((a, b) => b.score - a.score);
  const max = msCfg().ranking.max_cards;
  const cards = ranked.filter(e => !e.s.addedBy).slice(0, max).concat(ranked.filter(e => e.s.addedBy));
  return { cards, ranked, notMatch: out.filter(e => !e.match), down };
}

/* ---------- Small formatters ---------- */
const msWhen = (dateIso, time) => { const d = parseDate(dateIso); return `${MS_DAYS[d.getDay()]} ${fmt(d)}, ${time}`; };
const msFill = (t, v) => String(t || "").replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
function msVars(c, need, s, extra) {
  const o = msCfg().org, block = msCfg().needs[need.cat] || {};
  return { first: c.name.split(" ")[0], age: c.age, provider: s.name, address: s.address + (s.appt_note ? "" : ""), phone: s.phone,
    cm: o.case_manager, org: o.name, org_phone: o.phone, requested: block.requested || "soon", bring: s.bring || "your release papers", ...extra };
}
const msCheckIcon = { y: ["✓", "Meets"], n: ["✗", "Doesn't meet"], q: ["?", "Unknown, ask"] };
const msKindTag = s => `<span class="tag ${s.type === "Internal" ? "ok" : "info"}">${esc(s.type)}</span>`;
const msRealTag = s => s.addedBy ? `<span class="tag warn">Added by ${esc(s.addedBy)}</span>` : s.real ? `<span class="tag info" title="Listed in public data">Real listing</span>` : `<span class="tag sim">Simulated listing</span>`;

/* ---------- Render ---------- */
function renderServices() {
  const CL = clients(), c = CL.find(x => x.id === state.sel) || CL[0];
  state.sel = c.id;
  const B = msBoard(c), needs = msNeeds(c);
  const open = needs.filter(n => n.status === "open" || n.status === "pending").length;
  if (B.fresh) { B.fresh = false; logEvent(c.name, "Needs board opened", `${needs.length} needs · ${open} open`); }
  if (!needs.find(n => n.rec.Id === B.open)) B.open = (needs.find(n => n.status !== "handled") || needs[0] || {}).rec?.Id || null;
  const need = needs.find(n => n.rec.Id === B.open);
  app.innerHTML = mock + `
  <div class="ms-head"><div><p class="small muted">Case file · ${esc(c.age)} · ${esc(c.locality)}</p><h1 id="ms-name">${esc(c.name)}</h1></div>
   <p id="ms-count"><b>${open} of ${needs.length}</b> needs still open</p></div>
  <div class="ms-tabs" role="tablist" aria-label="Case file sections">
   <button type="button" role="tab" aria-selected="false" id="tab-casefile" data-ms="casefile">Case file</button>
   <button type="button" role="tab" aria-selected="true" id="tab-services">Matched services</button>
  </div>
  <div class="ms-grid">
   <div class="pane" id="ms-board">
    <h2>Needs, by priority <span class="tag sim">AI suggested</span></h2>
    ${needs.length ? `<ol class="ms-buckets" id="ms-buckets">${needs.map((n, i) => msBucket(c, n, i, needs)).join("")}</ol>` : `<p class="small muted">No open needs in this case file yet. Add one below.</p>`}
    <form class="ms-addneed" id="ms-addneed" autocomplete="off">
     <label class="field"><span>Add a need the AI missed</span><select id="ms-newcat" aria-label="Category">${msCfg().categories.map(x => `<option>${esc(x)}</option>`).join("")}</select></label>
     <label class="field"><span>In one line</span><input id="ms-newtext" placeholder="e.g. needs a bus pass for appointments"></label>
     <button class="btn" type="submit" id="ms-addneed-btn">Add need</button>
    </form>
   </div>
   <div id="ms-need">${need ? msNeedDetail(c, need) : `<div class="pane"><p class="muted">Pick a need on the left.</p></div>`}</div>
  </div>
  ${msLogPanel(c)}`;
  const t = document.getElementById("ms-draft"); if (t) t.focus({ preventScroll: true });
}

function msBucket(c, n, i, all) {
  const B = msBoard(c), pc = { Urgent: "u", Soon: "s", Later: "l" };
  const m = n.status === "open" ? msMatches(c, n) : null;
  const ref = n.ref;
  const stat = n.status === "handled" ? `<span aria-hidden="true">—</span> Handled in-house / not needed`
    : n.status === "done" ? `<span aria-hidden="true">✓</span> Referred, appt ${esc(msWhen(ref.Appointment.date, ref.Appointment.time))}`
    : n.status === "pending" ? `<span aria-hidden="true">◷</span> Pending: ${esc(ref.Partner)}`
    : `<span aria-hidden="true">○</span> ${m.ranked.length} matching service${m.ranked.length === 1 ? "" : "s"} found`;
  const movable = n.status !== "handled";
  return `<li class="ms-bucket st-${n.status} ${n.rec.Id === B.open ? "sel" : ""}" data-need="${n.rec.Id}">
   <button type="button" class="ms-bopen" data-ms="open" data-need="${n.rec.Id}" aria-current="${n.rec.Id === B.open}">
    <span class="top"><span class="pri ${pc[n.rec.Priority] || "l"}">${esc(n.rec.Priority || "Soon")}</span><b>${esc(n.cat)}</b>${n.rec.AddedBy ? `<span class="tag warn">Added by ${esc(n.rec.AddedBy)}</span>` : ""}</span>
    <span class="line">${esc(n.line)}</span>
    <span class="ms-bstat">${stat}</span>
   </button>
   <div class="ms-bctl">
    ${n.src ? `<button type="button" class="src" data-ms="quote" data-need="${n.rec.Id}" aria-expanded="${B.quote === n.rec.Id}" title="Show the note line">From note ${esc(n.src.time)}</button>` : `<span class="small muted">${n.rec.AddedBy ? "Added by hand" : "From case file"}</span>`}
    ${movable ? `<button type="button" class="btn" data-ms="up" data-need="${n.rec.Id}" ${i === 0 ? "disabled" : ""} aria-label="Move ${esc(n.cat)} up">↑</button><button type="button" class="btn" data-ms="down" data-need="${n.rec.Id}" ${i >= all.filter(x => x.status !== "handled").length - 1 ? "disabled" : ""} aria-label="Move ${esc(n.cat)} down">↓</button>` : ""}
    ${n.status === "open" ? `<button type="button" class="btn" data-ms="handled" data-need="${n.rec.Id}">Handled in-house / not needed</button>` : n.status === "handled" ? `<button type="button" class="btn" data-ms="reopen" data-need="${n.rec.Id}">Reopen</button>` : ""}
   </div>
   ${B.quote === n.rec.Id && n.src ? `<p class="ms-quote">${esc(n.src.time)} · ${esc(n.src.speaker)}: “${esc(n.src.text)}”</p>` : ""}
  </li>`;
}

function msNeedDetail(c, n) {
  const B = msBoard(c);
  const head = `<div class="ms-head" style="margin-bottom:8px"><div><p class="small muted">${esc(n.rec.Priority)} · ${esc(n.cat)}</p><h3 style="font-size:19px" id="ms-need-title">${esc(n.line)}</h3></div></div>`;
  if (n.status === "handled") return `<div class="pane">${head}<p>Marked <b>handled in-house / not needed</b>. No referral will be made.</p><div class="btns" style="margin-top:10px"><button class="btn" type="button" data-ms="reopen" data-need="${n.rec.Id}">Reopen this need</button></div></div>`;
  if (n.status === "pending") return `<div class="pane">${head}${msPendingPanel(c, n)}</div>`;
  if (n.status === "done") return `<div class="pane">${head}${msAcceptedPanel(c, n)}</div>`;

  const M = msMatches(c, n), block = msCfg().needs[n.cat];
  const P = B.panel && B.panel.need === n.rec.Id ? B.panel : null;
  return `<div class="pane">${head}
   ${P ? msReferPanel(c, n, P) : ""}
   <h2>Matched services <span class="tag info">${M.cards.length}</span> <span class="small muted" style="text-transform:none;letter-spacing:0;font-weight:400">Ranked by availability, credibility and distance</span></h2>
   ${!block ? `<p class="small muted">The directory has no services for “${esc(n.cat)}”. Search below or add one by hand.</p>` : ""}
   ${M.cards.length ? `<div class="ms-cards" id="ms-cards">${M.cards.map((e, i) => msCard(c, n, e, i, M)).join("")}</div>` : block ? `<p class="small muted" style="margin-block:8px">No matching services left. Check “Not a match” or search for one.</p>` : ""}
   <details class="ms-more" id="ms-notmatch" ${B.overriding ? "open" : ""}><summary>Not a match (${M.notMatch.length})</summary>
    ${M.notMatch.length ? `<ul class="ms-list">${M.notMatch.map(e => `<li><span class="grow"><b>${esc(e.s.name)}</b> ${msKindTag(e.s)}<br><span class="small">${e.fails.map(f => `<span aria-hidden="true">✗</span> ${esc(f.r.label)}`).join(" · ")}${e.docOnly ? "" : ""}</span><span class="small muted"> · rule from ${esc(e.fails[0].r.source)}</span></span>
      ${B.overriding === e.s.id ? `<span class="ms-inline"><input id="ms-ovnote" placeholder="Why refer anyway? (required)" aria-label="Override note"><button class="btn primary" type="button" data-ms="override-go" data-svc="${e.s.id}" id="ms-ovgo" disabled>Refer anyway</button><button class="btn ghost" type="button" data-ms="override-cancel">Cancel</button></span>` : `<button class="btn" type="button" data-ms="override" data-svc="${e.s.id}">Refer anyway</button>`}</li>`).join("")}</ul>` : `<p class="small muted" style="margin-top:6px">Every service in the directory fits this client.</p>`}
   </details>
   <details class="ms-more" id="ms-turned" ${M.down.length ? "open" : ""}><summary>Turned down (${M.down.length})</summary>
    ${M.down.length ? `<ul class="ms-list">${M.down.map(d => `<li><span class="grow"><b>${esc(d.e.s.name)}</b> · <span class="small">${esc(d.reason)}</span></span>${d.undo ? `<button class="btn ghost" type="button" data-ms="undo-turn" data-svc="${d.e.s.id}">Undo</button>` : ""}</li>`).join("")}</ul>` : `<p class="small muted" style="margin-top:6px">Nothing turned down yet.</p>`}
   </details>
   <details class="ms-more" id="ms-search"><summary>Search for a service that isn't listed</summary>
    <div class="ms-inline" style="margin-top:8px"><input id="ms-q" type="search" placeholder="Search the directory by name or kind" aria-label="Search services"></div>
    <div id="ms-results">${msResults(c, n, "")}</div>
   </details>
  </div>`;
}

function msCard(c, n, e, i, M) {
  const B = msBoard(c), s = e.s, a = e.avail, old = msDaysOld(a.updated), stale = old != null && old > msCfg().ranking.stale_after_days;
  const F = msFacts(c);
  const rank = M.ranked.indexOf(e) + 1;
  return `<article class="ms-card ${i === 0 ? "top1" : ""}" data-svc="${s.id}" aria-label="${esc(s.name)}">
   <header><span class="ms-rank">#${rank}</span>${msKindTag(s)}${msRealTag(s)}<h3>${esc(s.name)}</h3></header>
   <p class="meta">${esc(s.address)}${s.distance_mi ? ` · ${s.distance_mi} mi from ${esc(c.locality)}` : ""}<br>${esc(s.phone)} · ${esc(s.hours)}</p>
   <div class="blk"><b>Availability</b>${esc(a.text)}<br><span class="small muted">Updated ${a.updated ? fmt(parseDate(a.updated)) : "unknown"}${a.simulated ? " (simulated)" : ""}</span>${stale ? ` <span class="ms-stale small">· may be stale</span>` : ""}</div>
   <div class="blk"><b>Eligibility check</b><ul class="ms-checks">${e.checks.length ? e.checks.map(x => { const f = F[x.r.fact]; return `<li class="${x.v}"><i aria-hidden="true">${msCheckIcon[x.v][0]}</i><span><span class="ms-sr">${msCheckIcon[x.v][1]}: </span>${esc(x.r.label)}${x.v === "n" && x.r.document ? ` (${esc(c.name.split(" ")[0])} is getting it)` : ""}${x.v === "q" ? " (ask)" : ""}<span class="src">Rule: ${esc(x.r.source)}${f && !x.r.always ? ` · ${esc(c.name.split(" ")[0])}: ${esc(f.source)}` : ""}</span></span></li>`; }).join("") : `<li class="q"><i aria-hidden="true">?</i><span>No rules on file. Ask the provider.</span></li>`}</ul></div>
   ${s.type === "External" ? `<div class="blk"><b>Credibility</b>${esc(msCredText(e.hist)) || "No referral history yet"}${e.hist && e.hist.last ? `<br><span class="small">Last answer: ${esc(e.hist.last)}</span>` : ""}<br><span class="small muted">${s.addedBy ? "" : "From pooled referral history (simulated)"}</span></div>` : ""}
   <p class="ms-why"><b>Why it's suggested:</b> ${esc(s.why || "Added by hand.")}</p>
   <p class="ms-prov">Listing: ${esc(s.listing_source || "Added by Denise")}${s.real ? " (real public data)" : ""}. ${s.addedBy ? "" : "Openings and credibility are simulated."}</p>
   ${B.declining === s.id ? `<div class="ms-reasons" role="group" aria-label="Why not this one?"><p>Why not this one?</p>${msCfg().turn_down_reasons.map(r => `<button type="button" class="btn" data-ms="turn" data-svc="${s.id}" data-reason="${esc(r)}">${esc(r)}</button>`).join("")}<button type="button" class="btn ghost" data-ms="turn-cancel">Cancel</button></div>`
    : `<div class="btns"><button type="button" class="btn primary" data-ms="refer" data-svc="${s.id}">Refer</button><button type="button" class="btn" data-ms="decline" data-svc="${s.id}">Not this one</button></div>`}
  </article>`;
}

function msResults(c, n, q) {
  const have = new Set([...(msCfg().needs[n.cat]?.candidates || []), ...(msBoard(c).added[n.rec.Id] || [])].map(s => s.name));
  const seen = new Set(), all = [];
  Object.entries(msCfg().needs).forEach(([cat, b]) => b.candidates.forEach(s => { if (!have.has(s.name) && !seen.has(s.name)) { seen.add(s.name); all.push({ s, cat }); } }));
  const t = q.trim().toLowerCase();
  const hits = t ? all.filter(x => (x.s.name + " " + x.cat + " " + x.s.address).toLowerCase().includes(t)) : all.slice(0, 4);
  return `${hits.length ? `<ul class="ms-list">${hits.map(x => `<li><span class="grow"><b>${esc(x.s.name)}</b> ${msKindTag(x.s)} <span class="small muted">· listed under ${esc(x.cat)}</span></span><button class="btn" type="button" data-ms="add-dir" data-svc="${x.s.id}">Add to this need</button></li>`).join("")}</ul>` : `<p class="small muted" style="margin-top:6px">No match in the directory.</p>`}
   <form class="ms-inline" id="ms-addsvc" style="margin-top:10px" autocomplete="off">
    <span class="small muted" style="flex:1 1 100%">Not in the directory? Add it by hand.</span>
    <input id="ms-svcname" placeholder="Service name" aria-label="Service name" value="${esc(q)}">
    <input id="ms-svcphone" placeholder="Phone" aria-label="Phone">
    <select id="ms-svctype" aria-label="Internal or External"><option>External</option><option>Internal</option></select>
    <button class="btn" type="submit" id="ms-addsvc-btn">Add service</button>
   </form>`;
}

/* Step 3: referral request */
function msReferPanel(c, n, P) {
  const s = msFindSvc(c, n, P.svc), first = c.name.split(" ")[0];
  const block = msCfg().needs[n.cat] || {};
  return `<section class="ms-panel" id="ms-refer" aria-label="Referral request">
   <div class="ms-head" style="margin:0"><h3>Referral request to ${esc(s.name)}</h3>${msKindTag(s)}</div>
   ${P.override ? `<p class="small"><span class="tag warn">Override</span> Referring anyway: ${esc(P.override)}</p>` : ""}
   <label class="field"><span>Draft message to the provider (AI draft, edit freely)</span><textarea id="ms-draft">${esc(P.draft)}</textarea></label>
   <label class="chk"><input type="checkbox" id="ms-consent" ${P.consent ? "checked" : ""}> <span>${esc(first)} agreed to share this information with ${esc(s.name)}</span></label>
   <fieldset><legend>How will you contact them?</legend>
    <label class="chk"><input type="radio" name="ms-method" value="message" ${P.method === "message" ? "checked" : ""}> Message</label>
    <label class="chk"><input type="radio" name="ms-method" value="call" ${P.method === "call" ? "checked" : ""}> Call</label>
   </fieldset>
   ${P.method === "call" ? `<div class="ms-callbox" id="ms-callbox"><span class="small muted">Call</span><div class="num">${esc(s.phone)}</div><p style="margin-top:6px"><b>Script:</b> ${esc(msFill(block.call_script || "Say who you are and that {first} agreed to the referral, then ask about openings.", msVars(c, n, s)))}</p></div>` : ""}
   <div class="btns">
    <button class="btn primary" type="button" id="ms-send" data-ms="send" ${P.consent ? "" : "disabled"}>${P.method === "call" ? "Log call" : "Send message"}</button>
    <button class="btn" type="button" data-ms="refer-cancel">Cancel</button>
    <span class="small muted" id="ms-sendhint">${P.consent ? "Nothing is really sent in this prototype." : "Tick consent to send."}</span>
   </div>
  </section>`;
}

/* Step 4: provider's answer */
function msPendingPanel(c, n) {
  const B = msBoard(c), r = n.ref, rep = B.reply[r.Id], k = B.answerKind[r.Id] || (rep ? rep.kind : "");
  const block = msCfg().needs[n.cat] || {}, py = (block.provider_reply || {}).yes || {}, pn = (block.provider_reply || {}).no || {};
  return `<section class="ms-panel" id="ms-pending">
   <div class="ms-head" style="margin:0"><h3>Request sent to ${esc(r.Partner)}, awaiting answer</h3><span class="tag warn">Pending</span></div>
   <p class="small">Sent ${fmt(parseDate(r.SentDate))} by ${r.Method === "call" ? "phone (call logged)" : "message"} · Consent: ${r.Consent ? "yes" : "no"} · Rank #${esc(r.Rank)}</p>
   <p class="ms-quote2">${esc(r.Draft)}</p>
   <div class="ms-sim" role="group" aria-label="Simulate provider reply"><span class="tag sim">Prototype</span><b class="small">Simulate provider reply</b>
    <button class="btn" type="button" data-ms="sim" data-kind="yes" id="ms-simyes">Yes</button><button class="btn" type="button" data-ms="sim" data-kind="no" id="ms-simno">No</button></div>
   ${rep ? `<div style="display:flex;flex-direction:column;gap:4px"><span class="small muted">${esc(r.Partner)} replied:</span><div class="ms-bubble in" id="ms-reply">${esc(rep.message)}</div></div>` : ""}
   <form id="ms-answer" autocomplete="off" style="display:flex;flex-direction:column;gap:10px">
    <fieldset><legend>${rep ? "Record the provider's answer" : "Or record what the provider said on the phone"}</legend>
     <label class="chk"><input type="radio" name="ms-ans" value="yes" ${k === "yes" ? "checked" : ""}> Yes, accepted</label>
     <label class="chk"><input type="radio" name="ms-ans" value="no" ${k === "no" ? "checked" : ""}> No</label>
    </fieldset>
    ${k === "yes" ? `<div class="ms-answer"><label class="field"><span>Appointment date</span><input type="date" id="ms-adate" value="${esc(py.date || "")}"></label><label class="field"><span>Time</span><input type="time" id="ms-atime" value="${esc(py.time || "")}"></label></div>` : ""}
    ${k === "no" ? `<div class="ms-answer"><label class="field"><span>Reason</span><select id="ms-areason">${msCfg().decline_reasons.map(x => `<option ${x === (rep && rep.kind === "no" ? pn.reason : "") ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label></div>` : ""}
    <div class="btns"><button class="btn primary" type="submit" id="ms-anssave" ${k ? "" : "disabled"}>Save answer</button></div>
   </form>
  </section>`;
}

function msAcceptedPanel(c, n) {
  const r = n.ref, s = msFindSvc(c, n, r.ServiceId) || { name: r.Partner, address: "", bring: "" };
  const when = msWhen(r.Appointment.date, r.Appointment.time);
  const goals = Store.where("Goal", g => g.ReferralId === r.Id);
  const textBlock = r.ClientTextSentAt
    ? `<div class="ms-phone" aria-label="Text message to ${esc(c.name)}"><div class="to">To ${esc(c.name.split(" ")[0])} · ${esc(c.phone)}</div><div class="ms-bubble out" id="ms-sent-text">${esc(r.ClientText)}</div><span class="st">Sent (simulated) · ${esc(r.ClientTextSentAt)}</span></div>`
    : `<div class="ms-textgrid">
        <label class="field"><span>Text to ${esc(c.name.split(" ")[0])} (AI draft, edit before sending)</span><textarea id="ms-ctext">${esc(r.ClientText)}</textarea>
         <span class="btns" style="margin-top:8px"><button class="btn primary" type="button" data-ms="send-text" id="ms-ctext-send">Approve and send text</button><span class="small muted">Simulated. Nothing goes to ${esc(c.name.split(" ")[0])} until you approve.</span></span></label>
        <div class="ms-phone" aria-label="Preview"><div class="to">To ${esc(c.name.split(" ")[0])} · ${esc(c.phone)}</div><div class="ms-bubble out" id="ms-preview">${esc(r.ClientText)}</div><span class="st">Not sent yet</span></div>
       </div>`;
  return `<section class="ms-panel done" id="ms-accepted">
   <div class="ms-head" style="margin:0"><h3><span aria-hidden="true">✓</span> ${esc(r.Partner)} accepted: ${esc(when)}</h3><span class="tag ok">Referred</span></div>
   <p class="small">Answer logged ${fmt(parseDate(r.AnswerDate))} · ${r.Method === "call" ? "by phone" : "by message"}.</p>
   ${textBlock}
   ${goals.length ? `<div><h2 style="margin-bottom:6px">Reminders in the case file <span class="tag info">${goals.length}</span></h2><ul class="ms-rems" id="ms-rems">${goals.map(g => `<li><span class="d">${fmt(parseDate(g.DueDate))}</span><span><b>${esc(g.Type)}</b><br>${esc(g.Text)}</span></li>`).join("")}</ul></div>` : ""}
   ${r.ClientTextSentAt ? `<div><h2 style="margin-bottom:6px">Rate ${esc(r.Partner)}</h2><div class="ms-stars" role="group" aria-label="Rate the provider from 1 to 5">${[1, 2, 3, 4, 5].map(x => `<button class="btn" type="button" data-ms="rate" data-v="${x}" aria-pressed="${r.Rating === x}">${x}</button>`).join("")}<span class="small muted">${r.Rating ? `You rated ${r.Rating}/5` : "1 = poor, 5 = great. Shared as a fact about the service."}</span></div></div>` : ""}
  </section>`;
}

function msLogPanel(c) {
  const rows = ACTIVITY.filter(a => a.client === c.name);
  return `<details class="ms-log" id="ms-log" ${MS.logOpen ? "open" : ""}><summary>Activity log <span class="tag info">${rows.length}</span></summary>
   ${rows.length ? `<div class="tablewrap"><table class="log"><thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows.map(a => `<tr><td class="when">${esc(a.at.slice(0, 5))}</td><td class="ev">${esc(a.event)}</td><td>${esc(a.detail)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small muted">Nothing yet.</p>`}
  </details>`;
}

/* ---------- Actions ---------- */
function msFindSvc(c, n, id) {
  const B = msBoard(c);
  const pool = [...(msCfg().needs[n.cat]?.candidates || []), ...(B.added[n.rec.Id] || [])];
  return pool.find(s => s.id === id) || Object.values(msCfg().needs).flatMap(b => b.candidates).find(s => s.id === id);
}
function msCtx() {
  const c = clients().find(x => x.id === state.sel), B = msBoard(c), needs = msNeeds(c), n = needs.find(x => x.rec.Id === B.open);
  return { c, B, needs, n };
}
function msOpenReferral(c, n, s, override) {
  const B = msBoard(c), block = msCfg().needs[n.cat] || {};
  const tpl = block.referral_draft || "Hi, this is {cm} at {org}. I'd like to refer {first} ({age}) to {provider} for help with: " + n.line + ". {first} has consented to this referral. Reach me at {org_phone}.";
  const draft = msFill(tpl, msVars(c, n, s));
  B.panel = { need: n.rec.Id, svc: s.id, draft, aiDraft: draft, consent: false, method: "message", override: override || null };
  B.declining = null; B.overriding = null;
}
function msReorder(c, needs, id, dir) {
  const live = needs.filter(n => n.status !== "handled");
  const i = live.findIndex(n => n.rec.Id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= live.length) return;
  [live[i], live[j]] = [live[j], live[i]];
  live.forEach((n, k) => Store.update("Need", n.rec.Id, { BoardRank: k }));
  Store.save();
  logEvent(c.name, "Priority reordered", `${live[j].cat} moved ${dir < 0 ? "up" : "down"} to #${j + 1}`);
}

app.addEventListener("click", e => {
  if (state.view !== "services") return;
  const b = e.target.closest("[data-ms]"); if (!b || b.disabled) return;
  const { c, B, needs, n } = msCtx(), a = b.dataset.ms, first = c.name.split(" ")[0];
  const need = b.dataset.need ? needs.find(x => x.rec.Id === b.dataset.need) : n;
  switch (a) {
    case "casefile": go("clients"); return;
    case "open": {
      if (B.open !== need.rec.Id) { B.open = need.rec.Id; B.declining = null; B.overriding = null;
        const m = need.status === "open" ? msMatches(c, need) : null;
        logEvent(c.name, "Need opened", `${need.cat}${m ? ` · ${m.cards.length} service cards` : ` · ${need.status}`}`); }
      renderServices(); if (innerWidth < 900) document.getElementById("ms-need").scrollIntoView({ behavior: "smooth" }); return;
    }
    case "quote": B.quote = B.quote === need.rec.Id ? null : need.rec.Id; if (B.quote) logEvent(c.name, "Note line opened", `${need.cat} · ${need.src.time}`); break;
    case "up": case "down": msReorder(c, needs, need.rec.Id, a === "up" ? -1 : 1); break;
    case "handled": Store.update("Need", need.rec.Id, { Status: "Handled" }); Store.save(); logEvent(c.name, "Need marked handled", `${need.cat} · Handled in-house / not needed`); break;
    case "reopen": Store.update("Need", need.rec.Id, { Status: "Open" }); Store.save(); logEvent(c.name, "Need reopened", need.cat); break;
    case "decline": B.declining = b.dataset.svc; break;
    case "turn-cancel": B.declining = null; break;
    case "turn": {
      const s = msFindSvc(c, n, b.dataset.svc), reason = b.dataset.reason, shown = new Set(msMatches(c, n).cards.map(x => x.s.id));
      (B.turned[n.rec.Id] = B.turned[n.rec.Id] || {})[s.id] = reason; B.declining = null;
      if (B.panel && B.panel.svc === s.id) B.panel = null;
      logEvent(c.name, "Turned down", `${n.cat} · "${s.name}" · reason: ${reason}`);
      const up = msMatches(c, n).cards.find(x => !shown.has(x.s.id)); toast(up ? `${up.s.name} moved up into the list.` : `${s.name} turned down.`);
      break;
    }
    case "undo-turn": { const s = msFindSvc(c, n, b.dataset.svc); delete (B.turned[n.rec.Id] || {})[s.id]; logEvent(c.name, "Turn-down undone", `${n.cat} · "${s.name}"`); break; }
    case "refer": {
      const s = msFindSvc(c, n, b.dataset.svc), M = msMatches(c, n), rank = M.ranked.findIndex(e => e.s.id === s.id) + 1;
      msOpenReferral(c, n, s); B.panel.rank = s.addedBy ? "added by hand" : String(rank);
      logEvent(c.name, "Refer chosen", `${n.cat} · "${s.name}" · ${s.addedBy ? "added by hand" : `rank #${rank} of ${M.ranked.length}`}`);
      renderServices(); document.getElementById("ms-refer").scrollIntoView({ behavior: "smooth", block: "nearest" }); return;
    }
    case "refer-cancel": logEvent(c.name, "Referral cancelled", `${n.cat} · "${msFindSvc(c, n, B.panel.svc).name}"`); B.panel = null; break;
    case "override": B.overriding = b.dataset.svc; renderServices(); document.getElementById("ms-ovnote").focus(); return;
    case "override-cancel": B.overriding = null; break;
    case "override-go": {
      const note = document.getElementById("ms-ovnote").value.trim(); if (!note) return;
      const s = msFindSvc(c, n, b.dataset.svc), e2 = msEval(s, c, msFacts(c));
      msOpenReferral(c, n, s, note); B.panel.rank = "override";
      logEvent(c.name, "Refer anyway (override)", `${n.cat} · "${s.name}" · overrode: ${e2.fails.map(f => f.r.label).join(", ")} · note: ${note}`);
      renderServices(); document.getElementById("ms-refer").scrollIntoView({ behavior: "smooth", block: "nearest" }); return;
    }
    case "add-dir": {
      const src = Object.values(msCfg().needs).flatMap(x => x.candidates).find(s => s.id === b.dataset.svc);
      const s = { ...JSON.parse(JSON.stringify(src)), id: src.id + "@" + n.rec.Id, addedBy: "Denise", why: `Added by Denise from the directory. ${src.why || ""}`.trim() };
      (B.added[n.rec.Id] = B.added[n.rec.Id] || []).push(s);
      logEvent(c.name, "Service added", `${n.cat} · "${s.name}" · added by Denise from the directory`);
      break;
    }
    case "send": {
      const P = B.panel; if (!P || !P.consent) return;
      const s = msFindSvc(c, n, P.svc), draft = document.getElementById("ms-draft").value.trim();
      const it = Store.insert("Interaction", { ClientId: c.id, Date: TODAY_ISO, Type: "Referral sent", Channel: P.method === "call" ? "Phone" : "Message", Template: "Referral request", SourceName: null,
        Summary: `Referred to ${s.name} (${s.type}) for ${n.cat.toLowerCase()}: ${n.line}. Request sent by ${P.method === "call" ? "phone" : "message"}, awaiting answer. ${first} agreed to share this information.` });
      const r = Store.insert("Referral", { ClientId: c.id, InteractionId: it.Id, NeedId: n.rec.Id, Partner: s.name, Service: n.cat, ServiceId: s.id, ServiceType: s.type,
        Status: "Sent", SentDate: TODAY_ISO, SentAt: msNow(), Method: P.method, Consent: true, Draft: draft, Rank: P.rank, Override: P.override });
      Store.update("Client", c.id, { Status: "Referral pending" });
      Store.save();
      logEvent(c.name, "Consent recorded", `${n.cat} · ${first} agreed to share with "${s.name}": yes`);
      logEvent(c.name, P.method === "call" ? "Call logged" : "Referral sent", `${n.cat} · "${s.name}" · by ${P.method} · rank ${P.rank === "override" || P.rank === "added by hand" ? P.rank : "#" + P.rank} · draft ${draft === P.aiDraft ? "not edited" : `edited: ${P.aiDraft.length} → ${draft.length} chars`}`);
      if (!B.sentFirst) { B.sentFirst = true; logEvent(c.name, "First request sent", `${secs(msNow() - B.openedAt)} from opening the board`); }
      B.panel = null; toast(`Request sent to ${s.name}. Awaiting answer.`);
      void r; break;
    }
    case "sim": {
      const r = n.ref, rep = ((msCfg().needs[n.cat] || {}).provider_reply || {})[b.dataset.kind] || { message: b.dataset.kind === "yes" ? "Yes, we can see them." : "Sorry, we can't take this referral.", reason: "Other" };
      B.reply[r.Id] = { kind: b.dataset.kind, message: rep.message }; B.answerKind[r.Id] = b.dataset.kind;
      logEvent(c.name, "Provider reply simulated", `${n.cat} · "${r.Partner}" · ${b.dataset.kind === "yes" ? "Yes" : "No"}: ${rep.message}`);
      break;
    }
    case "send-text": {
      const r = n.ref, txt = document.getElementById("ms-ctext").value.trim(); if (!txt) return;
      const ai = r.ClientTextDraft || r.ClientText, s = msFindSvc(c, n, r.ServiceId) || { name: r.Partner };
      const d = parseDate(r.Appointment.date), before = new Date(d), after = new Date(d); before.setDate(d.getDate() - 1); after.setDate(d.getDate() + 1);
      Store.update("Referral", r.Id, { ClientText: txt, ClientTextSentAt: clock().slice(0, 5) });
      Store.insert("Interaction", { ClientId: c.id, Date: TODAY_ISO, Type: "Text to client", Channel: "SMS (simulated)", Template: "Appointment text", SourceName: null, Summary: `Texted ${first}: ${txt}` });
      const g1 = Store.insert("Goal", { ClientId: c.id, ReferralId: r.Id, Type: "Client reminder (text)", Text: `Text ${first} a reminder: ${r.Partner} tomorrow at ${r.Appointment.time}.`, DueDate: iso(before), Status: "Open", InteractionId: r.InteractionId });
      const g2 = Store.insert("Goal", { ClientId: c.id, ReferralId: r.Id, Type: "Attendance check", Text: `Check with ${r.Partner} that ${first} attended on ${fmt(d)}.`, DueDate: iso(after), Status: "Open", InteractionId: r.InteractionId });
      Store.save();
      logEvent(c.name, "Client text approved", `${n.cat} · ${txt === ai ? "not edited" : `edited: ${ai.length} → ${txt.length} chars`} · sent (simulated)`);
      [g1, g2].forEach(g => logEvent(c.name, "Reminder scheduled", `${g.Type}, ${fmt(parseDate(g.DueDate))}: ${g.Text}`));
      void s; toast("Text sent (simulated). Two reminders added to the case file."); break;
    }
    case "rate": {
      const r = n.ref, v = +b.dataset.v, s = msFindSvc(c, n, r.ServiceId) || { name: r.Partner };
      const st = msSvcState(s); if (r.Rating) st.ratings.splice(st.ratings.indexOf(r.Rating), 1); st.ratings.push(v);
      Store.update("Referral", r.Id, { Rating: v }); Store.save();
      logEvent(c.name, "Provider rated", `"${r.Partner}" · ${v}/5`); break;
    }
    default: return;
  }
  renderServices();
});

app.addEventListener("submit", e => {
  if (state.view !== "services") return;
  e.preventDefault();
  const { c, B, n } = msCtx(), f = e.target, first = c.name.split(" ")[0];
  if (f.id === "ms-addneed") {
    const cat = document.getElementById("ms-newcat").value, text = document.getElementById("ms-newtext").value.trim();
    if (!text) { document.getElementById("ms-newtext").focus(); return; }
    const rec = Store.insert("Need", { ClientId: c.id, Text: `${cat}: ${text}`, Category: cat, Priority: "Soon", Status: "Open", CreatedDate: TODAY_ISO, InteractionId: null, AddedBy: "Denise" });
    Store.save(); B.open = rec.Id;
    const n2 = msNeeds(c).find(x => x.rec.Id === rec.Id), m = msMatches(c, n2);
    logEvent(c.name, "Need added", `${cat}: ${text} · ${m.ranked.length} services matched`);
    renderServices(); return;
  }
  if (f.id === "ms-addsvc") {
    const name = document.getElementById("ms-svcname").value.trim(); if (!name) { document.getElementById("ms-svcname").focus(); return; }
    const s = { id: "hand-" + Date.now().toString(36), name, type: document.getElementById("ms-svctype").value, real: false, addedBy: "Denise", listing_source: "Added by Denise",
      address: "Address not recorded", distance_mi: 0, phone: document.getElementById("ms-svcphone").value.trim() || "Phone not recorded", hours: "Hours unknown",
      availability: { kind: "unknown", text: "Unknown, call to check", updated: TODAY_ISO, simulated: false }, rules: [], history: { accepted: 0, total: 0, reply_days: null, rating: null, raters: 0 },
      why: "Added by Denise.", bring: "your release papers" };
    (B.added[n.rec.Id] = B.added[n.rec.Id] || []).push(s);
    logEvent(c.name, "Service added", `${n.cat} · "${name}" · added by Denise by hand`);
    renderServices(); return;
  }
  if (f.id === "ms-answer") {
    const r = n.ref, k = B.answerKind[r.Id]; if (!k) return;
    const s = msFindSvc(c, n, r.ServiceId) || { name: r.Partner }, st = msSvcState(s);
    const took = secs(msNow() - (r.SentAt || msNow()));
    if (k === "yes") {
      const date = document.getElementById("ms-adate").value, time = document.getElementById("ms-atime").value;
      if (!date || !time) { (date ? document.getElementById("ms-atime") : document.getElementById("ms-adate")).focus(); return; }
      const when = msWhen(date, time);
      const block = msCfg().needs[n.cat] || {};
      const txt = msFill(block.client_text || "Hi {first}, it's Denise. You're booked at {provider}, {address}, {when}. Bring {bring}.", msVars(c, n, s, { when: when.replace(", ", " at ") }));
      Store.update("Referral", r.Id, { Status: "Accepted", AnswerDate: TODAY_ISO, Appointment: { date, time }, ClientText: txt, ClientTextDraft: txt });
      Store.insert("Interaction", { ClientId: c.id, Date: TODAY_ISO, Type: "Referral accepted", Channel: r.Method === "call" ? "Phone" : "Message", Template: "Provider answer", SourceName: null, Summary: `${r.Partner} accepted ${first} for ${n.cat.toLowerCase()}. Appointment ${when}.` });
      st.accepted++; st.total++; st.last = `Yes (${fmt(TODAY)})`;
      logEvent(c.name, "Provider answer", `${n.cat} · "${r.Partner}" · Yes, accepted · appt ${when} · answered ${took} after sending`);
    } else {
      const reason = document.getElementById("ms-areason").value;
      Store.update("Referral", r.Id, { Status: "Declined", AnswerDate: TODAY_ISO, DeclineReason: reason });
      Store.insert("Interaction", { ClientId: c.id, Date: TODAY_ISO, Type: "Referral declined", Channel: r.Method === "call" ? "Phone" : "Message", Template: "Provider answer", SourceName: null, Summary: `${r.Partner} said no (${reason}). Back to matched services for ${n.cat.toLowerCase()}.` });
      st.total++; st.last = `No, ${reason} (${fmt(TODAY)})`;
      if (reason === "Full") st.avail = { kind: "full", text: `Full (provider said no on ${fmt(TODAY)})`, updated: TODAY_ISO, simulated: false };
      if (reason === "Program closed") st.avail = { kind: "full", text: `Program closed (reported ${fmt(TODAY)})`, updated: TODAY_ISO, simulated: false };
      if (reason === "Not eligible") st.last += ". Check its eligibility rules";
      const next = msMatches(c, n).cards[0];
      logEvent(c.name, "Provider answer", `${n.cat} · "${r.Partner}" · No · reason: ${reason} · answered ${took} after sending${next ? ` · next on top: "${next.s.name}"` : ""}`);
      toast(next ? `${next.s.name} is now on top.` : "No more matches. Search or add a service.");
    }
    delete B.reply[r.Id]; delete B.answerKind[r.Id];
    Store.save(); renderServices();
  }
});

app.addEventListener("input", e => {
  if (state.view !== "services") return;
  const { c, B, n } = msCtx(), t = e.target;
  if (t.id === "ms-draft" && B.panel) B.panel.draft = t.value;
  if (t.id === "ms-ctext") { const p = document.getElementById("ms-preview"); if (p) p.textContent = t.value; }
  if (t.id === "ms-ovnote") document.getElementById("ms-ovgo").disabled = !t.value.trim();
  if (t.id === "ms-q") document.getElementById("ms-results").innerHTML = msResults(c, n, t.value);
});

app.addEventListener("change", e => {
  if (state.view !== "services") return;
  const { c, B, n } = msCtx(), t = e.target, first = c.name.split(" ")[0];
  if (t.id === "ms-consent" && B.panel) {
    B.panel.consent = t.checked; B.panel.draft = document.getElementById("ms-draft").value;
    logEvent(c.name, t.checked ? "Consent ticked" : "Consent unticked", `${n.cat} · ${first} agreed to share with "${msFindSvc(c, n, B.panel.svc).name}": ${t.checked ? "yes" : "no"}`);
    renderServices();
  }
  if (t.name === "ms-method" && B.panel) {
    B.panel.method = t.value; B.panel.draft = document.getElementById("ms-draft").value;
    logEvent(c.name, "Contact method chosen", `${n.cat} · ${t.value === "call" ? "Call" : "Message"}`);
    renderServices();
  }
  if (t.name === "ms-ans" && n.ref) { B.answerKind[n.ref.Id] = t.value; renderServices(); }
});

document.addEventListener("toggle", e => { if (e.target.id === "ms-log") MS.logOpen = e.target.open; }, true);
