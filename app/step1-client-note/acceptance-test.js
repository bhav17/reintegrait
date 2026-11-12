// Acceptance test for the Step 1 prototype.
// 1. In this folder: python3 -m http.server 8000
// 2. In another terminal: node acceptance-test.js   (needs Playwright: npm i -D playwright && npx playwright install chromium)
// Screenshots of each screen are saved to ./screenshots.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = process.env.PROTO_URL || 'http://localhost:8000/';
const SHOTS = __dirname + '/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });

// A 5-second silent WAV, made in memory, to test a real file upload.
function silentWav(seconds) {
  const rate = 8000, n = rate * seconds, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

const results = [];
const check = (name, pass) => results.push((pass ? 'PASS  ' : 'FAIL  ') + name);
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const waitForAI = async p => { await p.waitForSelector('#seenote:not([hidden])', { timeout: 10000 }); await p.click('#seenote'); };

(async () => {
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; p.on('pageerror', e => errors.push(e.message));

  // Home
  await p.goto(URL); await p.waitForSelector('#btn-new');
  check('1. Home says "Welcome back" and shows New client | Existing client',
    (await p.textContent('h1')).includes('Welcome back') && await p.isVisible('#btn-new') && await p.isVisible('#btn-existing'));
  check('1. Home lists reminders due for existing clients', (await p.$$('[data-open]')).length >= 3);
  await shot(p, '1-home');

  // New client pop-up
  await p.click('#btn-new');
  const modal = await p.textContent('.modal');
  check('2. New client opens a pop-up asking for a voice note, with size limits shown',
    modal.includes('voice note') && modal.includes('3 hours') && modal.includes('500 MB'));
  await p.setInputFiles('#file', { name: 'intake.wav', mimeType: 'audio/wav', buffer: silentWav(5) });
  await p.waitForSelector('#mgo:not([disabled])', { timeout: 5000 });
  check('2. A real audio file uploads and its length is read', (await p.textContent('#fdur')) === '0:05');
  await shot(p, '2-upload');

  // AI processing
  await p.click('#mgo');
  await p.waitForSelector('#seenote:not([hidden])', { timeout: 10000 });
  const stages = (await p.textContent('#stages')).toLowerCase();
  check('3. AI steps run: quality check, voice to text, errors/missing info, template match',
    ['quality', 'voice into text', 'missing', 'template'].every(s => stages.includes(s)));
  await shot(p, '3-processing');
  await p.click('#seenote');

  // Client note
  const labels = await p.$$eval('.keyinfo label', ls => ls.map(l => l.textContent));
  check('4. Note shows key info: age, gender, locality, contact',
    ['Age', 'Gender', 'Neighborhood', 'Contact'].every(k => labels.some(x => x.includes(k))));
  check('4. Note shows immediate needs and next steps',
    (await p.$$('#needs li')).length > 0 && (await p.$$('#steps li')).length > 0);
  await p.click('[data-src="t7"]');
  check('4. A note line jumps to its place in the transcript', await p.$eval('#t7', e => e.classList.contains('on')));
  await shot(p, '4-note');
  check('5. Saving is blocked until the review check is done', await p.isDisabled('#btn-save'));
  await p.click('#btn-edit');
  await p.fill('#k-locality', 'Englewood (W 63rd St)');
  await p.click('[data-add="next_steps"]'); await p.keyboard.type('Bring a winter coat voucher');
  await p.click('#btn-edit');
  check('5. The note can be edited',
    (await p.inputValue('#k-locality')).includes('63rd') && (await p.textContent('#steps')).includes('winter coat'));
  await p.selectOption('#fx-f1', 'Male'); await p.click('[data-fix="f1"]');
  await p.fill('#fx-f2', '773-555-0186'); await p.click('[data-fix="f2"]');
  await p.check('#rv1');
  check('5. Saving is allowed once flags are resolved and the review box is ticked', !(await p.isDisabled('#btn-save')));
  await p.click('#btn-save'); await p.waitForSelector('#detail-name');
  check('5. The approved note is saved to the new client\'s case file',
    (await p.textContent('#detail-name')) === 'Andre Williams' &&
    (await p.textContent('#timeline')).includes('winter coat') &&
    (await p.textContent('#detail')).includes('773-555-0186'));
  await shot(p, '5-saved');

  // Existing client
  await p.click('#nav-home'); await p.click('#btn-existing');
  check('6. Existing client opens the client database', (await p.$$('tbody tr')).length >= 5);
  await p.click('tr[data-id="c1"]'); await p.click('#btn-addinfo');
  check('6. Upload new information offers referral check, second visit, weekly phone/message check',
    (await p.$$eval('#utype option', o => o.map(x => x.textContent))).join() === 'Referral check,Second visit,Weekly phone check,Weekly message check');
  await p.click('#sample'); await p.waitForSelector('#mgo:not([disabled])'); await p.click('#mgo'); await waitForAI(p);
  await shot(p, '6-update');
  await p.check('#urv'); await p.click('#usave'); await p.waitForSelector('#timeline');
  const detail = await p.textContent('#detail');
  check('6. The update is added to the case file (status, new need, next reminder)',
    detail.includes('accepted') && detail.includes('Enrolled') && detail.includes('Steel-toe') && detail.includes('Nov 18'));
  await shot(p, '7-case-file-updated');
  await p.click('tr[data-id="c4"]'); await p.click('#btn-log'); await p.click('#sample');
  await p.click('#mgo'); await waitForAI(p); await p.check('#urv'); await p.click('#usave');
  check('6. A typed update (text instead of voice) also works', (await p.textContent('#detail')).includes('Dec 3'));

  // Records behind the screens (step 1)
  const recs = () => p.evaluate(() => JSON.parse(localStorage.getItem('reintegrait.records.v1')));
  let R = await recs();
  const types = ['Client', 'Interaction', 'Need', 'Service', 'Goal', 'Referral', 'Approval'];
  check('9. The store holds all seven record types', types.every(t => Array.isArray(R[t])));
  const andre = R.Client.find(c => c.Name === 'Andre Williams');
  check('9. The new client is a Client record with its intake Interaction, Needs and Goals',
    !!andre && R.Interaction.some(i => i.ClientId === andre.Id && i.Type === 'Intake note') &&
    R.Need.filter(n => n.ClientId === andre.Id).length === 5 &&
    R.Goal.some(g => g.ClientId === andre.Id && g.Text.includes('winter coat')) &&
    R.Goal.some(g => g.ClientId === andre.Id && g.DueDate === '2026-11-13'));
  check('9. Each approved note and update writes an Approval record', R.Approval.length === 3 && R.Approval.every(a => a.ApprovedBy && a.ApprovedAt));
  check('9. Logging a response closes the old reminder and opens the new one',
    R.Goal.some(g => g.ClientId === 'c1' && g.DueDate === '2026-11-11' && g.Status === 'Done') &&
    R.Goal.some(g => g.ClientId === 'c1' && g.DueDate === '2026-11-18' && g.Status === 'Open'));
  check('9. Sample referrals are Referral records', R.Referral.length === 2);
  await p.reload(); await p.waitForSelector('#btn-new'); await p.click('#nav-clients');
  const afterReload = await p.textContent('tbody');
  check('9. A reload keeps new clients and updates', afterReload.includes('Andre Williams') && afterReload.includes('Enrolled'));
  await p.click('[data-reset]'); await p.click('#nav-clients');
  R = await recs();
  check('9. Reset sample data brings back the five sample clients',
    (await p.$$('tbody tr')).length === 5 && !(await p.textContent('tbody')).includes('Andre') && R.Approval.length === 0);
  const p3 = await browser.newPage();
  await p3.route('**/simulated_responses.json', async r => {
    const j = await (await r.fetch()).json(); j.templates.update_types.push('Court date check');
    j.templates.intake_notes['Standard intake note'].key_fields.push({ key: 'name', label: 'Preferred name' }); await r.fulfill({ json: j });
  });
  await p3.goto(URL); await p3.click('#btn-existing'); await p3.click('#btn-addinfo');
  const hasType = (await p3.$$eval('#utype option', o => o.map(x => x.textContent))).includes('Court date check');
  await p3.click('#mclose'); await p3.click('#nav-home'); await p3.click('#btn-new'); await p3.click('#sample');
  await p3.waitForSelector('#mgo:not([disabled])'); await p3.click('#mgo'); await waitForAI(p3);
  const hasField = (await p3.$$eval('.keyinfo label', ls => ls.map(l => l.textContent))).some(t => t.includes('Preferred name'));
  check('9. Templates (update types, key fields) come from simulated_responses.json', hasType && hasField);

  // 10. Step 1 spec (Step 1 spec - Client Note.docx)
  const s = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  s.on('pageerror', e => errors.push(e.message));
  await s.goto(URL); await s.waitForSelector('#btn-new');
  await s.click('[data-reset]'); await s.waitForSelector('#reminders');
  const remText = await s.textContent('#reminders');
  check('10. Home lists reminders due today and this week (Keisha Moore, Nov 16), each with Log response',
    remText.includes('Keisha Moore') && remText.includes('Nov 16') &&
    (await s.$$('#reminders [data-logresp]')).length === (await s.$$('#reminders .row')).length);
  await s.click('#reminders [data-logresp="c1"]');
  check('10. Log response on a home reminder opens the update flow with its type',
    (await s.textContent('#mtitle')).includes('Marcus Reed') && (await s.inputValue('#utype')) === 'Referral check');
  await s.click('#mclose');
  await s.click('#btn-new');
  check('10. Pop-up offers "Type notes instead"', (await s.textContent('.modal')).toLowerCase().includes('type notes instead'));
  await s.setInputFiles('#file', { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  const refusal = await s.textContent('#filebox');
  check('10. A file in another format is refused, saying why and what to do',
    refusal.includes("Can't use this file") && refusal.includes('MP3, M4A, WAV or AAC') && await s.isDisabled('#mgo'));
  await s.click('#sample'); await s.waitForSelector('#mgo:not([disabled])');
  check('10. Sample recording matches the spec', (await s.textContent('#filebox')).includes('intake-andre-williams-2026-11-11.m4a'));
  await s.click('#mgo'); await waitForAI(s);
  const flagsTop = await s.evaluate(() => { const f = document.getElementById('flags'), n = document.getElementById('note'); return !!f && !!(f.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); });
  check('10. Flags appear at the top of the note, with an icon and text', flagsTop &&
    (await s.textContent('#flags')).includes('⚠') && (await s.textContent('#flags')).includes('Gender') && (await s.textContent('#flags')).includes('00:38:14'));
  check('10. Consent to recording is shown in the transcript', (await s.textContent('#t2')).includes('Consent'));
  await s.click('[data-src="t5"]');
  await s.click('#btn-edit');
  await s.selectOption('[data-pri="4"]', 'Soon');
  check('10. A need\'s priority can be changed', (await s.$$eval('#needs li', ls => ls[4].querySelector('select').value)) === 'Soon');
  await s.fill('#k-age', '35'); await s.click('#btn-edit');
  check('10. Review box says "I reviewed this note against the conversation"',
    (await s.textContent('#review')).includes('I reviewed this note against the conversation'));
  await s.selectOption('#fx-f1', 'Male'); await s.click('[data-fix="f1"]');
  await s.fill('#fx-f2', '773-555-0186'); await s.click('[data-fix="f2"]');
  await s.check('#rv1'); await s.click('#btn-save'); await s.waitForSelector('#detail-name');
  check('10. A new client gets status "New intake" and a follow-up reminder',
    (await s.textContent('#detail')).includes('New intake') && (await s.textContent('#remcard')).includes('Nov 13'));
  await s.click('#nav-activity');
  const log = await s.textContent('#activity');
  check('10. Activity log shows edits (before → after), priority change, flags, review tick, reminder and approval time',
    log.includes('"34" → "35"') && log.includes('Later → Soon') && log.includes('Flag resolved') && log.includes('Review box ticked') &&
    log.includes('Reminder created') && log.includes('from upload to approval') && log.includes('Time stamp opened'));
  await shot(s, '10-activity-log');
  await s.click('#nav-clients'); await s.click('tr[data-id="c1"]'); await s.click('#btn-addinfo'); await s.click('#sample');
  await s.waitForSelector('#mgo:not([disabled])'); await s.click('#mgo'); await waitForAI(s);
  await s.uncheck('[data-keep="2"]'); await s.check('#urv'); await s.click('#usave'); await s.waitForSelector('#timeline');
  await s.click('#nav-activity');
  const log2 = await s.textContent('#activity');
  check('10. Activity log shows the update type and which changes were accepted or removed',
    log2.includes('Referral check · voice note') && log2.includes('Change accepted') && log2.includes('Change removed') && log2.includes('Update approved'));
  await s.click('[data-reset]');

  // Simulated AI lives in the JSON file
  const p2 = await browser.newPage();
  await p2.route('**/simulated_responses.json', async r => {
    const j = await (await r.fetch()).json(); j.new_client_intake.note.key_info.name.value = 'Edited In JSON'; await r.fulfill({ json: j });
  });
  await p2.goto(URL); await p2.click('#btn-new'); await p2.click('#sample');
  await p2.waitForSelector('#mgo:not([disabled])'); await p2.click('#mgo'); await waitForAI(p2);
  check('7. AI output comes from simulated_responses.json', (await p2.inputValue('#k-name')) === 'Edited In JSON');

  const m = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await m.goto(URL); await m.waitForSelector('#btn-new');
  check('8. Works at phone width with no sideways scroll', await m.evaluate(() => document.documentElement.scrollWidth) <= 390);
  check('8. No script errors', errors.length === 0);

  console.log(results.join('\n'));
  if (errors.length) console.log(errors);
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})();
