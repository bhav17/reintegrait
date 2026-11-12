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
