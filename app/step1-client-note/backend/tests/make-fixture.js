// Rebuilds sample-case-file.json from the browser's own grStats() and grMetrics().
// 1. In step1-client-note: python3 -m http.server 8765
// 2. node backend/tests/make-fixture.js backend/tests/sample-case-file.json   (needs Playwright)
const { chromium } = require('playwright');
const URL = process.env.PROTO_URL || 'http://localhost:8765/';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto(URL); await p.waitForSelector('#btn-new');
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector('#btn-new');
  const out = await p.evaluate(() => {
    const norm = s => JSON.parse(JSON.stringify(s, (k, v) => v instanceof Set ? v.size : v));
    const run = () => { const e = {}; for (const pk of Object.keys(GR_PERIODS)) { const s = grStats(pk);
      e[pk] = { period: GR_PERIODS[pk], stats: norm(s), metrics: { icjia: grMetrics(s, 'icjia'), bja: grMetrics(s, 'bja') } }; } return e; };
    const sample = { records: JSON.parse(JSON.stringify(Store.data)), expected: run() };
    // A busier case file: every referral stage, a decline, outcomes, a typed age, a missing gender, a race field.
    const add = (t, r) => Store.insert(t, r);
    add('Client', { Name: 'Test Person', Age: '19', Gender: '', ClientSince: '2026-10-05', Status: 'Active', RaceEthnicity: 'Black or African American' });
    const tp = Store.all('Client').at(-1).Id;
    add('Interaction', { ClientId: tp, Date: '2026-10-05', Type: 'Intake note', MeetingType: 'In-person visit', Minutes: '35' });
    add('Interaction', { ClientId: tp, Date: '2026-08-02', Type: 'Weekly phone check', MeetingType: 'Phone call', Minutes: 0 });
    add('Service', { ClientId: tp, Date: '2026-10-05', ServiceType: 'Transport', Minutes: 35 });
    add('Service', { ClientId: tp, Date: '2026-08-02', ServiceType: 'Education', Minutes: 7 });
    add('Referral', { ClientId: tp, Partner: 'A', SentDate: '2026-10-06', Status: 'Declined', DeclineReason: 'Program full' });
    add('Referral', { ClientId: tp, Partner: 'B', SentDate: '2026-10-07', Status: 'Declined' });
    add('Referral', { ClientId: 'c2', Partner: 'C', SentDate: '2026-10-09', Status: 'Accepted', Stage: 'Attended', AttendedDate: '2026-10-15' });
    add('Referral', { ClientId: 'c3', Partner: 'D', SentDate: '2026-10-22', Status: 'Accepted', Stage: 'Closed', Outcome: 'Goal met' });
    add('Referral', { ClientId: 'c4', Partner: 'E', SentDate: '2026-09-01', Stage: 'No-show', Attendance: 'No-show' });
    add('Referral', { ClientId: 'c4', Partner: 'F', SentDate: '2026-07-20', Status: 'Accepted', Attendance: 'Showed up', Outcome: 'Partly met' });
    add('Referral', { ClientId: 'c5', Partner: 'G', SentDate: '' });
    add('Need', { ClientId: tp, Text: 'x', Status: 'Open' });
    add('Need', { ClientId: tp, Text: 'y', ServiceType: 'Jobs', Status: 'Closed' });
    const busy = { records: JSON.parse(JSON.stringify(Store.data)), expected: run() };
    return { sample, busy };
  });
  require('fs').writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  await b.close();
})();
