/* ReintegrAIt: Grant report tab.
   Totals the case-file records (interactions, services, referrals) for a reporting period, drafts the
   narrative for a funder, and holds it until the case manager has edited it and ticked the review check.
   Loaded after index.html's main script and uses its helpers
   (Store, state, app, go, logEvent, toast, esc, fmt, parseDate, TODAY, TODAY_ISO, mockbar).
   The narrative is drafted from the numbers by plain templates (simulated AI). Nothing leaves the browser.
   The two funder layouts are sample layouts, not the funders' official forms. */

const GR_PERIODS = {
  q4: { label: "Q4 2026, Oct 1 to Nov 11 (quarter so far)", from: "2026-10-01", to: "2026-11-11" },
  q3: { label: "Q3 2026, Jul 1 to Sep 30", from: "2026-07-01", to: "2026-09-30" },
  half: { label: "Jul 1 to Nov 11, 2026 (six-month period so far)", from: "2026-07-01", to: "2026-11-11" },
};
/* What each funder asks for, taken from its published instructions:
   - ICJIA R3: 2025 Service Delivery NOFO #2378-030124, section 5 "Performance Measures". Quarterly reports: total and unique clients
     served, clients by race/ethnicity, gender and age group, plus the grantee's own metrics from its AmpliFund performance plan.
   - BJA Second Chance Act Innovative Reentry Initiatives, performance measures (revised Dec 2021). Quarterly data entered in JustGrants:
     participants served (cumulative), still engaged, services received. Seven narrative questions every six months (January and July). */
const GR_FUNDERS = {
  icjia: { label: "ICJIA R3 (Illinois Restore, Reinvest, Renew), quarterly", sections: ["summary", "services", "referrals", "challenges", "next"],
    source: "ICJIA R3 2025 Service Delivery NOFO, section 5 (Performance Measures)" },
  bja: { label: "BJA Second Chance Act (federal), semiannual narrative", sections: ["accomplish", "goals", "barriers", "assist", "ontrack", "plan", "innov"],
    source: "BJA Second Chance Act Innovative Reentry Initiatives performance measures, revised Dec 2021" },
};
const GR_TITLES = {
  summary: "Summary of the quarter", services: "Services delivered (outputs)", referrals: "Referrals and outcomes",
  challenges: "Challenges and barriers", next: "Plan for next quarter",
  accomplish: "1. What were your accomplishments during the reporting period?",
  goals: "2. What goals were accomplished, as they relate to your grant application?",
  barriers: "3. What problems or barriers did you encounter that prevented you from reaching your goals or milestones?",
  assist: "4. Is there any assistance that BJA can provide to address those barriers? (Yes/No, explain)",
  ontrack: "5. Are you on track to complete your program fiscally and programmatically as outlined in your application? (Yes/No)",
  plan: "6. What major activities are planned for the next 6 months?",
  innov: "7. Are there any innovative programs or accomplishments you would like to share with BJA?",
};
const GR_ASK = "[Denise to answer";
const GR = { period: "q4", funder: "icjia", text: null, key: "", checked: false, saved: null };

const grIn = (d, p) => d >= p.from && d <= p.to;
const grPct = (a, b) => b ? Math.round(a / b * 100) : null;
const grPctText = (a, b) => b ? `${grPct(a, b)}% (${a} of ${b})` : "not yet measurable";
const grList = a => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
const grHours = m => (Math.round(m / 6) / 10).toString();

