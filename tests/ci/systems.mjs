// End-to-end checks for spare parts (inventory) and inspection rounds. Runs after smoke.mjs, on the same data.
// Each check prints PASS or FAIL; any FAIL makes the run fail.

const B = process.env.BASE || 'http://localhost:8787';
let failed = 0;
const check = (cond, label, extra) => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300)));
};
const login = async (email, password) => {
  let cookie = '';
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(B + '/api' + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc && sc.startsWith('fm_session=')) cookie = sc.split(';')[0];
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  const r = await api('/login', 'POST', { email, password });
  check(r.s === 200, 'sign in ' + email, r);
  return api;
};

const owner = await login('owner@example.com', 'secret-pass-1');
const tech = await login('tech@example.com', 'secret-pass-2');
let r;

// a request to put parts on, sent from the public form
const meta = (await owner('/tickets/meta')).j;
const cat = meta.categories.find((c) => c.active && !c.pm);
const dept = (await owner('/departments')).j.departments.find((d) => !d.is_team);
// Only staff on the list can send a request, even while the list is empty.
{
  const fd = new FormData();
  for (const [k, v] of Object.entries({ emp_no: '1001', name: 'موظف', description: 'تسريب مياه', category_id: cat.id, department_id: dept.id })) fd.set(k, String(v));
  const res = await fetch(B + '/api/public/tickets', { method: 'POST', body: fd });
  check(res.status === 403, 'with no staff list, nobody can send a request', res.status);
}
// Only staff on the list can send a request, so the employees below are added first.
for (const no of ['1001', '300', '301', '302']) await owner('/staff', 'POST', { emp_no: no, name: 'موظف ' + no, name_en: 'Employee ' + no, department_id: dept.id });
const form = new FormData();
for (const [k, v] of Object.entries({ emp_no: '1001', name: 'موظف', description: 'تسريب مياه', category_id: cat.id, department_id: dept.id })) form.set(k, String(v));
const sent = await fetch(B + '/api/public/tickets', { method: 'POST', body: form });
const ticket = (await sent.json()).id;
check(sent.status === 200 && ticket > 0, 'public form opens a request', sent.status);

/* ---- spare parts ---- */

check((await tech('/parts', 'POST', { code: 'X-1', name_ar: 'قطعة', name_en: 'Part' })).s === 403, 'technician cannot add a part');
r = await owner('/stores', 'POST', { name_ar: 'المخزن الرئيسي', name_en: 'Main store' });
check(r.s === 200, 'owner adds a store', r);
const store = r.j.id;
r = await owner('/parts', 'POST', { code: 'FLT-10', name_ar: 'فلتر', name_en: 'Filter', unit: 'piece', min_qty: 2, reorder_qty: 5 });
check(r.s === 200, 'owner adds a part', r);
const part = r.j.id;
check((await owner('/parts', 'POST', { code: 'FLT-10', name_ar: 'فلتر آخر', name_en: 'Other' })).s === 409, 'a part code cannot be used twice');
check((await owner('/parts', 'POST', { code: 'X-2', name_ar: 'Filter', name_en: 'Filter' })).s === 400, 'Arabic name must be Arabic');

check((await owner('/stock-moves/receive', 'POST', { kind: 'purchase', store_id: store, lines: [{ part_id: part, qty: 5, unit_cost: 10 }] })).s === 400, 'a purchase needs an order or invoice number');
r = await owner('/stock-moves/receive', 'POST', { kind: 'purchase', store_id: store, doc_no: 'PO-1', lines: [{ part_id: part, qty: 4, unit_cost: 10 }, { part_id: part, qty: 1, unit_cost: 20 }] });
check(r.s === 200 && r.j.lines === 1, 'a receipt merges lines of the same part', r);
let inv = (await owner('/inventory')).j;
let p = inv.parts.find((x) => x.id === part);
check(p.qty === 5 && p.unit_cost === 12 && p.value === 60, 'stock and average cost after the receipt', p);

r = await owner(`/tickets/${ticket}/parts`, 'POST', { part_id: part, store_id: store, qty: 9 });
check(r.s === 409 && r.j.error === 'not_enough_stock', 'cannot take more than the stock', r);
r = await owner(`/tickets/${ticket}/parts`, 'POST', { part_id: part, store_id: store, qty: 3 });
check(r.s === 200, 'parts used on the request', r);
r = await owner(`/tickets/${ticket}/parts`);
const issue = r.j.moves.find((m) => m.kind === 'issue');
check(r.s === 200 && issue && issue.qty === -3 && r.j.cost === 36, 'the request shows the parts and their cost', r.j);

