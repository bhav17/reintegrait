// Acceptance test for the live Grant report (backend/grant_report.py, backend/report_draft.py).
// 1. In this folder: python3 backend/server.py   (the helper, not http.server: the shared case file lives there)
// 2. In another terminal: node acceptance-test-grant-live.js   (needs Playwright)
// Set AI_DRAFT=1 to also click "Draft wording with AI" (needs ANTHROPIC_API_KEY, mode "real", report.enabled).
// It adds a test client to the shared case file. Delete backend/data/case-file.db afterwards to start clean.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = process.env.PROTO_URL || 'http://localhost:8000/';
const SHOTS = __dirname + '/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, pass) => results.push((pass ? 'PASS  ' : 'FAIL  ') + name);
const stat = (p, label) => p.evaluate(l => [...document.querySelectorAll('.gr-stat')].find(x => x.querySelector('span').textContent === l).querySelector('b').textContent, label);

async function openGrant(p) {
  await p.goto(URL); await p.waitForSelector('#btn-new');
  await p.click('#nav-grant');
  await p.waitForFunction(() => /shared case file/.test(document.getElementById('gr-source')?.textContent || '') && !/Reading/.test(document.getElementById('gr-source').textContent), null, { timeout: 10000 });
}

(async () => {
  const browser = await chromium.launch();
  // Laptop A: Denise, with the five sample clients.
  const a = await (await browser.newContext()).newPage();
  await a.goto(URL); await a.evaluate(() => localStorage.clear());
  await openGrant(a);
  const src = await a.textContent('#gr-source');
  check('Report says it is counted from the shared case file', /shared case file/.test(src));
  const before = Number(await stat(a, 'Clients served'));
  check('Sample clients are counted (5 or more served this quarter)', before >= 5);
  check('Completeness line shows race/ethnicity coverage', /Race\/ethnicity \d+ of \d+/.test(await a.textContent('#gr-complete')));
  check('R3 flags missing race/ethnicity', /Race\/ethnicity is recorded for/.test(await a.textContent('.gr-flags')));
  await a.screenshot({ path: `${SHOTS}/grant-live-1-shared.png`, fullPage: true });

  // Laptop B: a second case manager adds a client this quarter.
  const b = await (await browser.newContext()).newPage();
  await b.goto(URL); await b.waitForSelector('#btn-new');
  await b.evaluate(() => {
    const c = Store.insert('Client', { Name: 'Live Test', Age: 30, Gender: 'Female', ClientSince: '2026-11-02', Status: 'New intake' });
    Store.insert('Interaction', { ClientId: c.Id, Date: '2026-11-02', Type: 'Intake note', MeetingType: 'In-person visit', Minutes: 30 });
    Store.save();
  });
  await b.waitForTimeout(1800);  // saves reach the helper a second after the last change

  // Back on laptop A: the report now counts laptop B's client too.
  await a.click('#nav-home'); await openGrant(a);
  const after = Number(await stat(a, 'Clients served'));
  check(`Another browser's new client is counted (${before} -> ${after})`, after === before + 1);
  check('Two browsers are listed as sources', /2 browsers/.test(await a.textContent('#gr-source')));
  const text = await a.evaluate(() => GR.text.map(x => x.text).join(' '));
  check('Template draft uses the shared numbers', text.includes(`served ${after} client`));

  if (process.env.AI_DRAFT) {
    await a.click('#gr-ai');
    await a.waitForFunction(() => !document.querySelector('#gr-ai')?.disabled, null, { timeout: 120000 });
    const tag = await a.textContent('#app h2 .tag');
    check('AI draft passed the checks and is labelled', /AI drafted/.test(tag));
    const t2 = await a.evaluate(() => GR.text.map(x => x.text).join(' '));
    check('No client name in the AI draft', !/Marcus|Tanya|Luis|Keisha|James|Reed|Brooks|Herrera|Moore|Carter/.test(t2));
    check('No unfilled placeholder in the AI draft', !/\{[a-z_]+\}/.test(t2));
    await a.screenshot({ path: `${SHOTS}/grant-live-2-ai.png`, fullPage: true });
  }

  await a.check('#gr-ok'); await a.click('#gr-save');
  const snap = await a.evaluate(() => Store.all('Approval').filter(x => x.RecordType === 'GrantReport').at(-1).Snapshot);
  check('Approval keeps a snapshot of the figures and their source', snap && snap.source === 'shared case file' && snap.figures.served === after);
  await a.screenshot({ path: `${SHOTS}/grant-live-3-approved.png`, fullPage: true });

  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${results.filter(r => r.startsWith('PASS')).length} of ${results.length} passed`);
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})();