/* ---------- Numbers: everything below is counted from the records, nothing is typed in ---------- */
function grStats(pKey) {
  const p = GR_PERIODS[pKey];
  const its = Store.where("Interaction", x => grIn(x.Date, p));
  const withMin = its.filter(x => x.Minutes > 0);
  const meetings = [...new Set(its.map(x => x.MeetingType).filter(Boolean))];
  const served = new Set(its.map(x => x.ClientId));
  const intakes = Store.where("Client", c => grIn(c.ClientSince, p));
  const byType = {};
  Store.where("Service", s => grIn(s.Date, p)).forEach(s => {
    const t = byType[s.ServiceType] || (byType[s.ServiceType] = { minutes: 0, clients: new Set() });
    t.minutes += s.Minutes; t.clients.add(s.ClientId);
  });
  const refs = Store.where("Referral", r => grIn(r.SentDate || "", p));
  const accepted = refs.filter(r => r.Status === "Accepted" || ["Accepted", "Attended", "No-show", "Closed"].includes(r.Stage));
  const declined = refs.filter(r => r.Status === "Declined");
  const attended = refs.filter(r => ["Attended", "Closed"].includes(r.Stage) || r.Attendance === "Showed up" || r.AttendedDate);
  const noShow = refs.filter(r => r.Stage === "No-show" || r.Attendance === "No-show");
  const closed = refs.filter(r => r.Outcome);
  const met = closed.filter(r => r.Outcome === "Goal met");
  const why = {};
  declined.forEach(r => { const k = r.DeclineReason || "Other"; why[k] = (why[k] || 0) + 1; });
  const openNeeds = Store.where("Need", n => n.Status === "Open");
  const needTypes = {};
  openNeeds.forEach(n => { const k = n.ServiceType || "Other"; needTypes[k] = (needTypes[k] || 0) + 1; });
  const answered = accepted.length + declined.length;
  /* Who was served, for R3's gender and age tables, and the BJA cumulative figures (since the first record, up to the period end). */
  const cl = id => Store.get("Client", id);
  const ageBins = [["18-25", 18, 25], ["26-35", 26, 35], ["36-45", 36, 45], ["46-55", 46, 55], ["56-64", 56, 64], ["65 and up", 65, 200]];
  const byAge = {}, byGender = {};
  [...served].forEach(id => { const c = cl(id); if (!c) return;
    const g = c.Gender || "Unknown"; byGender[g] = (byGender[g] || 0) + 1;
    const b = ageBins.find(x => c.Age >= x[1] && c.Age <= x[2]); const k = b ? b[0] : "Unknown"; byAge[k] = (byAge[k] || 0) + 1; });
  const upTo = Store.where("Interaction", x => x.Date <= p.to);
  const cumIds = new Set(upTo.map(x => x.ClientId));
  const cut = iso(new Date(parseDate(p.to).getTime() - 30 * 864e5));
  const engaged = [...cumIds].filter(id => upTo.some(x => x.ClientId === id && x.Date >= cut)).length;
  const svcClients = {};
  Store.where("Service", x => x.Date <= p.to).forEach(x => { (svcClients[x.ServiceType] = svcClients[x.ServiceType] || new Set()).add(x.ClientId); });
  return {
    byAge, byGender, cum: cumIds.size, engaged, svcClients,
    p, meetings, served: served.size, intakes: intakes.length, contacts: its.length, minutes: withMin.reduce((a, x) => a + x.Minutes, 0),
    byType, refs: refs.length, accepted: accepted.length, declined: declined.length, answered, attended: attended.length,
    noShow: noShow.length, closed: closed.length, met: met.length, why, needTypes, openNeeds: openNeeds.length,
    pendingAnswer: refs.length - answered, pendingShow: accepted.length - attended.length - noShow.length,
    noOutcome: attended.length - closed.length,
  };
}