r = (await owner('/part-requests')).j;
check(r.requests.some((x) => x.part_id === part && x.reason === 'low_stock' && x.qty === 5), 'falling to the minimum opens one part request', r.requests);

check((await owner(`/tickets/${ticket}/parts/${issue.id}/return`, 'POST', { qty: 4 })).s === 400, 'cannot give back more than was taken');
r = await owner(`/tickets/${ticket}/parts/${issue.id}/return`, 'POST', { qty: 1 });
check(r.s === 200, 'a part given back', r);
r = await owner(`/tickets/${ticket}/parts`);
check(r.j.cost === 24, 'the request cost drops after the return', r.j.cost);

r = await owner('/stock-moves/count', 'POST', { store_id: store, lines: [{ part_id: part, counted: 7 }] });
check(r.s === 200 && r.j.differences === 1, 'a stock count records the difference', r);
p = (await owner('/inventory')).j.parts.find((x) => x.id === part);
check(p.qty === 7 && !p.low, 'the count replaces the stock', p);

check((await owner(`/parts/${part}`, 'DELETE')).s === 409, 'a part with a history cannot be deleted');
check((await owner(`/stores/${store}`, 'DELETE')).s === 409, 'a store with a history cannot be deleted');
r = (await owner('/stock-moves')).j.moves.filter((m) => m.part_id === part).map((m) => m.kind).sort();
check(JSON.stringify(r) === JSON.stringify(['adjust', 'issue', 'purchase', 'return']), 'every move is in the record', r);

const sup = await login('super@example.com', 'secret-pass-2');
check((await sup('/inventory')).j.can_mode === false && (await owner('/inventory')).j.can_mode === true, 'only the owner is offered the stock management mode');
r = await sup('/inventory/mode', 'PUT', { mode: 'standalone' });
check(r.s === 403 && r.j.error === 'owner_only', 'a super admin cannot change the stock management mode', r);
check((await owner('/inventory/mode', 'PUT', { mode: 'standalone' })).s === 200, 'the owner changes the stock management mode');

/* ---- inspection rounds ---- */

check((await tech('/rounds')).s === 403, 'technician without a rounds role has no rounds');
r = await owner('/locations', 'POST', { name_ar: 'غرفة الكهرباء', name_en: 'Electrical room', department_id: dept.id });
check(r.s === 200, 'owner adds a place', r);
const place = r.j.id;
check((await owner('/round-forms', 'POST', { name_ar: 'فحص', name_en: 'Check', every_days: 7, category_id: cat.id, items: [], location_ids: [place] })).s === 400, 'a checklist needs lines');
r = await owner('/round-forms', 'POST', {
  name_ar: 'فحص الكهرباء', name_en: 'Electrical check', every_days: 7, category_id: cat.id, location_ids: [place],
  items: [{ text_ar: 'اللوحة مغلقة', text_en: 'Panel closed' }, { text_ar: 'لا توجد روائح', text_en: 'No smell' }],
});
check(r.s === 200, 'owner adds a checklist', r);
const formId = r.j.id;

r = (await owner('/rounds')).j;
const due = r.places.find((x) => x.form_id === formId);
check(due && due.next_due === r.today, 'the place is due today', due);
const start = (await owner('/rounds/start/' + due.id)).j;
check(start.items.length === 2, 'the checklist opens for the place', start);
const [a, b] = start.items;
check((await owner('/rounds', 'POST', { place_id: due.id, answers: [{ item_id: a.id, result: 'ok' }] })).s === 400, 'every line must be answered');

r = await owner('/rounds', 'POST', { place_id: due.id, answers: [{ item_id: a.id, result: 'ok' }, { item_id: b.id, result: 'fail', note: 'رائحة حريق' }] });
check(r.s === 200 && r.j.fail_n === 1 && r.j.ticket_id > 0 && r.j.capa_n === 1, 'a failed line opens a request and a corrective action', r);
const roundTicket = r.j.ticket_id;
check(r.j.next_due > start.today, 'the place moves to its next date', r.j.next_due);
r = await owner('/tickets/' + roundTicket);
check(r.s === 200 && /Quality round/.test(r.j.ticket.description) && /رائحة حريق/.test(r.j.ticket.description), 'the request names the round and the failed line', r.j && r.j.ticket);

