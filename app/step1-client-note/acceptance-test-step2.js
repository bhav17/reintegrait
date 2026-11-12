// Acceptance test for Step 2: Matched services (prototype/step2-matched-services/SPEC.md).
// 1. In this folder: python3 -m http.server 8000
// 2. In another terminal: node acceptance-test-step2.js   (needs Playwright: npm i -D playwright && npx playwright install chromium)
// Screenshots are saved to ./screenshots (step2-*.png).
const { chromium } = require('playwright');
const fs = require('fs');
const URL = process.env.PROTO_URL || 'http://localhost:8000/';
const SHOTS = __dirname + '/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, pass) => results.push((pass ? 'PASS  ' : 'FAIL  ') + name);
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const text = (p, sel) => p.textContent(sel);
const logText = async p => { await p.evaluate(() => { const d = document.getElementById('ms-log'); if (d) d.open = true; }); return p.textContent('#ms-log'); };

// Step 1 happy path: add Andre from the sample recording and approve his note.
async function approveAndre(p) {
  await p.goto(URL); await p.waitForSelector('#btn-new');
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('#btn-new');
  await p.click('#btn-new'); await p.click('#sample');
  await p.waitForSelector('#mgo:not([disabled])', { timeout: 5000 }); await p.click('#mgo');
  await p.waitForSelector('#seenote:not([hidden])', { timeout: 10000 }); await p.click('#seenote');
  await p.selectOption('#fx-f1', 'Male'); await p.click('[data-fix="f1"]');
  await p.fill('#fx-f2', '773-555-0186'); await p.click('[data-fix="f2"]');
  await p.check('#rv1'); await p.click('#btn-save');
  await p.waitForSelector('#ms-board');
}
const bucket = cat => `.ms-bucket:has(.ms-bopen b:text-is("${cat}"))`;
const openBucket = (p, cat) => p.click(`${bucket(cat)} .ms-bopen`);
const card = name => `.ms-card:has(h3:text-is("${name}"))`;