/* ---------- Draft: plain templates filled from the numbers ---------- */
function grDraft(s, funder) {
  const when = `${fmt(parseDate(s.p.from))} to ${fmt(parseDate(s.p.to))}, 2026`;
  const types = Object.entries(s.byType).sort((a, b) => b[1].minutes - a[1].minutes);
  const T = {};
  T.summary = `From ${when}, ReintegrAIt case managers served ${s.served} client${s.served === 1 ? "" : "s"}, including ${s.intakes} new intake${s.intakes === 1 ? "" : "s"}. Staff logged ${s.contacts} contact${s.contacts === 1 ? "" : "s"} totaling ${grHours(s.minutes)} hours of direct service. Every figure in this report is counted from the client case files.`;
  T.services = types.length
    ? `Services covered ${grList(types.map(([t]) => t))}. ${types.slice(0, 3).map(([t, v]) => `${t}: ${v.clients.size} client${v.clients.size === 1 ? "" : "s"}, ${v.minutes} minutes`).join("; ")}. ${s.meetings.length ? `Contact types: ${grList(s.meetings.map(m => m.toLowerCase()))}. Minutes were logged for each.` : ""}`
    : "No service minutes were logged in this period.";
  T.referrals = s.refs
    ? `${s.refs} referral${s.refs === 1 ? " was" : "s were"} sent to partner organizations. ${s.answered ? `Partners answered ${s.answered}, and accepted ${grPctText(s.accepted, s.answered)}.` : "No partner has answered yet."} ${s.accepted ? `Of the accepted referrals, clients attended ${grPctText(s.attended, s.accepted)}${s.noShow ? `; ${s.noShow} did not show up` : ""}.` : ""} ${s.closed ? `${s.met} of ${s.closed} closed referral${s.closed === 1 ? "" : "s"} met the client's goal.` : "No referral has been closed with an outcome yet."}`.replace(/\s+/g, " ").trim()
    : "No referrals were sent in this period.";
  const whyTxt = Object.entries(s.why).map(([k, n]) => `${k.toLowerCase()} (${n})`);
  const open = Object.entries(s.needTypes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k.toLowerCase()} (${n})`);
  T.challenges = `${whyTxt.length ? `Partners declined ${s.declined} referral${s.declined === 1 ? "" : "s"}: ${grList(whyTxt)}. ` : ""}${open.length ? `Open needs on caseloads today: ${grList(open)}. ` : ""}${s.pendingAnswer ? `${s.pendingAnswer} referral${s.pendingAnswer === 1 ? " is" : "s are"} still waiting for a partner answer.` : ""}`.trim() || "No barriers were recorded in this period.";
  const fu = s.pendingAnswer + Math.max(0, s.pendingShow);
  T.next = `${fu ? `Follow up on ${fu} referral${fu === 1 ? "" : "s"} that ${fu === 1 ? "has" : "have"} no final answer or attendance, record outcomes for closed referrals, and work through` : "Record outcomes for closed referrals and work through"} the ${s.openNeeds} open need${s.openNeeds === 1 ? "" : "s"} across caseloads.`;
  const ask = t => `${GR_ASK}: ${t}]`;
  T.accomplish = `${T.summary} ${T.referrals}`;
  T.goals = ask("list the goals from the grant application that were met this period. ReintegrAIt does not hold your application goals.");
  T.barriers = T.challenges;
  T.assist = ask("Yes or No. If Yes, say what help BJA can give.");
  T.ontrack = ask("Yes or No. If No, explain. This depends on your budget and spending, which ReintegrAIt does not see.");
  T.plan = T.next.replace("next period", "the next six months");
  T.innov = ask("add anything you want to share with BJA, or write N/A.");
  return GR_FUNDERS[funder].sections.map(k => ({ key: k, title: GR_TITLES[k], text: T[k] }));
}

/* The funder's own quarterly numbers. "Not tracked" means ReintegrAIt has no field for it yet, so Denise enters it by hand. */
function grMetrics(s, funder) {
  const nt = "Not tracked";
  const order = (o, keys) => keys.map(k => `${k}: ${o[k] || 0}`).join(", ");
  if (funder === "icjia") return [
    ["Total clients served this quarter (may include duplicates)", s.contacts + " contacts", "Counted as one per logged contact"],
    ["Unique clients served this quarter", s.served, ""],
    ["Clients by gender", order(s.byGender, Object.keys(s.byGender)) || "0", ""],
    ["Clients by age group", order(s.byAge, ["18-25", "26-35", "36-45", "46-55", "56-64", "65 and up", "Unknown"]), "R3 age groups"],
    ["Clients by race/ethnicity", nt + ` (all ${s.served} Unknown)`, "R3 requires it. Add a race/ethnicity field to the intake note"],
    ["Types of outreach conducted", nt, "Phone, in-person, text and others. Meeting type is logged per contact"],
    ["R3-funded staff (start, end, hired, left)", nt, "Staffing is not part of the case file"],
    ["Your priority-area metric: referrals sent", s.refs, "Reentry metrics come from your AmpliFund performance plan. Match these to the ones you chose"],
    ["Your priority-area metric: referrals accepted and attended", `${s.accepted} accepted, ${s.attended} attended`, ""],
  ];
  const sc = k => (s.svcClients[k] ? s.svcClients[k].size : 0);
  const other = new Set();
  ["ID and documents", "Benefits", "Family", "Legal", "Transport", "Health"].forEach(k => (s.svcClients[k] || []).forEach(id => other.add(id)));
  return [
    ["Participants served since the start (cumulative), measure 8", s.cum, "Includes people served directly and through referrals"],
    ["Still engaged at the end of the period, measure 9A", s.engaged, "Counted as a contact in the last 30 days. BJA lets each program define engagement"],
    ["No longer engaged, measure 9B", s.cum - s.engaged, ""],
    ["Completed all program requirements, measure 10A", nt, "Needs a completion field per client"],
    ["Received employment services, measure 27", sc("Jobs"), "Service type Jobs"],
    ["Received housing services, measure 28", sc("Housing"), "Service type Housing"],
    ["Received education services, measure 26", nt, "No education service type yet"],
    ["Received other services, measure 29", other.size, "ID and documents, Benefits, Family, Legal, Transport, Health"],
    ["Obtained permanent or stable housing (6+ months), measure 31", nt, "Needs a housing outcome with a date"],
    ["Obtained employment, and kept it 6+ months, measures 35 and 36", nt, "Needs an employment outcome with dates"],
    ["Court and criminal involvement, measures 46 to 58 (closeout only)", "Not collected", "ReintegrAIt does not hold arrest or conviction data"],
  ];
}

const grCan = () => GR.checked && !GR.saved && !grOpen();
const grOpen = () => (GR.text || []).filter(x => x.text.includes(GR_ASK)).length;

/* Things the case manager must settle before approving. Each one comes from a gap in the records. */
function grFlags(s) {
  const f = [];
  const o = grOpen();
  if (o) f.push(`${o} ${o === 1 ? "question needs" : "questions need"} your own answer before this can be approved (marked in brackets below).`);
  if (!s.contacts) f.push("No contacts were logged in this period, so the report would be empty. Pick a longer period.");
  if (s.pendingAnswer) f.push(`${s.pendingAnswer} referral${s.pendingAnswer === 1 ? " has" : "s have"} no partner answer yet, so the acceptance rate leaves ${s.pendingAnswer === 1 ? "it" : "them"} out.`);
  if (s.noOutcome > 0) f.push(`${s.noOutcome} attended referral${s.noOutcome === 1 ? " has" : "s have"} no outcome recorded (goal met, partly met, not met), so ${s.noOutcome === 1 ? "it" : "they"} can't count toward goals met.`);
  if (s.accepted && !s.answered) f.push("Acceptance is counted from referral status. Check it against the partner's reply.");
  return f;
}

