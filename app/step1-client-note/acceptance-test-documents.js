// Verify with a document. Run with the prototype served on :8000 (python3 -m http.server 8000).
// Part 1 uses the sample documents in Simulated mode. Part 2 fakes the laptop helper to check what is sent to the real model.
const { chromium } = require('playwright');
const path = require('path');
const URL = process.env.PROTO_URL || 'http://localhost:8000/';
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name); if (!ok) fails++; };

async function openAndre(p) {
  await p.goto(URL); await p.waitForSelector('#btn-new');
  await p.click('[data-reset]');
  await p.click('#btn-new'); await p.click('#sample');
  await p.waitForSelector('#mgo:not([disabled])'); await p.click('#mgo');
  await p.waitForSelector('#seenote:not([hidden])', { timeout: 10000 }); await p.click('#seenote');
}
async function readSample(p, id) {
  await p.click('#btn-verify'); await p.click(`[data-sample="${id}"]`);
  await p.click('#dgo'); await p.waitForSelector('#dtitle', { state: 'detached', timeout: 10000 });
}
const verifiedText = (p, key) => p.$eval(`[data-verified="${key}"]`, e => e.textContent).catch(() => '');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await openAndre(p);

  // 1. The button and the pop-up
  check('1. The note has a "Verify with a document" button', (await p.textContent('#btn-verify')).includes('Verify with a document'));
  await p.click('#btn-verify');
  check('1. The pop-up takes a photo or a file and offers made-up sample documents',
    (await p.getAttribute('#dfile', 'accept')).includes('application/pdf') && (await p.$$('[data-sample]')).length === 2);
  await p.setInputFiles('#dfile', path.join(__dirname, 'README.md'));
  check('1. A file that is not a photo or PDF is refused with a reason', (await p.textContent('#derr')).includes("isn't a JPG, PNG or PDF"));
  await p.setInputFiles('#dfile', path.join(__dirname, 'sample-documents/andre-state-id.png'));
  check('1. In Simulated mode, your own document asks for real AI', (await p.textContent('#derr')).includes('Real AI is off') && await p.isDisabled('#dgo'));
  await p.click('#dcancel');

  // 2. Release papers: matches, a difference and values found only on the document
  await p.click('#btn-verify'); await p.click('[data-sample="release"]'); await p.check('#dkeep');
  await p.click('#dgo'); await p.waitForSelector('#dtitle', { state: 'detached', timeout: 10000 });
  check('2. Name, neighborhood and facility match and get a Verified tag',
    (await verifiedText(p, 'name')).includes('Verified · Release papers') && (await verifiedText(p, 'facility')).includes('Release papers') && (await verifiedText(p, 'locality')).includes('Release papers'));
  check('2. Age is checked from the date of birth', (await verifiedText(p, 'age')).includes('date of birth'));
  const flags = await p.textContent('#flags');
  check('2. A different release date becomes a flag with both values', flags.includes('Document differs: Release date') && flags.includes('2026-11-02') && flags.includes('2026-11-03'));
  await p.check('#rv1');
  check('2. The note cannot be approved while the difference is open', await p.isDisabled('#btn-save'));
  const offers = await p.$$eval('.doc .offer', ls => ls.map(l => l.textContent));
  check('2. Date of birth, supervision, officer and conditions are offered to add', offers.length === 4 && offers.some(t => t.includes('1992-04-17')) && offers.some(t => t.includes('Parole')));
  check('2. Gender is never read from a document', !offers.some(t => /gender/i.test(t)));

  await p.click('[data-offer="doc1|birth_date|add"]');
  check('2. "Add to note" fills the field and marks it verified', (await p.inputValue('#k-birth_date')) === '1992-04-17' && (await verifiedText(p, 'birth_date')).includes('Release papers'));
  await p.click('[data-offer="doc1|conditions|skip"]');
  check('2. "Leave out" keeps the field empty', (await p.inputValue('#k-conditions').catch(() => '')) === '' && (await p.textContent('#docs')).includes('Left out: Conditions'));
  await p.click('[data-choose="f-doc1-release_date|doc"]');
  check('2. Choosing the document value updates the field and resolves the flag',
    (await p.inputValue('#k-release_date')) === '2026-11-03' && (await p.textContent('#flags')).includes('From Release papers'));

  // 3. A second document adds to the same tag
  await readSample(p, 'stateid');
  check('3. A state ID that agrees adds to the Verified tag', (await verifiedText(p, 'name')).includes('Release papers, State ID'));
  check('3. A hand edit removes the Verified tag', await (async () => {
    await p.click('#btn-edit'); await p.fill('#k-facility', 'Sheridan CC'); await p.click('#btn-edit');
    return !(await verifiedText(p, 'facility'));
  })());

  // 4. Save: records, case file and activity log
  await p.selectOption('#fx-f1', 'Male'); await p.selectOption('#fxs-f1', 'Asked client'); await p.click('[data-fix="f1"]');
  await p.fill('#fx-f2', '773-555-0186'); await p.click('[data-fix="f2"]');
  for (const sel of await p.$$('[data-why]')) { if (!(await sel.inputValue())) await sel.selectOption({ index: 1 }); }
  if (!(await p.isChecked('#rv1'))) await p.check('#rv1');
  await p.click('#btn-save'); const ok = await p.waitForSelector('#fast-ok', { timeout: 800 }).catch(() => null); if (ok) await ok.click();
  await p.waitForSelector('#ms-board');
  const rec = await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('reintegrait.records.v2')); const c = d.Client.find(x => x.Name === 'Andre Williams'); return { c, docs: d.Document.filter(x => x.ClientId === c.Id), it: d.Interaction.find(x => x.ClientId === c.Id) }; });
  check('4. Saving writes one Document record per document read', rec.docs.length === 2 && rec.docs[0].DocumentType === 'Release papers' && rec.docs[0].DocumentNumber === 'S00000' && rec.docs[0].Status === 'Checked');
  check('4. The Document record keeps what matched, what differed and what was chosen',
    rec.docs[0].Matched.includes('name') && rec.docs[0].Differed[0].Field === 'release_date' && rec.docs[0].Differed[0].Chosen === 'Document' && rec.docs[0].Added.includes('birth_date') && rec.docs[0].LeftOut.includes('conditions'));
  check('4. The client record notes which fields were verified', rec.c.VerifiedFields && rec.c.VerifiedFields.release_date === 'Release papers' && rec.c.VerifiedFields.name === 'Release papers, State ID' && !rec.c.VerifiedFields.facility);
  check('4. The intake note says which documents it was checked against', rec.it.Summary.includes('Checked against: Release papers, State ID'));
  await p.click('#nav-clients'); await p.click('tr:has-text("Andre Williams")');
  const dl = await p.textContent('#doclist');
  check('4. The client\'s Documents list shows both documents with their check result', dl.includes('Release papers') && dl.includes('State ID') && dl.includes('Checked, differed') && dl.includes('Verified'));
  check('4. "Keep a copy" saved the release papers file, and only that one', rec.docs[0].FileStored === true && rec.docs[1].FileStored === false && (await p.$$('[data-viewdoc]')).length === 1);
  check('4. The kept file is in this browser', await p.evaluate(k => Files.get(k).then(b => !!b && b.size > 1000), rec.docs[0].FileKey));
  await p.click('#nav-activity');
  const log = await p.textContent('#activity');
  for (const ev of ['Document read', 'Document matches', 'Document differs', 'Document value found', 'Document value added', 'Document value left out', 'Document value chosen'])
    check(`4. Activity log records "${ev}"`, log.includes(ev));

  // 4b. Add a document by hand on an existing client
  await p.click('#nav-clients'); await p.click('tr:has-text("Marcus Reed")');
  check('4b. A client with no documents says so and offers "Add document"', !!(await p.$('#doclist-empty')) && !!(await p.$('#btn-adddoc')));
  await p.click('#btn-adddoc');
  await p.setInputFiles('#afile', path.join(__dirname, 'README.md'));
  check('4b. A file that is not a photo or PDF is refused', (await p.textContent('#aerr')).includes("isn't a JPG, PNG or PDF"));
  await p.setInputFiles('#afile', { name: 'marcus-snap-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample benefits letter for testing') });
  check('4b. "Add to documents" waits for a document type', await p.isDisabled('#ago'));
  await p.selectOption('#atype', 'Benefits letter'); await p.fill('#anote', 'SNAP approval');
  await p.click('#ago'); await p.waitForSelector('#atitle', { state: 'detached' });
  const m = await p.evaluate(() => { const c = Store.all('Client').find(x => x.Name === 'Marcus Reed'); return Store.where('Document', d => d.ClientId === c.Id); });
  check('4b. The document is saved as a Document record with its file', m.length === 1 && m[0].DocumentType === 'Benefits letter' && m[0].Status === 'On file' && m[0].FileStored && m[0].Note === 'SNAP approval');
  check('4b. It shows in the list as "On file"', (await p.textContent('#doclist')).includes('Benefits letter') && (await p.textContent('#doclist')).includes('On file'));
  const popup = p.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
  await p.click('[data-viewdoc]'); const pop = await popup;
  check('4b. View opens the file', !!pop); if (pop) await pop.close();
  await p.click('#btn-adddoc'); await p.click('[data-asample="stateid"]'); await p.waitForSelector('#afilebox');
  check('4b. A sample fills in its type and number', (await p.inputValue('#atype')) === 'State ID' && (await p.inputValue('#anum')) === 'W000-0000-0000');
  await p.click('#acancel');
  await p.click('[data-rmdoc]');
  check('4b. Remove asks once more before removing', (await p.textContent('[data-rmdoc]')).includes('Remove for good?'));
  await p.click('[data-rmdoc]');
  check('4b. Remove deletes the record and its file', !!(await p.$('#doclist-empty')) && await p.evaluate(k => Files.get(k).then(b => !b), m[0].FileKey));
  await p.click('#nav-activity');
  const log2 = await p.textContent('#activity');
  for (const ev of ['Document added', 'Document opened', 'Document removed']) check(`4b. Activity log records "${ev}"`, log2.includes(ev));
  await p.click('[data-reset]');
  check('4b. Reset sample data also clears the files', await p.evaluate(k => new Promise(r => setTimeout(r, 300)).then(() => Files.get(k)).then(b => !b), rec.docs[0].FileKey));

  // 5. Saved data from before this change still loads
  await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('reintegrait.records.v2')); delete d.Document; localStorage.setItem('reintegrait.records.v2', JSON.stringify(d)); });
  await p.reload(); await p.waitForSelector('#btn-new');
  check('5. Saved clients from before documents were added are kept', await p.evaluate(() => Store.all('Client').some(c => c.Name === 'Marcus Reed') && Array.isArray(Store.all('Document'))));

  // 6. Real AI path (helper faked): what is sent, and an unreadable photo
  const sent = [];
  await p.route('**/api/status', r => r.fulfill({ json: { helper: true, mode: 'real', provider: 'hf-inference', model: 'whisper', key_found: true,
    note: { enabled: false }, document: { enabled: true, model: 'claude-opus-5-5', key_found: true, sdk_installed: true } } }));
  await p.route('**/api/log', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/transcribe', r => r.fulfill({ json: { ok: false, error: 'not in this test' } }));
  await p.route('**/api/read-document', r => { sent.push(r.request().postDataJSON());
    r.fulfill({ json: { ok: true, model: 'claude-opus-5-5', seconds: 4.2, document: { readable: false, document_type: 'Other', document_number: '', issued_by: '', fields: [], comment: 'The photo is blurry. Take it again in better light.' } } }); });
  await openAndre(p);
  await p.click('#btn-verify');
  check('6. With real AI on, the pop-up names the model', (await p.textContent('#dmode')).includes('claude-opus-5-5'));
  await p.setInputFiles('#dfile', path.join(__dirname, 'sample-documents/andre-state-id.png'));
  await p.click('#dgo'); await p.waitForSelector('#dtitle', { state: 'detached', timeout: 10000 });
  const s = sent[0] || {};
  check('6. The photo is sent as base64 with its type', s.media_type && s.media_type.startsWith('image/') && (s.data || '').length > 1000);
  check('6. Only checkable fields are sent (no gender, no phone)', s.fields && s.fields.some(f => f.key === 'release_date') && !s.fields.some(f => f.key === 'gender' || f.key === 'contact'));
  check('6. An unreadable photo says what to do and changes nothing', (await p.textContent('#docs')).includes('blurry') && !(await p.$('[data-verified]')));

  // 7. Phone width
  await p.setViewportSize({ width: 375, height: 800 });
  await p.click('#btn-verify'); await p.click('[data-sample="release"]');
  check('7. The pop-up fits at phone width', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check('7. No script errors', errors.length === 0);
  if (errors.length) console.log(errors);

  await b.close();
  console.log(fails ? `\n${fails} failed` : '\nAll passed');
  process.exit(fails ? 1 : 0);
})();