(async () => {
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; p.on('pageerror', e => errors.push(e.message));

  // 1. Needs board
  await approveAndre(p);
  const cats = await p.$$eval('.ms-bucket .ms-bopen b', bs => bs.map(b => b.textContent));
  check('1. Approving Andre\'s note opens his case file on the "Matched services" tab',
    (await text(p, '#ms-name')) === 'Andre Williams' && (await p.getAttribute('#tab-services', 'aria-selected')) === 'true');
  check('1. Board shows 5 needs bucketed from the note, by priority: Medication, Housing, ID, Food, Work',
    cats.join() === 'Medication,Housing,ID,Food,Work');
  check('1. Each bucket shows its need in one line, a link to the note line, and how many services were found',
    (await p.$$eval('.ms-bucket', ls => ls.every(l => l.querySelector('.line').textContent && l.querySelector('[data-ms="quote"]') && /matching service/.test(l.textContent)))));
  check('1. Header says how many needs are still open', (await text(p, '#ms-count')).includes('5 of 5'));
  await p.click(`${bucket('Housing')} [data-ms="quote"]`);
  check('1. The note link shows the line the need came from', (await text(p, '.ms-quote')).includes('00:02:40') && (await text(p, '.ms-quote')).includes('cousin'));
  await shot(p, 'step2-1-board');

  // Reorder, add a missed need, mark one handled
  await p.click(`${bucket('Housing')} [data-ms="up"]`);
  check('1. Priorities can be reordered', (await p.$$eval('.ms-bucket .ms-bopen b', bs => bs.map(b => b.textContent)))[0] === 'Housing');
  await p.selectOption('#ms-newcat', 'Transportation'); await p.fill('#ms-newtext', 'Needs a bus pass for appointments'); await p.click('#ms-addneed-btn');
  check('1. An added need gets its own bucket and services are matched to it right away',
    (await p.isVisible(bucket('Transportation'))) && (await p.$$('#ms-cards .ms-card')).length > 0 && (await text(p, '#ms-count')).includes('6 of 6'));
  await p.click(`${bucket('Transportation')} [data-ms="handled"]`);
  const last = await p.$$eval('.ms-bucket .ms-bopen b', bs => bs.map(b => b.textContent));
  check('1. A need marked "Handled in-house / not needed" turns grey and drops to the bottom',
    last[last.length - 1] === 'Transportation' && (await p.getAttribute(bucket('Transportation'), 'class')).includes('st-handled') && (await text(p, '#ms-count')).includes('5 of 6'));

  // 2. Matched services for Housing
  await openBucket(p, 'Housing');
  const names = await p.$$eval('#ms-cards .ms-card h3', hs => hs.map(h => h.textContent));
  check('2. Opening a need shows up to 3 ranked service cards', names.length === 3 && names[0] === 'Teamwork Englewood CRSC');
  check('2. Ranking matches the spec example: Teamwork, Southside, in-house workshop',
    names.join('|') === "Teamwork Englewood CRSC|Southside Men's Transitional House|In-house housing workshop");
  const cardsOk = await p.$$eval('#ms-cards .ms-card', cs => cs.every(c => {
    const t = c.textContent, ext = /External/.test(c.querySelector('header').textContent);
    return /Internal|External/.test(c.querySelector('header').textContent) && /Availability/.test(t) && /Updated/.test(t) && /Eligibility check/.test(t)
      && c.querySelectorAll('.ms-checks li').length > 0 && (!ext || /Credibility/.test(t)) && /Why it's suggested/.test(t) && /Listing:/.test(t);
  }));
  check('2. Each card has Internal/External, availability with update date, eligibility check, credibility (External), why, and source', cardsOk);
  const tw = await text(p, card('Teamwork Englewood CRSC'));
  check('2. Teamwork card: ✓ rule with its source, 3 openings updated Nov 10, "Accepted 9 of 11"',
    tw.includes('✓') && tw.includes('City of Chicago reentry page') && tw.includes('slots this week: 3') && tw.includes('Nov 10') && tw.includes('Accepted 9 of 11 referrals'));
  const ss = await text(p, card("Southside Men's Transitional House"));
  check('2. Southside card keeps its ✗ for state ID (a document Andre is getting) and flags stale openings',
    ss.includes('✗') && ss.includes('Needs state ID') && ss.includes('is getting it') && ss.includes('may be stale'));
  check('2. Real public listings are marked separately from simulated ones',
    tw.includes('Real listing') && ss.includes('Simulated listing'));
  const nm = await text(p, '#ms-notmatch summary');
  await p.click('#ms-notmatch summary');
  const nmText = await text(p, '#ms-notmatch');
  check('2. Services failing a rule sit under "Not a match (2)" with the reason', nm.includes('(2)') && nmText.includes("Women's Reentry Residence") && nmText.includes('Women only'));
  check('2. Statuses use icon and text, not color alone', (await p.$$eval('.ms-checks li', ls => ls.every(l => /[✓✗?]/.test(l.querySelector('i').textContent) && l.textContent.length > 3))));
  await shot(p, 'step2-2-cards');

  // Override a rule
  await p.click(`#ms-notmatch [data-ms="override"][data-svc="hou-women"]`);
  check('2. "Refer anyway" needs a short note', await p.isDisabled('#ms-ovgo'));
  await p.fill('#ms-ovnote', 'Testing the override'); await p.click('[data-ms="override-cancel"]');

  // Search and add a service by hand
  await p.click('#ms-search summary'); await p.fill('#ms-q', 'Ebenezer Church shelter');
  await p.fill('#ms-svcname', 'Ebenezer Church shelter'); await p.fill('#ms-svcphone', '773-555-0111'); await p.click('#ms-addsvc-btn');
  check('2. A hand-added service is tagged "Added by Denise"', (await text(p, card('Ebenezer Church shelter'))).includes('Added by Denise'));

  // Turn one down
  await p.click(`${card("Southside Men's Transitional House")} [data-ms="decline"]`);
  const reasons = await p.$$eval('.ms-reasons button[data-reason]', bs => bs.map(b => b.textContent));
  check('2. "Not this one" asks for a one-tap reason', reasons.join() === 'Full,Not eligible,Too far,Poor past experience,Client declined,Other');
  await p.click('.ms-reasons button[data-reason="Not eligible"]');
  const after = await p.$$eval('#ms-cards .ms-card:not(:has(.tag.warn)) h3', hs => hs.map(h => h.textContent));
  check('2. A turned-down card collapses with its reason, and the next-ranked service moves up',
    !after.includes("Southside Men's Transitional House") && after.includes('211 Metro Chicago') && (await text(p, '#ms-turned')).includes('Not eligible'));

  // 3. Referral request
  await p.click(`${card('Teamwork Englewood CRSC')} [data-ms="refer"]`);
  const draft = await p.inputValue('#ms-draft');
  check('3. Refer opens a draft with first name, need, facts from the note, requested timing and Denise\'s contact',
    draft.includes('Andre (34)') && draft.includes('housing') && draft.includes('IDOC') && draft.includes('2 to 3 weeks') && draft.includes('773-555-0100'));
  check('3. Consent box names the provider', (await text(p, '#ms-refer')).includes('Andre agreed to share this information with Teamwork Englewood CRSC'));
  check('3. Send stays disabled until consent is ticked', await p.isDisabled('#ms-send'));
  await p.check('input[name="ms-method"][value="call"]');
  const cb = await text(p, '#ms-callbox');
  check('3. Choosing Call shows the phone number and a short call script', cb.includes('(773) 488-6600') && cb.includes('Script'));
  await p.check('input[name="ms-method"][value="message"]');
  await p.fill('#ms-draft', draft + ' Thanks!');
  await p.check('#ms-consent');
  check('3. Ticking consent enables Send message', !(await p.isDisabled('#ms-send')) && (await text(p, '#ms-send')) === 'Send message');
  await shot(p, 'step2-3-referral');
  await p.click('#ms-send');
  check('3. Sending files the referral as "Request sent, awaiting answer" and the bucket shows "Pending: provider"',
    (await text(p, '#ms-pending')).includes('awaiting answer') && (await text(p, bucket('Housing'))).includes('Pending: Teamwork Englewood CRSC'));

  // 4. Provider says Yes
  await p.click('#ms-simyes');
  check('4. "Simulate provider reply" shows the provider\'s reply and fills in the answer', (await text(p, '#ms-reply')).includes('Thu Nov 19') && (await p.inputValue('#ms-adate')) === '2026-11-19');
  await p.click('#ms-anssave');
  const ctext = await p.inputValue('#ms-ctext');
  check('4. Yes drafts a text to Andre with the appointment, address and what to bring',
    ctext.includes('Hi Andre') && ctext.includes('815 W. 63rd St.') && ctext.includes('Thu Nov 19 at 10:00') && ctext.includes('release papers'));
  check('4. The text is not sent until Denise approves it (phone-style preview)', (await text(p, '.ms-phone')).includes('Not sent yet'));
  check('4. The bucket turns green: "Referred, appt Thu Nov 19, 10:00"',
    (await text(p, bucket('Housing'))).includes('Referred, appt Thu Nov 19, 10:00') && (await p.getAttribute(bucket('Housing'), 'class')).includes('st-done'));
  await p.fill('#ms-ctext', ctext + ' See you soon.');
  await p.click('#ms-ctext-send');
  const rems = await text(p, '#ms-rems');
  check('4. After approval, two reminders are scheduled in the case file (Andre the day before, attendance check the day after)',
    (await p.$$('#ms-rems li')).length === 2 && rems.includes('Nov 18') && rems.includes('Nov 20') && rems.includes('Attendance check'));
  await p.click('.ms-stars [data-v="5"]');
  check('4. Denise can rate the provider 1 to 5 after it replies', (await text(p, '.ms-stars')).includes('You rated 5/5'));
  await shot(p, 'step2-4-accepted');

  // 4. Provider says No on Medication
  await openBucket(p, 'Medication');
  const top = await text(p, '#ms-cards .ms-card h3');
  await p.click(`${card(top)} [data-ms="refer"]`); await p.check('#ms-consent'); await p.click('#ms-send');
  await p.click('#ms-simno'); await p.click('#ms-anssave');
  const medCards = await p.$$eval('#ms-cards .ms-card h3', hs => hs.map(h => h.textContent));
  check('4. No: the reason is recorded and the need goes back to matched services with the next service on top',
    medCards[0] !== top && (await text(p, '#ms-turned')).includes('Provider said no: Full') && (await text(p, bucket('Medication'))).includes('matching service'));
  // Provider reply feeds credibility and availability shown on later cards (Teamwork also serves ID).
  await openBucket(p, 'ID');
  check('4. A provider\'s answer updates its credibility on later cards', (await text(p, card('Teamwork Englewood CRSC'))).includes('Accepted 10 of 12 referrals'));

  // Activity log
  const log = await logText(p);
  const want = ['Needs board opened', 'Priority reordered', 'Need added', 'Need marked handled', 'Note line opened', 'Service added', 'Turned down',
    'reason: Not eligible', 'Refer chosen', 'rank #1', 'Consent ticked', 'Contact method chosen', 'Referral sent', 'draft edited', 'First request sent',
    'Provider reply simulated', 'Provider answer', 'Yes, accepted', 'No · reason: Full', 'Client text approved', 'Reminder scheduled', 'Provider rated'];
  const missing = want.filter(w => !log.includes(w));
  check('5. Every action above appears in the on-screen activity log' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''), missing.length === 0);
  await shot(p, 'step2-5-log');

  // Case file
  await p.click('#tab-casefile');
  const cf = await text(p, '#timeline');
  check('5. The case file shows the referral sent, accepted, declined and the text to Andre',
    cf.includes('Referral sent') && cf.includes('Referral accepted') && cf.includes('Referral declined') && cf.includes('Text to client'));

  // Data stays in the JSON: change Teamwork's openings and see the card change
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await p2.route('**/simulated_responses.json', async r => {
    const j = await (await r.fetch()).json();
    j.matched_services.needs.Housing.candidates[0].availability.text = 'Edited in JSON: 9 slots';
    await r.fulfill({ json: j });
  });
  await approveAndre(p2); await openBucket(p2, 'Housing');
  check('6. Matches come from simulated_responses.json', (await text(p2, card('Teamwork Englewood CRSC'))).includes('Edited in JSON: 9 slots'));

  // Phone width
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await approveAndre(m); await openBucket(m, 'Housing');
  check('7. Works at phone width with no sideways scroll', await m.evaluate(() => document.documentElement.scrollWidth) <= 390);
  await shot(m, 'step2-6-phone');
  // Keyboard: Tab reaches the Refer button
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) { await m.keyboard.press('Tab'); reached = await m.evaluate(() => document.activeElement && document.activeElement.dataset.ms === 'refer'); }
  check('7. Keyboard reachable (Tab gets to Refer)', reached);
  check('7. No script errors', errors.length === 0);

  console.log(results.join('\n'));
  if (errors.length) console.log(errors);
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})();