function grText(sections) {
  return sections.map(x => `${x.title.toUpperCase()}\n${x.text}`).join("\n\n");
}

/* ---------- Screen ---------- */
function renderGrant() {
  const s = grStats(GR.period);
  const key = GR.period + "|" + GR.funder;
  if (GR.key !== key || !GR.text) { GR.key = key; GR.text = grDraft(s, GR.funder); GR.checked = false; GR.saved = null; }
  const flags = grFlags(s);
  const cell = (n, l, sub) => `<div class="gr-stat"><b>${n}</b><span>${l}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const rate = (a, b) => b ? grPct(a, b) + "%" : "n/a";
  const types = Object.entries(s.byType).sort((a, b) => b[1].minutes - a[1].minutes);
  app.innerHTML = mockbar() + `
  <div class="gr-head"><h1>Grant report</h1>
   <p class="muted">Counted from your case files. The AI drafts the wording, you check it and approve it.</p></div>
  <div class="pane gr-ctl"><label class="field"><span>Reporting period</span><select id="gr-period">${Object.entries(GR_PERIODS).map(([k, v]) => `<option value="${k}" ${k === GR.period ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
   <label class="field"><span>Funder layout</span><select id="gr-funder">${Object.entries(GR_FUNDERS).map(([k, v]) => `<option value="${k}" ${k === GR.funder ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
   <span class="tag sim" title="A sample layout, not the funder's official form">Sample layout</span></div>
  <div class="gr-stats" id="gr-stats">
   ${cell(s.served, "Clients served", `${s.intakes} new`)}${cell(s.contacts, "Contacts", `${grHours(s.minutes)} hours`)}
   ${cell(s.refs, "Referrals sent")}${cell(rate(s.accepted, s.answered), "Accepted", s.answered ? `${s.accepted} of ${s.answered} answered` : "no answers yet")}
   ${cell(rate(s.attended, s.accepted), "Showed up", s.accepted ? `${s.attended} of ${s.accepted} accepted` : "")}${cell(rate(s.met, s.closed), "Goal met", s.closed ? `${s.met} of ${s.closed} closed` : "none closed")}
  </div>
  <div class="pane" style="margin-top:12px"><h2>${esc(GR_FUNDERS[GR.funder].label.split(",")[0])} figures</h2>
   <p class="small muted" style="margin-bottom:8px">Taken from: ${esc(GR_FUNDERS[GR.funder].source)}. Rows marked Not tracked are not in the case file yet, so you enter them in the funder's system by hand.</p>
   <div class="tablewrap"><table id="gr-metrics"><thead><tr><th>Measure</th><th>This report</th><th>Note</th></tr></thead><tbody>${grMetrics(s, GR.funder).map(([m, v, n]) => `<tr><td>${esc(m)}</td><td class="${/^Not/.test(String(v)) ? "gr-nt" : ""}">${esc(v)}</td><td class="muted small">${esc(n)}</td></tr>`).join("")}</tbody></table></div></div>
  ${types.length ? `<div class="pane" style="margin-top:12px"><h2>Dosage by service type</h2><div class="tablewrap"><table><thead><tr><th>Service type</th><th>Clients</th><th>Minutes</th></tr></thead><tbody>${types.map(([t, v]) => `<tr><td>${esc(t)}</td><td>${v.clients.size}</td><td>${v.minutes}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
  <div class="pane" style="margin-top:12px"><h2>Draft report <span class="tag sim">AI drafted · simulated</span></h2>
   ${flags.length ? `<div class="gr-flags" role="note"><b>Check before you approve</b><ul>${flags.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
   ${GR.text.map((x, i) => `<label class="field gr-sec"><span>${esc(x.title)}</span><textarea data-sec="${i}" rows="4">${esc(x.text)}</textarea></label>`).join("")}
   <p class="small muted">No client names appear in this report. Edit any section; your edits are what get saved.</p>
   <label class="gr-check"><input type="checkbox" id="gr-ok" ${GR.checked ? "checked" : ""}> I checked these numbers and this wording against the case files.</label>
   <div class="btns" style="margin-top:10px"><button class="btn primary" id="gr-save" type="button" ${grCan() ? "" : "disabled"}>Approve and save report</button>
    <button class="btn" id="gr-copy" type="button">Copy text</button><button class="btn" id="gr-dl" type="button">Download .txt</button><button class="btn ghost" id="gr-redraft" type="button">Redraft from the numbers</button></div>
   ${GR.saved ? `<p class="small" id="gr-saved" style="margin-top:8px"><span class="tag ok">Approved</span> by Denise at ${esc(GR.saved)}. Saved to the activity log.</p>` : ""}
  </div>`;
  document.getElementById("gr-period").onchange = e => { GR.period = e.target.value; GR.text = null; render(); };
  document.getElementById("gr-funder").onchange = e => { GR.funder = e.target.value; GR.text = null; render(); };
  app.querySelectorAll("[data-sec]").forEach(t => t.oninput = () => { GR.text[+t.dataset.sec].text = t.value; document.getElementById("gr-save").disabled = !grCan(); if (GR.saved) { GR.saved = null; GR.checked = false; document.getElementById("gr-ok").checked = false; const m = document.getElementById("gr-saved"); if (m) m.remove(); } });
  document.getElementById("gr-ok").onchange = e => { GR.checked = e.target.checked; document.getElementById("gr-save").disabled = !grCan(); };
  document.getElementById("gr-save").onclick = () => {
    GR.saved = clock().slice(0, 5);
    const rec = Store.insert("Approval", { RecordType: "GrantReport", RecordId: key, ApprovedBy: "Denise", ApprovedAt: new Date().toISOString(), Statement: `Checked the ${GR_FUNDERS[GR.funder].label} report for ${GR_PERIODS[GR.period].label} against the case files.` });
    Store.save();
    logEvent("", "Grant report approved", `${GR_FUNDERS[GR.funder].label} · ${GR_PERIODS[GR.period].label} · ${s.served} clients, ${s.refs} referrals`);
    toast("Report approved and saved."); renderGrant();
  };
  document.getElementById("gr-copy").onclick = () => { const t = grText(GR.text); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("Copied."), () => toast("Copy blocked by the browser. Use Download instead.")); };
  document.getElementById("gr-dl").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`${GR_FUNDERS[GR.funder].label}\nReporting period: ${GR_PERIODS[GR.period].label}\n\n${grText(GR.text)}\n`], { type: "text/plain" }));
    a.download = `grant-report-${GR.funder}-${GR.period}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  document.getElementById("gr-redraft").onclick = () => { GR.text = null; GR.saved = null; render(); toast("Redrafted from the current numbers."); };
}
