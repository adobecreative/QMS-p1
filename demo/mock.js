// Demo only: an in-memory stand-in for the real server (src/worker.js). Nothing here is saved or sent anywhere.
(function () {
  'use strict';
  const DAY = 86400000;
  const iso = (d) => d.toISOString().slice(0, 10);
  const TODAY = iso(new Date());
  const plus = (n) => iso(new Date(Date.now() + n * DAY));
  const ago = (days, hour) => new Date(Date.now() - days * DAY - hour * 3600000).toISOString();
  const diffDays = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);
  const PDF = Uint8Array.from(atob(window.__DEMO_PDF_B64), (c) => c.charCodeAt(0));
  const TYPES = ['policy', 'program', 'procedure'];
  const ROLES = ['super_admin', 'dept_admin', 'viewer'];

  const db = {
    departments: [
      { id: 1, name_ar: 'السلامة', name_en: 'Safety' },
      { id: 2, name_ar: 'الصيانة', name_en: 'Maintenance' },
      { id: 3, name_ar: 'الأمن', name_en: 'Security' },
    ],
    users: [
      { id: 1, name: 'أحمد سمير', email: 'admin@demo.example', password: 'demo1234', role: 'super_admin', department_id: null, active: 1 },
      { id: 2, name: 'منى خالد', email: 'safety@demo.example', password: 'demo1234', role: 'dept_admin', department_id: 1, active: 1 },
      { id: 3, name: 'يوسف عادل', email: 'viewer@demo.example', password: 'demo1234', role: 'viewer', department_id: null, active: 1 },
    ],
    files: [],
    logs: [],
    settings: { near_days: 30, repeat_days: 7, timezone: 'Africa/Cairo', email_lang: 'ar', sender_name: 'Facilities Management', mail_url: '', mail_token: '' },
  };
  let session = 1;
  let fileSeq = 0;
  let logSeq = 0;
  let deptSeq = 3;
  let userSeq = 3;

  const seed = (department_id, name, file_number, doc_type, issue, expiry, extra) =>
    db.files.push(Object.assign({ id: ++fileSeq, department_id, name, file_number, doc_type, issue_date: issue, expiry_date: expiry, near_days: null, under_review: 0, notify_date: null, pdf_name: file_number + '.pdf', pdf: PDF, updated_at: ago(3, 0) }, extra || {}));
  seed(1, 'خطة الإخلاء والطوارئ', 'FM-SAF-001', 'program', plus(-260), plus(105));
  seed(1, 'فحص أنظمة الإطفاء', 'FM-SAF-007', 'procedure', plus(-385), plus(-20));
  seed(1, 'سياسة تصاريح العمل', 'FM-SAF-011', 'policy', plus(-340), plus(25), { under_review: 1 });
  seed(1, 'سياسة السلامة من الحريق', 'FM-SAF-021', 'policy', plus(-213), plus(152));
  seed(2, 'عقد صيانة المصاعد', 'FM-MNT-014', 'program', plus(-345), plus(20));
  seed(2, 'إجراء الصيانة الوقائية للتكييف', 'FM-MNT-003', 'procedure', plus(-65), plus(300));
  seed(2, 'دليل الهيكل التنظيمي', 'FM-MNT-100', 'policy', plus(-1300), null);
  seed(3, 'إجراء التحكم في الدخول', 'FM-SEC-002', 'procedure', plus(-356), plus(9));
  seed(3, 'سياسة كاميرات المراقبة', 'FM-SEC-005', 'policy', plus(-368), plus(-3));

  const seedLog = (at, user_name, action, entity, label, details) => db.logs.push({ id: ++logSeq, at, user_name, action, entity, label, details: details ? JSON.stringify(details) : null });
  seedLog(ago(6, 5), 'أحمد سمير', 'create', 'department', 'السلامة');
  seedLog(ago(6, 4), 'أحمد سمير', 'create', 'user', 'منى خالد', { role: [null, 'dept_admin'] });
  seedLog(ago(5, 3), 'منى خالد', 'create', 'file', 'خطة الإخلاء والطوارئ (FM-SAF-001)', { pdf: [null, 'FM-SAF-001.pdf'] });
  seedLog(ago(3, 6), 'منى خالد', 'update', 'file', 'سياسة السلامة من الحريق (FM-SAF-021)', { issue_date: [plus(-578), plus(-213)], expiry_date: [plus(-213), plus(152)], pdf: ['fire-policy-old.pdf', 'FM-SAF-021.pdf'] });
  seedLog(ago(2, 2), 'منى خالد', 'update', 'file', 'سياسة تصاريح العمل (FM-SAF-011)', { under_review: [0, 1] });
  seedLog(ago(1, 1), 'system', 'notify', 'system', null, { files: 3, emails: 2 });

  /* ------------------------------ helpers ------------------------------ */
  const J = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'content-type': 'application/json' } });
  const fail = (status, code) => {
    throw { status, code };
  };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
  const optDate = (v) => {
    const s = str(v, 10);
    if (!s) return null;
    if (!isDate(s)) fail(400, 'invalid_date');
    return s;
  };
  const me = () => db.users.find((u) => u.id === session && u.active) || null;
  const userOut = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, department_id: u.department_id, active: !!u.active });
  const canSee = (u, deptId) => u.role !== 'dept_admin' || u.department_id === deptId;
  const canEdit = (u, deptId) => u.role === 'super_admin' || (u.role === 'dept_admin' && u.department_id === deptId);
  const log = (u, action, entity, label, details) => db.logs.push({ id: ++logSeq, at: new Date().toISOString(), user_name: u.name, action, entity, label: label || null, details: details && Object.keys(details).length ? JSON.stringify(details) : null });
  const changes = (before, after, keys) => {
    const out = {};
    for (const k of keys) {
      const a = before[k] === undefined ? null : before[k];
      const b = after[k] === undefined ? null : after[k];
      if (a !== b) out[k] = [a, b];
    }
    return out;
  };
  function statusOf(f) {
    if (f.under_review) return { status: 'review', days: f.expiry_date ? diffDays(f.expiry_date, TODAY) : null };
    if (!f.expiry_date) return { status: 'none', days: null };
    const days = diffDays(f.expiry_date, TODAY);
    if (days < 0) return { status: 'expired', days };
    const near = f.near_days === null ? db.settings.near_days : f.near_days;
    return { status: days <= near ? 'near' : 'valid', days };
  }
  const fileOut = (f) => {
    const st = statusOf(f);
    return { id: f.id, department_id: f.department_id, name: f.name, file_number: f.file_number, doc_type: f.doc_type, issue_date: f.issue_date, expiry_date: f.expiry_date, near_days: f.near_days, under_review: !!f.under_review, notify_date: f.notify_date, has_pdf: !!f.pdf, pdf_name: f.pdf_name, status: st.status, days_left: st.days, updated_at: f.updated_at };
  };
  function fileFields(form) {
    const name = str(form.get('name'), 200);
    if (!name) fail(400, 'name_required');
    const file_number = str(form.get('file_number'), 60);
    if (!file_number) fail(400, 'number_required');
    const doc_type = str(form.get('doc_type'), 20);
    if (!TYPES.includes(doc_type)) fail(400, 'invalid_type');
    const department_id = Number(form.get('department_id'));
    if (!db.departments.some((d) => d.id === department_id)) fail(400, 'department_required');
    const issue_date = optDate(form.get('issue_date'));
    const expiry_date = optDate(form.get('expiry_date'));
    if (issue_date && expiry_date && expiry_date < issue_date) fail(400, 'expiry_before_issue');
    const nearRaw = str(form.get('near_days'), 5);
    const near_days = nearRaw === '' || !expiry_date ? null : Number(nearRaw);
    if (near_days !== null && (!Number.isInteger(near_days) || near_days < 0 || near_days > 3650)) fail(400, 'invalid_near_days');
    return { name, file_number, doc_type, department_id, issue_date, expiry_date, near_days, notify_date: optDate(form.get('notify_date')), under_review: form.get('under_review') === '1' ? 1 : 0 };
  }
  async function readPdf(form) {
    const f = form.get('pdf');
    if (!f || typeof f === 'string' || !f.size) return null;
    if (f.size > 25 * 1024 * 1024) fail(413, 'pdf_too_large');
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (String.fromCharCode.apply(null, bytes.slice(0, 5)) !== '%PDF-') fail(400, 'not_pdf');
    return { bytes, name: str(f.name, 200) || 'file.pdf' };
  }
  async function userFields(body) {
    const name = str(body.name, 100);
    if (!name) fail(400, 'name_required');
    const email = str(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email');
    const role = str(body.role, 20);
    if (!ROLES.includes(role)) fail(400, 'invalid_role');
    let department_id = null;
    if (role === 'dept_admin') {
      department_id = Number(body.department_id);
      if (!db.departments.some((d) => d.id === department_id)) fail(400, 'department_required');
    }
    return { name, email, role, department_id };
  }
  const checkPassword = (p) => {
    if (typeof p !== 'string' || p.length < 8) fail(400, 'weak_password');
    return p;
  };

  /* ------------------------------- routes ------------------------------ */
  async function handle(method, fullPath, body) {
    const [path, query] = fullPath.split('?');
    const seg = path.split('/').filter(Boolean);
    const route = method + ' /' + seg.join('/');
    const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;

    if (route === 'GET /bootstrap') {
      if (window.__demoSync) window.__demoSync(me() ? session : null);
      return J({ needsSetup: false, user: me() ? userOut(me()) : null, defaults: { near_days: db.settings.near_days }, today: TODAY });
    }
    if (route === 'POST /login') {
      const u = db.users.find((x) => x.email === str(body.email, 200).toLowerCase());
      if (!u || !u.active || u.password !== body.password) fail(401, 'invalid_credentials');
      session = u.id;
      return J({ ok: true, user: userOut(u) });
    }
    if (route === 'POST /logout') {
      session = null;
      return J({ ok: true });
    }
    const user = me();
    if (!user) fail(401, 'unauthorized');
    const sa = () => {
      if (user.role !== 'super_admin') fail(403, 'forbidden');
    };

    if (route === 'POST /me/password') {
      if (body.current !== user.password) fail(400, 'wrong_password');
      user.password = checkPassword(body.password);
      return J({ ok: true });
    }

    if (route === 'GET /departments') {
      const list = db.departments.filter((d) => canSee(user, d.id)).map((d) => Object.assign({}, d, { file_count: db.files.filter((f) => f.department_id === d.id).length }));
      return J({ departments: list });
    }
    if (seg[0] === 'departments') {
      sa();
      const names = () => {
        const n = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100) };
        if (!n.name_ar || !n.name_en) fail(400, 'name_required');
        return n;
      };
      if (route === 'POST /departments') {
        const d = Object.assign({ id: ++deptSeq }, names());
        db.departments.push(d);
        log(user, 'create', 'department', d.name_ar);
        return J({ ok: true, id: d.id });
      }
      const d = db.departments.find((x) => x.id === id);
      if (!d) fail(404, 'not_found');
      if (method === 'PUT') {
        const n = names();
        log(user, 'update', 'department', n.name_ar, changes(d, n, ['name_ar', 'name_en']));
        Object.assign(d, n);
        return J({ ok: true });
      }
      if (method === 'DELETE') {
        if (db.files.some((f) => f.department_id === id)) fail(409, 'department_has_files');
        if (db.users.some((u) => u.department_id === id)) fail(409, 'department_has_users');
        db.departments = db.departments.filter((x) => x.id !== id);
        log(user, 'delete', 'department', d.name_ar);
        return J({ ok: true });
      }
    }

    if (route === 'GET /files') {
      const list = db.files.filter((f) => canSee(user, f.department_id)).sort((a, b) => a.name.localeCompare(b.name));
      return J({ files: list.map(fileOut), today: TODAY });
    }
    if (route === 'POST /files') {
      if (user.role === 'viewer') fail(403, 'forbidden');
      const data = fileFields(body);
      if (!canEdit(user, data.department_id)) fail(403, 'forbidden');
      const pdf = await readPdf(body);
      if (!pdf) fail(400, 'pdf_required');
      const f = Object.assign({ id: ++fileSeq, pdf: pdf.bytes, pdf_name: pdf.name, updated_at: new Date().toISOString() }, data);
      db.files.push(f);
      log(user, 'create', 'file', f.name + ' (' + f.file_number + ')', { pdf: [null, pdf.name] });
      return J({ ok: true, id: f.id });
    }
    if (seg[0] === 'files' && id !== null && seg.length === 2) {
      const f = db.files.find((x) => x.id === id);
      if (!f || !canSee(user, f.department_id)) fail(404, 'not_found');
      if (!canEdit(user, f.department_id)) fail(403, 'forbidden');
      if (method === 'PUT') {
        const data = fileFields(body);
        if (!canEdit(user, data.department_id)) fail(403, 'forbidden');
        const pdf = await readPdf(body);
        const diff = changes(f, data, ['name', 'file_number', 'doc_type', 'department_id', 'issue_date', 'expiry_date', 'near_days', 'under_review', 'notify_date']);
        if (pdf) {
          diff.pdf = [f.pdf_name, pdf.name];
          f.pdf = pdf.bytes;
          f.pdf_name = pdf.name;
        }
        Object.assign(f, data, { updated_at: new Date().toISOString() });
        log(user, 'update', 'file', f.name + ' (' + f.file_number + ')', diff);
        return J({ ok: true });
      }
      if (method === 'DELETE') {
        db.files = db.files.filter((x) => x.id !== id);
        log(user, 'delete', 'file', f.name + ' (' + f.file_number + ')');
        return J({ ok: true });
      }
    }

    if (seg[0] === 'users') {
      sa();
      if (route === 'GET /users') return J({ users: db.users.map(userOut) });
      if (route === 'POST /users') {
        const data = await userFields(body);
        if (db.users.some((u) => u.email === data.email)) fail(409, 'email_taken');
        const u = Object.assign({ id: ++userSeq, password: checkPassword(body.password), active: 1 }, data);
        db.users.push(u);
        log(user, 'create', 'user', u.name, { role: [null, u.role] });
        return J({ ok: true, id: u.id });
      }
      const target = db.users.find((u) => u.id === id);
      if (!target) fail(404, 'not_found');
      if (method === 'PUT') {
        const data = await userFields(body);
        data.active = body.active === false ? 0 : 1;
        if (id === user.id && (data.role !== 'super_admin' || !data.active)) fail(400, 'cannot_change_self');
        if (db.users.some((u) => u.email === data.email && u.id !== id)) fail(409, 'email_taken');
        const diff = changes(target, data, ['name', 'email', 'role', 'department_id', 'active']);
        if (body.password) {
          target.password = checkPassword(body.password);
          diff.password = ['***', '***'];
        }
        Object.assign(target, data);
        log(user, 'update', 'user', target.name, diff);
        return J({ ok: true });
      }
      if (method === 'DELETE') {
        if (id === user.id) fail(400, 'cannot_change_self');
        db.users = db.users.filter((u) => u.id !== id);
        log(user, 'delete', 'user', target.name);
        return J({ ok: true });
      }
    }

    if (route === 'GET /logs') {
      sa();
      const before = Number(new URLSearchParams(query || '').get('before')) || Infinity;
      return J({ logs: db.logs.filter((l) => l.id < before).sort((a, b) => b.id - a.id).slice(0, 100) });
    }

    if (seg[0] === 'settings') {
      sa();
      const out = () => ({ near_days: db.settings.near_days, repeat_days: db.settings.repeat_days, timezone: db.settings.timezone, email_lang: db.settings.email_lang, sender_name: db.settings.sender_name, mail_url: db.settings.mail_url, mail_token_set: !!db.settings.mail_token });
      if (route === 'GET /settings') return J({ settings: out() });
      if (route === 'PUT /settings') {
        const next = { near_days: Number(body.near_days), repeat_days: Number(body.repeat_days), timezone: str(body.timezone, 60), email_lang: body.email_lang === 'en' ? 'en' : 'ar', sender_name: str(body.sender_name, 80) || 'Facilities Management', mail_url: str(body.mail_url, 500) };
        if (!Number.isInteger(next.near_days) || next.near_days < 0 || next.near_days > 3650) fail(400, 'invalid_near_days');
        if (!Number.isInteger(next.repeat_days) || next.repeat_days < 0 || next.repeat_days > 365) fail(400, 'invalid_repeat_days');
        if (next.mail_url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(next.mail_url)) fail(400, 'invalid_mail_url');
        const diff = changes(db.settings, next, Object.keys(next));
        if (body.mail_token) {
          db.settings.mail_token = String(body.mail_token);
          diff.mail_token = ['***', '***'];
        }
        Object.assign(db.settings, next);
        log(user, 'update', 'settings', null, diff);
        return J({ ok: true, settings: out() });
      }
      if (method === 'POST') fail(502, 'demo'); // the demo never sends real email
    }
    fail(404, 'not_found');
  }

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (url.indexOf('/api/') !== 0) return realFetch(input, init);
    const o = init || {};
    await new Promise((r) => setTimeout(r, 120));
    let body = null;
    if (typeof FormData !== 'undefined' && o.body instanceof FormData) body = o.body;
    else if (typeof o.body === 'string') {
      try {
        body = JSON.parse(o.body);
      } catch (e) {
        body = {};
      }
    }
    try {
      return await handle((o.method || 'GET').toUpperCase(), url.slice(4), body || {});
    } catch (e) {
      return e && e.status ? J({ error: e.code }, e.status) : J({ error: 'server_error' }, 500);
    }
  };

  // The reader asks for the PDF bytes directly (a copy, because PDF.js takes ownership of the buffer).
  window.__demoPdf = (id) => {
    const f = db.files.find((x) => x.id === id);
    return f && f.pdf ? f.pdf.slice() : new Uint8Array();
  };
  window.__demoSetUser = (id) => {
    session = id;
  };

  // Hash updates can be refused inside some embedded viewers; the app works without them.
  const replaceState = history.replaceState.bind(history);
  history.replaceState = function () {
    try {
      replaceState.apply(null, arguments);
    } catch (e) {
      /* ignore */
    }
  };
})();