r = await owner('/rounds', 'POST', { place_id: due.id, answers: [{ item_id: a.id, result: 'ok' }, { item_id: b.id, result: 'na' }] });
check(r.s === 200 && r.j.ticket_id === null, 'a round with no failed line opens nothing', r);
const log = (await owner('/rounds/log')).j.rounds.filter((x) => x.form_id === formId);
check(log.length === 2, 'both rounds are in the log', log);
check((await owner('/round-forms/' + formId, 'DELETE')).s === 409, 'a checklist with rounds cannot be deleted');

await owner('/round-forms/require-scan', 'PUT', { on: true });
check((await owner('/rounds', 'POST', { place_id: due.id, answers: [{ item_id: a.id, result: 'ok' }, { item_id: b.id, result: 'ok' }] })).s === 403, 'with scanning required, a round needs the place code');
await owner('/round-forms/require-scan', 'PUT', { on: false });

/* ---- devices to watch ---- */

const teamId = cat.team_id;
r = await owner('/asset-types', 'POST', { name_ar: 'جهاز مراقبة', name_en: 'Monitor', team_id: teamId });
const typeId = r.j.id;
r = await owner('/assets', 'POST', { tag: 'MON-01', name_ar: 'جهاز مراقبة العناية', name_en: 'ICU monitor', type_id: typeId, department_id: dept.id, risk: 'high', purchase_date: '2016-01-10' });
check(r.s === 200, 'owner adds a device', r);
const quiet = await owner('/assets', 'POST', { tag: 'MON-02', name_ar: 'جهاز مراقبة ثان', name_en: 'Second monitor', type_id: typeId, department_id: dept.id });
for (let i = 0; i < 3; i++) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ emp_no: '30' + i, name: 'موظف', description: 'الجهاز يتوقف', category_id: cat.id, department_id: dept.id, asset_tag: 'MON-01' })) fd.set(k, String(v));
  await fetch(B + '/api/public/tickets', { method: 'POST', body: fd });
}
r = await owner('/assets/risk');
const watch = r.j && r.j.assets.find((a) => a.tag === 'MON-01');
check(r.s === 200 && watch && watch.f90 === 3 && watch.level === 'high', 'a device with three faults in 90 days is on the watch list', r.j);
check(watch && ['faults_90', 'faults_year', 'high_risk', 'old'].every((k) => watch.reasons.some(([x]) => x === k)), 'the list says why', watch && watch.reasons);
check(r.j && !r.j.assets.some((a) => a.tag === 'MON-02') && quiet.s === 200, 'a device without faults is not listed', r.j && r.j.assets.map((a) => a.tag));
check((await tech('/assets/risk')).s === 403, 'technician without an assets role has no watch list');

// who a request can affect, in the sector's words (owner only)
r = await owner('/bootstrap');
check(r.j && r.j.brand.who.one_ar === 'مريض' && r.j.brand.who.all_en === 'patients', 'the default word is patient');
check((await sup('/settings', 'PUT', { who_one_ar: 'طالب' })).s === 403, 'a super admin cannot change the sector words');
check((await owner('/settings', 'PUT', { who_one_ar: 'student' })).s === 400, 'an English word in the Arabic field is refused');
r = await owner('/settings', 'PUT', { who_one_ar: 'طالب', who_all_ar: 'الطلاب', who_one_en: 'a student', who_all_en: 'students' });
check(r.s === 200 && r.j.settings.who_all_ar === 'الطلاب', 'the owner sets the sector words', r);
r = await fetch(B + '/api/bootstrap').then((x) => x.json());
check(r.brand.who.one_ar === 'طالب' && r.brand.who.one_en === 'a student', 'the request form gets the new word', r.brand.who);
await owner('/__sent');
await owner('/reports/mail', 'POST');
{
  const v = ((await owner('/__sent')).j.find((x) => x.via === 'brevo') || { body: { messageVersions: [] } }).body;
  const html = v.htmlContent || (v.messageVersions[0] || {}).htmlContent || '';
  check(/تقرير الجودة/.test(html) && /Quality report/.test(html), 'the monthly report is the quality report', html.slice(0, 200));
}
r = await owner('/settings', 'PUT', { who_one_ar: '', who_all_ar: '', who_one_en: '', who_all_en: '' });
check(r.s === 200 && r.j.settings.who_one_ar === 'مريض' && r.j.settings.who_one_en === 'a patient', 'empty words go back to the default', r.j && r.j.settings);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
