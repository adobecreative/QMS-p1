// End-to-end check of the interface in a real browser (Chromium via Playwright).
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { PDFDocument, StandardFonts } = require('/home/claude/.npm-global/lib/node_modules/pdf-lib');
const fs = require('fs');
const URL0 = 'http://localhost:8787/';
let failed = 0;
const ok = (cond, label, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  -> ' + extra : '')); if (!cond) failed++; };

async function makePdf(path, pages, text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) { const p = doc.addPage([595, 842]); p.drawText(`${text} - page ${i}`, { x: 60, y: 760, size: 24, font }); }
  fs.writeFileSync(path, await doc.save());
}

(async () => {
  await makePdf('/tmp/doc3.pdf', 3, 'Evacuation plan');
  await makePdf('/tmp/doc1.pdf', 1, 'Replacement');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  const dlg = () => page.locator('dialog[open]');
  const save = async () => { await dlg().locator('button[type=submit]').click(); await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 15000 }); };
  const go = async (hash, sel) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector(sel, { timeout: 15000 }); };

  // --- first-run setup
  await page.goto(URL0);
  await page.waitForSelector('.auth-card form');
  ok((await page.locator('.auth-card input').count()) === 3, 'setup form shows name/email/password');
  ok((await page.getAttribute('html', 'dir')) === 'rtl', 'Arabic is RTL by default');
  await page.locator('.auth-card input').nth(0).fill('Owner');
  await page.locator('.auth-card input').nth(1).fill('owner@example.com');
  await page.locator('.auth-card input').nth(2).fill('secret-pass-1');
  await page.locator('.auth-card button[type=submit]').click();
  await page.waitForSelector('.nav-link');
  ok((await page.locator('.nav-link').count()) === 6, 'super admin sees 6 nav items');

  // --- departments
  await go('#/departments', '.page-head .btn-primary');
  for (const [ar, en] of [['السلامة', 'Safety'], ['الصيانة', 'Maintenance']]) {
    await page.locator('.page-head .btn-primary').click();
    await dlg().locator('input').nth(0).fill(ar);
    await dlg().locator('input').nth(1).fill(en);
    await save();
    await page.waitForSelector(`td:has-text("${en}")`);
  }
  ok((await page.locator('tbody tr').count()) === 2, 'two departments listed');

  // --- users
  await go('#/users', '.page-head .btn-primary');
  const addUser = async (name, email, pass, role, deptIndex) => {
    await page.locator('.page-head .btn-primary').click();
    await dlg().locator('input[type=text]').fill(name);
    await dlg().locator('input[type=email]').fill(email);
    await dlg().locator('select').nth(0).selectOption(role);
    if (role === 'dept_admin') await dlg().locator('select').nth(1).selectOption({ index: deptIndex });
    await dlg().locator('input[type=password]').fill(pass);
    await save();
    await page.waitForSelector(`td:has-text("${email}")`);
  };
  await addUser('Safety Admin', 'safety@example.com', 'secret-pass-2', 'dept_admin', 1);
  await addUser('Reader', 'reader@example.com', 'secret-pass-3', 'viewer');
  ok((await page.locator('tbody tr').count()) === 3, 'three users listed');
  ok(await page.locator('tbody tr').nth(1).locator('td').nth(1).innerText() === 'السلامة', 'dept admin linked to Safety');

  // --- files
  await go('#/dashboard', '.cards');
  const addFile = async (o) => {
    await page.locator('.page-head .btn-primary').click();
    const d = dlg();
    await d.locator('input[type=text]').nth(0).fill(o.name);
    await d.locator('input[type=text]').nth(1).fill(o.number);
    await d.locator('select').nth(0).selectOption(o.type);
    await d.locator('select').nth(1).selectOption({ index: o.dept });
    if (o.issue) await d.locator('input[type=date]').nth(0).fill(o.issue);
    if (o.permanent) await d.locator('input[type=checkbox]').nth(0).check();
    else await d.locator('input[type=date]').nth(1).fill(o.expiry);
    if (o.review) await d.locator('input[type=checkbox]').nth(1).check();
    await d.locator('input[type=file]').setInputFiles(o.pdf || '/tmp/doc3.pdf');
    await save();
    await page.waitForSelector(`td:has-text("${o.number}")`);
  };
  await addFile({ name: 'فحص أنظمة الإطفاء', number: 'FM-SAF-007', type: 'procedure', dept: 0, issue: '2025-09-10', expiry: '2026-09-10' });
  await addFile({ name: 'عقد صيانة المصاعد', number: 'FM-MNT-014', type: 'program', dept: 1, issue: '2025-11-01', expiry: '2026-10-20' });
  await addFile({ name: 'خطة الإخلاء والطوارئ', number: 'FM-SAF-001', type: 'program', dept: 0, issue: '2025-01-15', expiry: '2027-01-15' });
  await addFile({ name: 'دليل الهيكل التنظيمي', number: 'FM-SAF-100', type: 'policy', dept: 0, issue: '2023-02-12', permanent: true });
  await addFile({ name: 'سياسة تصاريح العمل', number: 'FM-SAF-011', type: 'policy', dept: 0, issue: '2026-09-20', expiry: '2027-09-20', review: true });
  const nums = await page.locator('.card-num').allInnerTexts();
  ok(nums.join(',') === '1,1,1,1', 'cards: valid/near/expired/review = 1,1,1,1', nums.join(','));
  ok((await page.locator('.files-table tbody tr').count()) === 5, 'five files in table');
  ok((await page.locator('.files-table tbody tr').nth(0).locator('td').nth(1).innerText()) === 'FM-SAF-007', 'expired file sorted first');
  ok(/20/.test(await page.locator('.note-expired').innerText()), 'expired note shows days', await page.locator('.note-expired').innerText());
  await page.screenshot({ path: '/tmp/shot-dashboard-ar.png', fullPage: true });

  // filter by card, by department
  await page.locator('.card-expired').click();
  ok((await page.locator('.files-table tbody tr').count()) === 1, 'card click filters to expired');
  await page.locator('.card-expired').click();
  await page.locator('#dash-dept').selectOption({ index: 2 });
  ok((await page.locator('.files-table tbody tr').count()) === 1, 'department filter shows Maintenance only');
  await page.locator('#dash-dept').selectOption({ index: 0 });

  // export
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.page-head .btn').first().click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  ok(csv.charCodeAt(0) === 0xfeff && csv.split('\r\n').length === 6 && csv.includes('FM-MNT-014'), 'CSV export has BOM + 5 rows');

  // --- reader + PDF
  await page.locator('.files-table tbody tr', { hasText: 'FM-SAF-001' }).locator('a.btn').click();
  await page.waitForSelector('.pdf-canvas', { timeout: 20000 });
  await page.waitForFunction(() => /3/.test(document.querySelector('.pdf-page').textContent), null, { timeout: 20000 });
  ok(true, 'PDF opened in the page', await page.locator('.pdf-page').innerText());
  const w1 = await page.evaluate(() => document.querySelector('.pdf-canvas').width);
  ok(w1 > 300, 'canvas rendered', w1);
  await page.locator('.pdf-bar .btn-icon').nth(1).click();
  await page.waitForFunction(() => /2/.test(document.querySelector('.pdf-page').textContent.replace('3', '')));
  ok(true, 'next page works', await page.locator('.pdf-page').innerText());
  await page.locator('.pdf-bar .btn-icon').nth(3).click();
  await page.waitForFunction((w) => document.querySelector('.pdf-canvas').width > w, w1);
  ok((await page.locator('.pdf-zoom').innerText()) === '125%', 'zoom in works');
  ok((await page.locator('.doc h1').innerText()) === 'خطة الإخلاء والطوارئ', 'reader shows file name');
  ok((await page.locator('.doc-item').count()) === 4, 'reader lists 4 Safety files');
  await page.screenshot({ path: '/tmp/shot-reader-ar.png', fullPage: true });
  await page.locator('.pdf-bar .btn-primary').click();
  ok(await page.evaluate(() => document.querySelector('.pdf').classList.contains('pdf-full')), 'full screen on');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => !document.querySelector('.pdf').classList.contains('pdf-full')), 'Escape leaves full screen');
  await page.locator('.doc-item').nth(3).click();
  await page.waitForFunction(() => location.hash !== '' && document.querySelector('.doc h1').textContent === 'فحص أنظمة الإطفاء');
  ok(true, 'picking another file in the list works', await page.evaluate(() => location.hash));

  // --- renew expired file: new dates + replace PDF
  await go('#/dashboard', '.files-table');
  await page.locator('.files-table tbody tr', { hasText: 'FM-SAF-007' }).locator('.btn-icon').nth(0).click();
  ok(/doc3\.pdf/.test(await dlg().locator('.hint').last().innerText()), 'edit dialog names the current PDF');
  await dlg().locator('input[type=date]').nth(0).fill('2026-09-30');
  await dlg().locator('input[type=date]').nth(1).fill('2027-09-30');
  await dlg().locator('input[type=file]').setInputFiles('/tmp/doc1.pdf');
  await save();
  await page.waitForFunction(() => { const c = document.querySelectorAll('.card-num'); return c.length === 4 && c[2].textContent === '0'; });
  ok((await page.locator('.card-num').allInnerTexts()).join(',') === '2,1,0,1', 'after renewal: 2,1,0,1');
  // wrong file type is rejected with a message
  await page.locator('.page-head .btn-primary').click();
  await dlg().locator('input[type=text]').nth(0).fill('X');
  await dlg().locator('input[type=text]').nth(1).fill('X-1');
  await dlg().locator('input[type=date]').nth(1).fill('2027-01-01');
  fs.writeFileSync('/tmp/fake.pdf', 'hello');
  await dlg().locator('input[type=file]').setInputFiles('/tmp/fake.pdf');
  await dlg().locator('button[type=submit]').click();
  await page.waitForSelector('dialog[open] .form-error:not([hidden])');
  ok(true, 'non-PDF upload shows an error', await dlg().locator('.form-error').innerText());
  await dlg().locator('.dialog-actions .btn').nth(1).click();
  // delete
  await page.locator('.files-table tbody tr', { hasText: 'FM-SAF-100' }).locator('.btn-icon').nth(1).click();
  await save();
  await page.waitForFunction(() => document.querySelectorAll('.files-table tbody tr').length === 4);
  ok(true, 'file deleted');

  // --- logs
  await go('#/logs', 'tbody tr');
  const logRows = await page.locator('tbody tr').count();
  ok(logRows >= 11, 'activity log has entries', logRows);
  const firstLog = await page.locator('tbody tr').nth(1).innerText();
  ok(/doc3\.pdf/.test(firstLog) && /doc1\.pdf/.test(firstLog), 'log records the PDF replacement and date change', firstLog.replace(/\s+/g, ' ').slice(0, 200));
  await page.screenshot({ path: '/tmp/shot-logs-ar.png', fullPage: true });

  // --- settings
  await go('#/settings', 'form.settings');
  await page.locator('form.settings input[type=url]').fill('https://example.com/not-google');
  await page.locator('form.settings button[type=submit]').click();
  await page.waitForSelector('form.settings .form-error:not([hidden])');
  ok(true, 'bad sender URL rejected', await page.locator('form.settings .form-error').innerText());
  await page.locator('form.settings input[type=url]').fill('https://script.google.com/macros/s/AKfycb_test-1/exec');
  await page.locator('form.settings input[type=password]').fill('tok-123');
  await page.locator('form.settings input[type=number]').nth(0).fill('45');
  await page.locator('form.settings button[type=submit]').click();
  await page.waitForSelector('.toast');
  await page.waitForSelector('form.settings .hint');
  ok((await page.locator('form.settings input[type=number]').nth(0).inputValue()) === '45', 'settings saved and reloaded');
  await page.screenshot({ path: '/tmp/shot-settings-ar.png', fullPage: true });

  // --- English
  await go('#/dashboard', '.cards');
  await page.locator('.top .lang-btn').nth(1).click();
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');
  await page.waitForSelector('.cards');
  ok((await page.locator('.nav-link').first().innerText()) === 'Dashboard', 'English UI + LTR');
  ok((await page.locator('.files-table tbody tr').nth(0).locator('td').nth(3).innerText()) === 'Maintenance', 'department names switch to English');
  await page.screenshot({ path: '/tmp/shot-dashboard-en.png', fullPage: true });
  await page.locator('.top .lang-btn').nth(0).click();
  await page.waitForFunction(() => document.documentElement.dir === 'rtl');

  // --- sign out, viewer
  const login = async (email, pass) => {
    await page.locator('.user-btn').click();
    await dlg().locator('.btn-end').click();
    await page.waitForSelector('.auth-card form');
    await page.locator('.auth-card input').nth(0).fill(email);
    await page.locator('.auth-card input').nth(1).fill(pass);
    await page.locator('.auth-card button[type=submit]').click();
  };
  await login('reader@example.com', 'wrong-password');
  await page.waitForSelector('.auth-card .form-error:not([hidden])');
  ok(true, 'wrong password shows an error', await page.locator('.auth-card .form-error').innerText());
  await page.locator('.auth-card input').nth(1).fill('secret-pass-3');
  await page.locator('.auth-card button[type=submit]').click();
  await page.waitForSelector('.doc-layout');
  ok((await page.locator('.nav-link').count()) === 2, 'viewer sees 2 nav items and lands on the reader');
  await go('#/settings', '.doc-layout');
  ok(true, 'viewer cannot open settings (falls back to reader)');
  await go('#/dashboard', '.cards');
  ok((await page.locator('.page-head .btn-primary').count()) === 0 && (await page.locator('.files-table .btn-icon').count()) === 0, 'viewer has no add/edit/delete');
  ok((await page.locator('.files-table tbody tr').count()) === 4, 'viewer sees all 4 files');

  // --- department admin
  await login('safety@example.com', 'secret-pass-2');
  await page.waitForSelector('.cards');
  ok((await page.locator('.nav-link').count()) === 2, 'dept admin sees 2 nav items');
  ok((await page.locator('.files-table tbody tr').count()) === 3, 'dept admin sees only Safety files (3)');
  ok((await page.locator('#dash-dept').count()) === 0, 'dept admin has no department switcher');
  ok((await page.locator('.files-table .btn-icon').count()) === 6, 'dept admin can edit/delete own files');
  await page.locator('.page-head .btn-primary').click();
  ok(await dlg().locator('select').nth(1).isDisabled(), 'dept admin cannot pick another department');
  await dlg().locator('.dialog-actions .btn').nth(1).click();

  // --- phone
  await page.setViewportSize({ width: 390, height: 844 });
  await go('#/dashboard', '.cards');
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, 'no sideways scroll on a phone (dashboard)', overflow);
  await page.screenshot({ path: '/tmp/shot-dashboard-phone.png', fullPage: true });
  await go('#/documents', '.pdf-canvas');
  await page.waitForFunction(() => document.querySelector('.pdf-page').textContent.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow2 <= 0, 'no sideways scroll on a phone (reader)', overflow2);
  await page.screenshot({ path: '/tmp/shot-reader-phone.png', fullPage: true });

  ok(errors.length === 0, 'no JavaScript errors', errors.join(' | '));
  await browser.close();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + e.message.split('\n').slice(0, 6).join(' / ')); process.exit(2); });
