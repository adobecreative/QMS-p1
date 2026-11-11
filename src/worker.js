import { handleMeetings, runMeetingJobs } from './systems/meetings.js';
import { handleCheckin } from './systems/checkin.js';
import { RECOVERY_RE, canEditDept, canSeeDept, checkEmail, checkOrigin, checkPassword, cleanRecovery, createSession, failedLogin, getUser, hashPassword, loginFrom, needs2fa, readJson, requireDocs, requireRole, sessionCookie, totpCheck, userOut, verifyPassword, withAccess } from './lib/auth.js';
import { AUTO_BACKUP_PREFIX, emailBackup, fullBackupData, isAutoBackupTick, runAutoBackup } from './lib/backup.js';
import { ADMIN_ROLES, ASSETS_ROLES, CHALLENGE_MINUTES, DEFAULT_SETTINGS, DESK_ROLES, DOCS_ROLES, JOB_TITLES, MAX_LOGO_BYTES, MEETINGS_ROLES, QUALITY_ROLES, ROLES, ROUNDS_ROLES, SESSION_DAYS, SLA_KEYS, TWO_FA_LEVELS, appName, brandOut, logoType } from './lib/config.js';
import { changes, ensureSchema, getSettings, logStmt, setSettingStmt } from './lib/db.js';
import { READONLY_OPEN, licenseOut, licenseState } from './lib/license.js';
import { EMAIL_TEXT, bothLangs, emailHeader, sendMail } from './lib/mail.js';
import { handlePush } from './lib/push.js';
import { HttpError, RESETS_PER_HOUR, RESET_MINUTES, checkLang, escHtml, fail, isTimezone, json, normText, nowIso, sha256Hex, str, toHex, todayIn } from './lib/util.js';
import { handleTwoFactor } from './systems/account.js';
import { handleApiKeys, handleIntegration } from './systems/api.js';
import { handleAssets, runPmJobs } from './systems/assets.js';
import { handleContracts, runContractReminders } from './systems/contracts.js';
import { addDemo, checkChapter, demoIds, fileOut, readFileFields, readPdf, readText, removeDemo, runReminders, textStmt } from './systems/docs.js';
import { handleHealth, logServerError } from './systems/health.js';
import { handleInventory, runStockReminders } from './systems/inventory.js';
import { handleCompliance, handleReportMail, handleReports, runMonthlyReport } from './systems/reports.js';
import { handleHome } from './systems/home.js';
import { handleFmsLink, handlePortalDocs, handlePortalUsers, portalDocsOn, runFmsSync } from './systems/fmslink.js';
import { handleQuality, seedChapters } from './systems/quality.js';
import { portalSignIn } from './systems/sso.js';
import { handleCapa } from './systems/capa.js';
import { handleOvr, handlePublicOvr, runOvrReminders } from './systems/ovr.js';
import { handleKpis, refreshAutoKpis, snapshotReadiness } from './systems/kpis.js';
import { handleRounds, runRoundReminders } from './systems/rounds.js';
import { handlePublicTickets, handleTickets, runTicketAlerts } from './systems/tickets.js';


// Settings only the system owner may change.
const OWNER_SETTINGS = ['timezone', 'sender_name', 'mail_url', 'mail_provider', 'mail_from', 'mail_reply_to', 'mail_token', 'brevo_key', 'org_name_ar', 'org_name_en', 'who_one_ar', 'who_all_ar', 'who_one_en', 'who_all_en', 'support_email', 'ai_enabled', 'ai_daily_limit', 'require_2fa', 'backup_email'];

async function handleApi(request, env, url, ctx) {
  const method = request.method;
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const route = `${method} /${seg.join('/')}`;
  const id = seg[1] !== undefined && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;
  if (method !== 'GET' && method !== 'HEAD') checkOrigin(request, url);

  // Without a valid license for this site only the page that says so opens.
  const license = await licenseState(env, url.hostname);
  if (license.locked && route !== 'GET /bootstrap' && route !== 'GET /logo' && route !== 'HEAD /logo') fail(403, 'unlicensed');
  if (license.readonly && method !== 'GET' && method !== 'HEAD' && !READONLY_OPEN.includes(route)) fail(403, 'license_expired');

  /* ---- public: bootstrap, first-run setup, login ---- */

  if (route === 'GET /bootstrap') {
    const user = await getUser(request, env);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const settings = await getSettings(env);
    // Only the system owner (first account) is told it is the owner; nobody else sees the flag.
    const isOwnerUser = user ? user.id === (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id : false;
    return json({
      needsSetup: count.n === 0,
      user: user ? Object.assign(userOut(user), isOwnerUser ? { is_owner: true } : {}, portalDocsOn(settings) ? { portal_docs: true } : {}) : null,
      defaults: { near_days: settings.near_days },
      today: todayIn(settings.timezone),
      brand: brandOut(settings),
      license: licenseOut(license, false),
      // With the operations system linked, its address is the Fikra portal: the header's systems button goes there.
      portal_url: user && settings.link_on === '1' && settings.link_url ? settings.link_url : '',
    });
  }

  // The logo is public: the login page shows it before anyone signs in.
  if (route === 'GET /logo' || route === 'HEAD /logo') {
    const settings = await getSettings(env);
    const obj = settings.logo_key ? await env.FILES.get(settings.logo_key) : null;
    if (!obj) fail(404, 'not_found');
    const versioned = url.searchParams.get('v') === settings.logo_ver;
    return new Response(method === 'HEAD' ? null : obj.body, {
      headers: {
        'content-type': settings.logo_type || 'application/octet-stream',
        'content-length': String(obj.size),
        'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        // An SVG opened on its own must not run anything.
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
        'content-disposition': 'inline',
      },
    });
  }

  if (route === 'POST /setup') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (count.n > 0) fail(403, 'already_set_up');
    const body = await readJson(request);
    const name = str(body.name, 100);
    const name_en = str(body.name_en, 100);
    if (!name || !name_en) fail(400, 'name_required');
    const email = checkEmail(body.email);
    const hash = await hashPassword(checkPassword(body.password));
    const res = await env.DB.prepare("INSERT INTO users (name, name_en, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 'super_admin', 1, ?)").bind(name, name_en, email, hash, nowIso()).run();
    const userId = res.meta.last_row_id;
    await env.DB.batch([setSettingStmt(env, 'site_url', url.origin), logStmt(env, { id: userId, name }, 'create', 'user', userId, name, { role: [null, 'super_admin'] })]);
    const token = await createSession(env, userId);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  }

  if (route === 'POST /login') {
    const body = await readJson(request);
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!u || !u.active) {
      // The same work as a real check, so the answer time does not tell whether the email exists.
      await hashPassword(password || 'x');
      fail(401, 'invalid_credentials');
    }
    if (u.locked_until && u.locked_until > nowIso()) fail(429, 'account_locked');
    if (!(await verifyPassword(password, u.password_hash))) {
      await failedLogin(env, request, u, 'password');
      fail(401, 'invalid_credentials');
    }
    // With two-step sign-in on, the password only earns a 5-minute ticket for the code page.
    if (u.totp_on) {
      const ticket = toHex(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM login_challenges WHERE expires_at < ? OR user_id = ?').bind(nowIso(), u.id),
        env.DB.prepare('INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(ticket), u.id, new Date(Date.now() + CHALLENGE_MINUTES * 60000).toISOString()),
      ]);
      return json({ ok: true, need_code: true, ticket });
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(u.id),
      logStmt(env, { id: u.id, name: u.name }, 'login', 'user', u.id, u.name, loginFrom(request)),
    ]);
    const token = await createSession(env, u.id);
    return json({ ok: true, user: userOut(withAccess(u)) }, 200, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  }

  // The second step: a code from the app, or a recovery code (each works once).
  if (route === 'POST /login/2fa') {
    const body = await readJson(request);
    const ticket = str(body.ticket, 100);
    if (!/^[0-9a-f]{64}$/.test(ticket)) fail(400, 'invalid_token');
    const ch = await env.DB.prepare(
      'SELECT c.token_hash, u.* FROM login_challenges c JOIN users u ON u.id = c.user_id WHERE c.token_hash = ? AND c.expires_at > ? AND u.active = 1 AND u.totp_on = 1',
    )
      .bind(await sha256Hex(ticket), nowIso())
      .first();
    if (!ch) fail(401, 'login_expired');
    if (ch.locked_until && ch.locked_until > nowIso()) {
      await env.DB.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(ch.token_hash).run();
      fail(429, 'account_locked');
    }
    const raw = str(body.code, 40).replace(/\s+/g, '');
    let method = null;
    const step = await totpCheck(ch.totp_secret, raw, ch.totp_step);
    if (step) {
      // Taken in one statement, so the same code sent twice at once signs in only once.
      const took = await env.DB.prepare('UPDATE users SET totp_step = ? WHERE id = ? AND totp_step < ?').bind(step, ch.id, step).run();
      if (took.meta.changes) method = 'totp';
    } else if (RECOVERY_RE.test(cleanRecovery(raw))) {
      const used = await env.DB.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .bind(nowIso(), ch.id, await sha256Hex('rc:' + cleanRecovery(raw)))
        .run();
      if (used.meta.changes) method = 'recovery';
    }
    if (!method) {
      await failedLogin(env, request, ch, 'code');
      fail(401, 'wrong_code');
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(ch.token_hash),
      env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(ch.id),
      logStmt(env, { id: ch.id, name: ch.name }, 'login', 'user', ch.id, ch.name, { ...loginFrom(request), method }),
    ]);
    const left = method === 'recovery' ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(ch.id).first()).n : null;
    const token = await createSession(env, ch.id);
    return json({ ok: true, recovery_left: left }, 200, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  }

  // Arriving from the Fikra portal, already signed in there (see systems/sso.js).
  if (route === 'POST /sso') return portalSignIn(request, env, url, (await readJson(request)).token);
  // A member checking in to a committee session with their link or the session's QR code (systems/checkin.js).
  if (seg[0] === 'checkin' && seg.length === 2) return handleCheckin(request, env, method, seg[1]);

  /* ---- forgot password (public) ---- */

  // Always answers the same way, so it never tells anyone whether an email is registered.
  if (route === 'POST /password/forgot') {
    const body = await readJson(request);
    const email = str(body.email, 200).toLowerCase();
    const u = email ? await env.DB.prepare('SELECT id, name, name_en, email, active FROM users WHERE email = ?').bind(email).first() : null;
    if (u && u.active) {
      const since = new Date(Date.now() - 3600000).toISOString();
      const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?').bind(u.id, since).first();
      if (recent.n < RESETS_PER_HOUR) {
        const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const now = nowIso();
        await env.DB.batch([
          env.DB.prepare('DELETE FROM password_resets WHERE expires_at < ?').bind(now),
          env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(
            await sha256Hex(token), u.id, new Date(Date.now() + RESET_MINUTES * 60000).toISOString(), now),
        ]);
        const link = `${url.origin}/#/reset/${token}`;
        const mail = bothLangs(await getSettings(env), (s) => {
          const L = EMAIL_TEXT[s.email_lang];
          const app = appName(s, s.email_lang);
          const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${L.dir === 'rtl' ? 'right' : 'left'}">${emailHeader(s)}<p style="font-size:15px">${escHtml(L.resetHello(s.email_lang === 'en' ? u.name_en || u.name : u.name))}</p><p style="font-size:15px">${escHtml(L.resetBody)}</p><p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#8a6420;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(L.resetButton)}</a></p><p style="font-size:13px;color:#6e6553">${escHtml(L.resetNote(RESET_MINUTES))}</p><p style="font-size:12px;color:#6e6553;word-break:break-all" dir="ltr">${escHtml(link)}</p><p style="margin:16px 0 0;font-size:12px;color:#6e6553">${escHtml(L.footer(app))}</p></div>`;
          return { subject: L.resetSubject(app), html };
        });
        const result = await sendMail(await getSettings(env), [{ to: u.email, ...mail }]);
        await logStmt(env, { id: u.id, name: u.name }, result.ok ? 'reset_request' : 'reset_failed', 'user', u.id, u.name, result.ok ? null : { error: result.error }).run();
      }
    }
    return json({ ok: true });
  }

  if (route === 'POST /password/reset') {
    const body = await readJson(request);
    const token = str(body.token, 100);
    if (!/^[0-9a-f]{64}$/.test(token)) fail(400, 'invalid_token');
    const row = await env.DB.prepare(
      `SELECT r.token_hash, r.user_id, u.name FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ? AND r.expires_at > ? AND u.active = 1`,
    )
      .bind(await sha256Hex(token), nowIso())
      .first();
    if (!row) fail(400, 'invalid_token');
    const hash = await hashPassword(checkPassword(body.password));
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').bind(hash, row.user_id),
      // Every link for this user stops working, and every device is signed out.
      env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(row.user_id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
      logStmt(env, { id: row.user_id, name: row.name }, 'reset', 'user', row.user_id, row.name),
    ]);
    return json({ ok: true });
  }

  // Incident reports: the form works signed in or with an employee number (a place's QR code).
  if (seg[0] === 'public' && seg[1] === 'ovr') return handlePublicOvr(request, env, url, seg, method, ctx);
  // Maintenance requests from the public page (no account).
  if (seg[0] === 'public') return handlePublicTickets(request, env, url, seg, method, ctx);

  // Other systems, with an API key instead of a signed-in user.
  if (seg[0] === 'v1') return handleIntegration(request, env, url, seg, method, ctx);

  /* ---- everything below needs a signed-in user ---- */

  const user = await getUser(request, env);

  if (route === 'POST /logout') {
    if (user) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }
  if (!user) fail(401, 'unauthorized');

  if (seg[0] === 'me' && seg[1] === '2fa') return handleTwoFactor(request, env, url, seg, method, user);
  if (user.must_2fa) fail(403, 'two_factor_required');
  if (seg[0] === 'me' && seg[1] === 'push') return handlePush(request, env, url, seg, method, user);

  if (route === 'POST /me/password') {
    const body = await readJson(request);
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
    if (!(await verifyPassword(typeof body.current === 'string' ? body.current : '', row.password_hash))) fail(400, 'wrong_password');
    const hash = await hashPassword(checkPassword(body.password));
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(user.id, user.token_hash),
      env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id),
    ]);
    return json({ ok: true });
  }

  /* ---- departments ---- */

  if (route === 'GET /departments') {
    const sql = `SELECT d.id, d.name_ar, d.name_en, d.is_team, d.auto_assign, d.cost_center,
                        (SELECT COUNT(*) FROM files f WHERE f.department_id = d.id) AS file_count
                   FROM departments d ${user.docs === 'dept_admin' && url.searchParams.get('for') === 'docs' ? 'WHERE d.id = ?' : ''} ORDER BY d.id`;
    const stmt = env.DB.prepare(sql);
    const { results } = await (user.docs === 'dept_admin' && url.searchParams.get('for') === 'docs' ? stmt.bind(user.department_id ?? 0) : stmt).all();
    return json({ departments: results });
  }

  if (seg[0] === 'departments' && method !== 'GET') {
    requireRole(user, ...ADMIN_ROLES);
    // The ERP's cost center code: letters, digits and - . / only.
    const costCenter = (body) => {
      const v = str(body.cost_center, 30);
      if (v && !/^[\w./-]+$/.test(v)) fail(400, 'invalid_cost_center');
      return v || null;
    };
    if (route === 'POST /departments') {
      const body = await readJson(request);
      const name_ar = str(body.name_ar, 100);
      const name_en = str(body.name_en, 100);
      if (!name_ar || !name_en) fail(400, 'name_required');
      const res = await env.DB.prepare('INSERT INTO departments (name_ar, name_en, is_team, auto_assign, cost_center, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(name_ar, name_en, body.is_team ? 1 : 0, body.is_team && body.auto_assign ? 1 : 0, costCenter(body), nowIso())
        .run();
      await logStmt(env, user, 'create', 'department', res.meta.last_row_id, name_ar).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    if (id === null) fail(404, 'not_found');
    const dept = await env.DB.prepare('SELECT * FROM departments WHERE id = ?').bind(id).first();
    if (!dept) fail(404, 'not_found');
    if (method === 'PUT') {
      const body = await readJson(request);
      const next = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100), is_team: body.is_team ? 1 : 0, auto_assign: body.is_team && body.auto_assign ? 1 : 0, cost_center: costCenter(body) };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      // A team that still owns problem types or technicians stays a team.
      if (dept.is_team && !next.is_team) {
        const used = await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM ticket_categories WHERE team_id = ?1) + (SELECT COUNT(*) FROM users WHERE department_id = ?1 AND role NOT IN ('super_admin', 'systems_admin') AND desk_role IN ('technician', 'supervisor')) AS n",
        ).bind(id).first();
        if (used.n > 0) fail(409, 'team_in_use');
      }
      await env.DB.batch([
        env.DB.prepare('UPDATE departments SET name_ar = ?, name_en = ?, is_team = ?, auto_assign = ?, cost_center = ? WHERE id = ?').bind(next.name_ar, next.name_en, next.is_team, next.auto_assign, next.cost_center, id),
        logStmt(env, user, 'update', 'department', id, next.name_ar, changes(dept, next, ['name_ar', 'name_en', 'is_team', 'auto_assign', 'cost_center'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const files = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE department_id = ?').bind(id).first();
      if (files.n > 0) fail(409, 'department_has_files');
      const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE department_id = ?').bind(id).first();
      if (users.n > 0) fail(409, 'department_has_users');
      const used = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM tickets WHERE team_id = ?1 OR requester_dept_id = ?1) + (SELECT COUNT(*) FROM ticket_categories WHERE team_id = ?1)
              + (SELECT COUNT(*) FROM staff WHERE department_id = ?1) + (SELECT COUNT(*) FROM locations WHERE department_id = ?1) AS n`,
      ).bind(id).first();
      if (used.n > 0) fail(409, 'department_in_use');
      await env.DB.batch([env.DB.prepare('DELETE FROM departments WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'department', id, dept.name_ar)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  /* ---- file types ---- */

  if (seg[0] === 'files' || seg[0] === 'doc-types') requireDocs(user);
  if (route === 'GET /doc-types') {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.key, t.name_ar, t.name_en, (SELECT COUNT(*) FROM files f WHERE f.doc_type = t.key) AS file_count
         FROM doc_types t ORDER BY t.id`,
    ).all();
    // The CBAHI chapters a file can be filed under (shown in the file form).
    await seedChapters(env, await getSettings(env));
    const { results: chapters } = await env.DB.prepare("SELECT code, name_ar, name_en FROM std_chapters WHERE framework = 'cbahi' AND active = 1 ORDER BY sort, code").all();
    return json({ doc_types: results, chapters });
  }

  if (seg[0] === 'doc-types' && method !== 'GET') {
    requireDocs(user, 'admin');
    const readNames = async () => {
      const body = await readJson(request);
      const next = { name_ar: str(body.name_ar, 100), name_en: str(body.name_en, 100) };
      if (!next.name_ar || !next.name_en) fail(400, 'name_required');
      return next;
    };
    if (route === 'POST /doc-types') {
      const next = await readNames();
      const key = 't' + toHex(crypto.getRandomValues(new Uint8Array(6)));
      const res = await env.DB.prepare('INSERT INTO doc_types (key, name_ar, name_en, created_at) VALUES (?, ?, ?, ?)').bind(key, next.name_ar, next.name_en, nowIso()).run();
      await logStmt(env, user, 'create', 'doc_type', res.meta.last_row_id, next.name_ar).run();
      return json({ ok: true, id: res.meta.last_row_id, key });
    }
    if (id === null) fail(404, 'not_found');
    const type = await env.DB.prepare('SELECT * FROM doc_types WHERE id = ?').bind(id).first();
    if (!type) fail(404, 'not_found');
    if (method === 'PUT') {
      const next = await readNames();
      await env.DB.batch([
        env.DB.prepare('UPDATE doc_types SET name_ar = ?, name_en = ? WHERE id = ?').bind(next.name_ar, next.name_en, id),
        logStmt(env, user, 'update', 'doc_type', id, next.name_ar, changes(type, next, ['name_ar', 'name_en'])),
      ]);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      const files = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE doc_type = ?').bind(type.key).first();
      if (files.n > 0) fail(409, 'type_has_files');
      await env.DB.batch([env.DB.prepare('DELETE FROM doc_types WHERE id = ?').bind(id), logStmt(env, user, 'delete', 'doc_type', id, type.name_ar)]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  /* ---- files ---- */

  if (route === 'GET /files') {
    const settings = await getSettings(env);
    const today = todayIn(settings.timezone);
    const stmt = env.DB.prepare(`SELECT * FROM files ${user.docs === 'dept_admin' ? 'WHERE department_id = ?' : ''} ORDER BY name`);
    const [{ results }, { results: ackRows }, { results: mine }, total] = await Promise.all([
      (user.docs === 'dept_admin' ? stmt.bind(user.department_id ?? 0) : stmt).all(),
      // Only current-PDF acknowledgements by active users count.
      env.DB.prepare(
        `SELECT a.file_id, COUNT(*) AS n FROM acks a
           JOIN files f ON f.id = a.file_id AND f.pdf_key = a.pdf_key
           JOIN users u ON u.id = a.user_id AND u.active = 1 AND (u.role IN ('super_admin', 'systems_admin') OR u.docs_role <> 'none')
          WHERE u.id <> (SELECT MIN(id) FROM users)
          GROUP BY a.file_id`,
      ).all(),
      env.DB.prepare('SELECT a.file_id, a.at FROM acks a JOIN files f ON f.id = a.file_id AND f.pdf_key = a.pdf_key WHERE a.user_id = ?').bind(user.id).all(),
      // Everyone who can open Document Control is expected to read its files.
      env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND (role IN ('super_admin', 'systems_admin') OR docs_role <> 'none') AND id <> (SELECT MIN(id) FROM users)").first(),
    ]);
    const counts = new Map(ackRows.map((r) => [r.file_id, r.n]));
    const myAcks = new Map(mine.map((r) => [r.file_id, r.at]));
    const files = results.map((f) => ({
      ...fileOut(f, today, settings),
      acked_at: myAcks.get(f.id) || null,
      ack_count: counts.get(f.id) || 0,
      ack_total: total.n,
    }));
    return json({ files, today });
  }

  // Search inside the PDFs. Names and numbers are matched in the browser; this returns the files whose
  // text contains the words, with the page and a short snippet. Same visibility as GET /files.
  if (route === 'GET /files/search') {
    const q = normText(url.searchParams.get('q')).slice(0, 100);
    const qc = q.replace(/\s+/g, '');
    if ([...qc].length < 2) return json({ results: [] });
    // Some PDFs store Arabic in visual (reversed) order, so also look for the reversed word.
    const rev = /[\u0600-\u06FF]/.test(qc) ? [...qc].reverse().join('') : qc;
    const deptOnly = user.docs === 'dept_admin';
    const { results } = await env.DB.prepare(
      `WITH m AS (
         SELECT t.file_id, t.body, t.compact,
                CASE WHEN instr(t.compact, ?1) > 0 THEN instr(t.compact, ?1) ELSE instr(t.compact, ?2) END AS p,
                instr(t.body, ?3) AS b
           FROM file_texts t JOIN files f ON f.id = t.file_id AND f.pdf_key = t.pdf_key
          WHERE (instr(t.compact, ?1) > 0 OR instr(t.compact, ?2) > 0) ${deptOnly ? 'AND f.department_id = ?4' : ''}
          LIMIT 300)
       SELECT file_id,
              length(substr(compact, 1, p)) - length(replace(substr(compact, 1, p), char(12), '')) + 1 AS page,
              CASE WHEN b > 0 THEN substr(body, max(1, b - 60), 140 + length(?3)) ELSE '' END AS snippet
         FROM m`,
    )
      .bind(...[qc, rev, q, ...(deptOnly ? [user.department_id ?? 0] : [])])
      .all();
    // Keep only the snippet's part on the matched page.
    const onPage = (snip) => snip.split('\f').find((part) => part.includes(q)) || '';
    return json({ results: results.map((r) => ({ id: r.file_id, page: r.page, snippet: onPage(r.snippet) })) });
  }

  // Files whose current PDF has not been read for search yet (uploaded before search existed).
  // The browser of someone who manages them reads them in the background and sends the text.
  if (route === 'GET /files/text-missing') {
    if (user.docs !== 'admin' && user.docs !== 'dept_admin') return json({ files: [] });
    const deptOnly = user.docs === 'dept_admin';
    const stmt = env.DB.prepare(
      `SELECT f.id, f.pdf_key FROM files f LEFT JOIN file_texts t ON t.file_id = f.id AND t.pdf_key = f.pdf_key
        WHERE f.pdf_key IS NOT NULL AND t.file_id IS NULL ${deptOnly ? 'AND f.department_id = ?' : ''} ORDER BY f.id LIMIT 500`,
    );
    const { results } = await (deptOnly ? stmt.bind(user.department_id ?? 0) : stmt).all();
    return json({ files: results });
  }

  if (route === 'POST /files') {
    requireDocs(user, 'admin', 'dept_admin');
    const form = await request.formData().catch(() => fail(400, 'bad_request'));
    const data = readFileFields(form);
    if (!canEditDept(user, data.department_id)) fail(403, 'forbidden');
    const dept = await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(data.department_id).first();
    if (!dept) fail(400, 'department_required');
    if (!(await env.DB.prepare('SELECT id FROM doc_types WHERE key = ?').bind(data.doc_type).first())) fail(400, 'invalid_type');
    await checkChapter(env, data.chapter);
    const pdf = await readPdf(form);
    if (!pdf) fail(400, 'pdf_required');
    const text = readText({ body: form.get('text_body'), compact: form.get('text_compact') });
    const key = `pdf/${crypto.randomUUID()}.pdf`;
    await env.FILES.put(key, pdf.bytes, { httpMetadata: { contentType: 'application/pdf' } });
    try {
      const now = nowIso();
      const res = await env.DB.prepare(
        `INSERT INTO files (department_id, name, name_en, file_number, doc_type, chapter, issue_date, expiry_date, near_days, under_review, notify_date, pdf_key, pdf_name, pdf_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(data.department_id, data.name, data.name_en, data.file_number, data.doc_type, data.chapter, data.issue_date, data.expiry_date, data.near_days, data.under_review, data.notify_date, key, pdf.name, pdf.size, now, now)
        .run();
      const fileId = res.meta.last_row_id;
      if (text) await textStmt(env, fileId, key, text).run();
      await logStmt(env, user, 'create', 'file', fileId, `${data.name} (${data.file_number})`, { pdf: [null, pdf.name] }).run();
      return json({ ok: true, id: fileId });
    } catch (e) {
      await env.FILES.delete(key);
      throw e;
    }
  }

  if (seg[0] === 'files' && id !== null) {
    const file = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
    if (!file || !canSeeDept(user, file.department_id)) fail(404, 'not_found');

    if (route === `GET /files/${id}/pdf`) {
      const obj = file.pdf_key ? await env.FILES.get(file.pdf_key) : null;
      if (!obj) fail(404, 'not_found');
      return new Response(obj.body, {
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(obj.size),
          'content-disposition': 'inline',
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    // Anyone who can open the file confirms they have read its current PDF.
    if (route === `POST /files/${id}/ack`) {
      if (!file.pdf_key) fail(400, 'pdf_required');
      const at = nowIso();
      await env.DB.prepare(
        `INSERT INTO acks (file_id, user_id, pdf_key, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(file_id, user_id) DO UPDATE SET pdf_key = excluded.pdf_key, at = excluded.at`,
      )
        .bind(id, user.id, file.pdf_key, at)
        .run();
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM acks a JOIN users u ON u.id = a.user_id AND u.active = 1
          WHERE a.file_id = ? AND a.pdf_key = ? AND u.id <> (SELECT MIN(id) FROM users)`,
      )
        .bind(id, file.pdf_key)
        .first();
      return json({ ok: true, acked_at: at, ack_count: count.n });
    }

    // Search text for the current PDF, read by the browser of someone who manages the file.
    if (route === `PUT /files/${id}/text`) {
      if (!canEditDept(user, file.department_id)) fail(403, 'forbidden');
      const body = await readJson(request);
      const text = readText(body);
      if (!text) fail(400, 'bad_request');
      if (!file.pdf_key || body.pdf_key !== file.pdf_key) fail(409, 'pdf_changed');
      await textStmt(env, id, file.pdf_key, text).run();
      return json({ ok: true });
    }

    // Who has and has not read the current PDF. For the people who manage this file.
    // The system owner (first account) is hidden from everyone, so it is left out of these lists.
    if (route === `GET /files/${id}/acks`) {
      if (!canEditDept(user, file.department_id)) fail(403, 'forbidden');
      const { results } = await env.DB.prepare(
        `SELECT u.id, u.name, u.name_en, u.email, u.role, u.department_id, a.at
           FROM users u LEFT JOIN acks a ON a.user_id = u.id AND a.file_id = ? AND a.pdf_key = ?
          WHERE u.active = 1 AND (u.role IN ('super_admin', 'systems_admin') OR u.docs_role <> 'none') AND u.id <> (SELECT MIN(id) FROM users)
          ORDER BY (a.at IS NULL), u.name`,
      )
        .bind(id, file.pdf_key || '')
        .all();
      return json({ users: results.map((r) => ({ id: r.id, name: r.name, name_en: r.name_en || r.name, email: r.email, role: r.role, department_id: r.department_id ?? null, acked_at: r.at || null })) });
    }

    if (seg.length === 2 && method === 'PUT') {
      if (!canEditDept(user, file.department_id)) fail(403, 'forbidden');
      const form = await request.formData().catch(() => fail(400, 'bad_request'));
      const data = readFileFields(form);
      if (!canEditDept(user, data.department_id)) fail(403, 'forbidden');
      if (data.department_id !== file.department_id) {
        const dept = await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(data.department_id).first();
        if (!dept) fail(400, 'department_required');
      }
      const pdf = await readPdf(form);
      const text = pdf ? readText({ body: form.get('text_body'), compact: form.get('text_compact') }) : null;
      if (data.doc_type !== file.doc_type && !(await env.DB.prepare('SELECT id FROM doc_types WHERE key = ?').bind(data.doc_type).first())) fail(400, 'invalid_type');
      if (data.chapter !== (file.chapter || null)) await checkChapter(env, data.chapter);
      const diff = changes({ ...file, chapter: file.chapter || null }, data, ['name', 'name_en', 'file_number', 'doc_type', 'chapter', 'department_id', 'issue_date', 'expiry_date', 'near_days', 'under_review', 'notify_date']);
      let key = file.pdf_key;
      let pdfName = file.pdf_name;
      let pdfSize = file.pdf_size;
      if (pdf) {
        // The old PDF is replaced, not kept: only the log remembers the change.
        key = `pdf/${crypto.randomUUID()}.pdf`;
        await env.FILES.put(key, pdf.bytes, { httpMetadata: { contentType: 'application/pdf' } });
        pdfName = pdf.name;
        pdfSize = pdf.size;
        diff.pdf = [file.pdf_name, pdf.name];
      }
      // Any change to the dates restarts the reminder cycle for this file.
      const statusReset = 'expiry_date' in diff || 'near_days' in diff || 'under_review' in diff;
      const customReset = 'notify_date' in diff;
      try {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE files SET department_id = ?, name = ?, name_en = ?, file_number = ?, doc_type = ?, chapter = ?, issue_date = ?, expiry_date = ?, near_days = ?, under_review = ?, notify_date = ?,
                    pdf_key = ?, pdf_name = ?, pdf_size = ?, updated_at = ?,
                    last_notified_status = ?, last_notified_on = ?, notify_date_sent = ?
              WHERE id = ?`,
          ).bind(
            data.department_id, data.name, data.name_en, data.file_number, data.doc_type, data.chapter, data.issue_date, data.expiry_date, data.near_days, data.under_review, data.notify_date,
            key, pdfName, pdfSize, nowIso(),
            statusReset ? null : file.last_notified_status, statusReset ? null : file.last_notified_on, customReset ? null : file.notify_date_sent,
            id,
          ),
          logStmt(env, user, 'update', 'file', id, `${data.name} (${data.file_number})`, diff),
          ...(text ? [textStmt(env, id, key, text)] : []),
        ]);
      } catch (e) {
        if (pdf) await env.FILES.delete(key);
        throw e;
      }
      if (pdf && file.pdf_key) await env.FILES.delete(file.pdf_key);
      return json({ ok: true });
    }

    if (seg.length === 2 && method === 'DELETE') {
      if (!canEditDept(user, file.department_id)) fail(403, 'forbidden');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM acks WHERE file_id = ?').bind(id),
        env.DB.prepare('DELETE FROM file_texts WHERE file_id = ?').bind(id),
        logStmt(env, user, 'delete', 'file', id, `${file.name} (${file.file_number})`),
      ]);
      if (file.pdf_key) await env.FILES.delete(file.pdf_key);
      return json({ ok: true });
    }
    fail(404, 'not_found');
  }

  /* ---- spare parts (Asset Management), and the parts used on a request ---- */

  if (['inventory', 'parts', 'stores', 'stock-moves', 'part-requests'].includes(seg[0]) || (seg[0] === 'tickets' && /^\d+$/.test(seg[1] || '') && ['parts', 'part-requests'].includes(seg[2]))) {
    const res = await handleInventory(request, env, url, seg, method, user);
    if (res) return res;
    fail(404, 'not_found');
  }

  /* ---- tickets, problem types, places, staff list ---- */

  if (['tickets', 'ticket-categories', 'locations', 'staff'].includes(seg[0])) {
    const res = await handleTickets(request, env, url, seg, method, user, ctx);
    if (res) return res;
    fail(404, 'not_found');
  }

  /* ---- Asset Management: register, maintenance plans ---- */

  if (['assets', 'pm', 'pm-plans', 'asset-types'].includes(seg[0])) {
    const res = await handleAssets(request, env, url, seg, method, user, ctx);
    if (res) return res;
    fail(404, 'not_found');
  }

  /* ---- Inspection rounds: checklists, the rounds due, the rounds done ---- */

  /* ---- contracts and suppliers (Asset Management) ---- */

  if (['vendors', 'vendor-docs', 'contracts'].includes(seg[0])) {
    const res = await handleContracts(request, env, url, seg, method, user);
    if (res) return res;
    fail(404, 'not_found');
  }

  if (route === 'GET /health') {
    requireRole(user, ...ADMIN_ROLES);
    return handleHealth(env, user, license);
  }
  if (route === 'GET /home') return handleHome(env, user);
  if (route === 'GET /reports') return handleReports(env, url, user, await getSettings(env));
  if (seg[0] === 'reports' && seg[1] === 'mail' && seg.length === 2) return handleReportMail(request, env, method, user);
  if (route === 'GET /reports/compliance') return handleCompliance(env, url, user, await getSettings(env));

  /* ---- Quality & Accreditation: CBAHI chapters, standards, self-assessment and readiness (JCI mapped) ---- */

  // The optional link to the Fikra portal: the system owner alone sets it (it holds the portal's key).
  if (seg[0] === 'fms-link') {
    const ownerRow = await env.DB.prepare('SELECT MIN(id) AS id FROM users').first();
    return handleFmsLink(request, env, seg, method, user, user.id === ownerRow.id);
  }
  if (seg[0] === 'portal-docs') return handlePortalDocs(request, env, seg, method, user);
  if (route === 'GET /portal-users') return handlePortalUsers(env, method, user);

  /* ---- Committees & meetings: the committees master, members, schedule and invitations ---- */
  if (seg[0] === 'committees' || seg[0] === 'committee-sessions') {
    const res = await handleMeetings(request, env, url, seg, method, user, ctx);
    if (res) return res;
    fail(404, 'not_found');
  }

  if (['quality', 'standards', 'std-chapters'].includes(seg[0])) {
    const res = await handleQuality(request, env, url, seg, method, user);
    if (res) return res;
    fail(404, 'not_found');
  }

  // Corrective actions (CAPA), from failed round lines or added by hand.
  if (seg[0] === 'capa') return handleCapa(request, env, url, seg, method, user);
  // Incident reports (OVR): quality's register, and what was sent to each person.
  if (seg[0] === 'ovr') return handleOvr(request, env, url, seg, method, user, ctx);
  // Quality indicators and the accreditation readiness report.
  if (seg[0] === 'kpis' || seg[0] === 'readiness') {
    const res = await handleKpis(request, env, url, seg, method, user);
    if (res) return res;
    fail(404, 'not_found');
  }

  if (['rounds', 'round-forms'].includes(seg[0])) {
    const res = await handleRounds(request, env, url, seg, method, user, ctx);
    if (res) return res;
    fail(404, 'not_found');
  }

  /* ---- super admin only: users, logs, settings ---- */

  if (seg[0] === 'api-keys') return handleApiKeys(request, env, url, seg, method, user);

  if (seg[0] === 'users') {
    requireRole(user, ...ADMIN_ROLES);
    // A systems admin sees the accounts and changes none of them.
    if (method !== 'GET') requireRole(user, 'super_admin');

    const readUserFields = async (body) => {
      const name = str(body.name, 100);
      const name_en = str(body.name_en, 100);
      if (!name || !name_en) fail(400, 'name_required');
      const email = checkEmail(body.email);
      const role = str(body.role, 20);
      if (!ROLES.includes(role)) fail(400, 'invalid_role');
      // Both admin roles are admin in every system, so the per-system roles are kept only for everyone else.
      const sup = ADMIN_ROLES.includes(role);
      const docs_role = sup ? 'none' : DOCS_ROLES.includes(body.docs_role) ? body.docs_role : 'none';
      const desk_role = sup ? 'none' : DESK_ROLES.includes(body.desk_role) ? body.desk_role : 'none';
      const assets_role = sup ? 'none' : ASSETS_ROLES.includes(body.assets_role) ? body.assets_role : 'none';
      const rounds_role = sup ? 'none' : ROUNDS_ROLES.includes(body.rounds_role) ? body.rounds_role : 'none';
      const quality_role = sup ? 'none' : QUALITY_ROLES.includes(body.quality_role) ? body.quality_role : 'none';
      const meetings_role = sup ? 'none' : MEETINGS_ROLES.includes(body.meetings_role) ? body.meetings_role : 'none';
      const teamWork = desk_role === 'technician' || desk_role === 'supervisor';
      // The department is the person's own one: where they manage files, the team they work in, or whose requests they follow.
      let department_id = Number.isInteger(Number(body.department_id)) && body.department_id !== null && body.department_id !== '' ? Number(body.department_id) : null;
      const dept = department_id !== null ? await env.DB.prepare('SELECT id, is_team FROM departments WHERE id = ?').bind(department_id).first() : null;
      if (department_id !== null && !dept) fail(400, 'department_required');
      if (!dept && (docs_role === 'dept_admin' || desk_role !== 'none')) fail(400, 'department_required');
      // A technician or supervisor works in a team that receives requests (IT, biomedical, maintenance...).
      if (teamWork && !dept.is_team) fail(400, 'team_required');
      if (sup) department_id = null;
      const job_title = teamWork ? (JOB_TITLES.includes(body.job_title) ? body.job_title : null) : null;
      const phone = str(body.phone, 30) || null;
      if (phone && !/^\+?[0-9 -]{5,30}$/.test(phone)) fail(400, 'invalid_phone');
      return { name, name_en, email, phone, role, docs_role, desk_role, assets_role, rounds_role, quality_role, meetings_role, department_id, job_title };
    };
    const emailTaken = async (email, exceptId) => {
      const row = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').bind(email, exceptId).first();
      if (row) fail(409, 'email_taken');
    };

    // The system owner is the first account ever created (the one made on the setup page).
    // It is hidden from other super admins and only the owner can change or delete it.
    // Its id never changes: nobody else can touch it and it cannot delete or demote itself.
    const ownerId = (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;
    const isOwner = user.id === ownerId;
    // Linked with the portal, accounts and roles are set on its users screen; the owner can still step in here.
    if (method !== 'GET' && !isOwner && (await getSettings(env)).link_on === '1') fail(409, 'users_from_portal');

    if (route === 'GET /users') {
      const { results } = await env.DB.prepare('SELECT id, name, name_en, email, phone, role, docs_role, desk_role, assets_role, rounds_role, quality_role, meetings_role, department_id, job_title, totp_on, active, portal_id, portal_off, created_at FROM users ORDER BY id').all();
      return json({ users: results.filter((u) => isOwner || u.id !== ownerId).map(userOut) });
    }
    // The license may cap the number of active accounts.
    const userCap = async () => {
      const max = license.lic ? Number(license.lic.max_users) || 0 : 0;
      if (max && (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first()).n >= max) fail(409, 'license_user_limit');
    };
    if (route === 'POST /users') {
      const body = await readJson(request);
      const data = await readUserFields(body);
      // Only the system owner makes a super admin (another one cannot appoint or remove one).
      if (data.role === 'super_admin' && !isOwner) fail(403, 'super_admin_owner_only');
      await emailTaken(data.email, 0);
      await userCap();
      const hash = await hashPassword(checkPassword(body.password));
      // Added from the portal's list: linked to that account from the start.
      let portalId = null;
      if (body.portal_id !== undefined && body.portal_id !== null) {
        portalId = Number(body.portal_id);
        const p = Number.isInteger(portalId) ? await env.DB.prepare('SELECT id FROM portal_users WHERE id = ? AND active = 1').bind(portalId).first() : null;
        if (!p) fail(400, 'portal_user_unknown');
        if (await env.DB.prepare('SELECT id FROM users WHERE portal_id = ?').bind(portalId).first()) fail(409, 'portal_user_linked');
      }
      const res = await env.DB.prepare('INSERT INTO users (name, name_en, email, phone, password_hash, role, docs_role, desk_role, assets_role, rounds_role, quality_role, meetings_role, department_id, job_title, active, portal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .bind(data.name, data.name_en, data.email, data.phone, hash, data.role, data.docs_role, data.desk_role, data.assets_role, data.rounds_role, data.quality_role, data.meetings_role, data.department_id, data.job_title, portalId, nowIso())
        .run();
      await logStmt(env, user, 'create', 'user', res.meta.last_row_id, data.name, { role: [null, data.role], docs_role: [null, data.docs_role], desk_role: [null, data.desk_role], assets_role: [null, data.assets_role], rounds_role: [null, data.rounds_role], quality_role: [null, data.quality_role], meetings_role: [null, data.meetings_role] }).run();
      return json({ ok: true, id: res.meta.last_row_id });
    }
    if (id === null) fail(404, 'not_found');
    if (id === ownerId && !isOwner) fail(404, 'not_found');
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) fail(404, 'not_found');
    if (target.role === 'super_admin' && !isOwner && id !== user.id && method !== 'GET') fail(403, 'super_admin_owner_only');

    // For someone who lost their phone and their recovery codes: they set it up again at the next sign-in.
    if (method === 'POST' && seg[2] === '2fa-reset' && seg.length === 3) {
      if (!target.totp_on) fail(409, 'two_factor_off');
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_on = 0, totp_step = 0 WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(id, user.token_hash),
        logStmt(env, user, '2fa_reset', 'user', id, target.name),
      ]);
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const body = await readJson(request);
      const data = await readUserFields(body);
      data.active = body.active === false ? 0 : 1;
      if (data.role === 'super_admin' && target.role !== 'super_admin' && !isOwner) fail(403, 'super_admin_owner_only');
      if (data.active && !target.active) await userCap();
      // An admin cannot lock themselves out, so at least one super admin always remains.
      if (id === user.id && (data.role !== 'super_admin' || !data.active)) fail(400, 'cannot_change_self');
      await emailTaken(data.email, id);
      const diff = changes(target, data, ['name', 'name_en', 'email', 'phone', 'role', 'docs_role', 'desk_role', 'assets_role', 'rounds_role', 'quality_role', 'meetings_role', 'department_id', 'job_title', 'active']);
      const stmts = [
        env.DB.prepare('UPDATE users SET name = ?, name_en = ?, email = ?, phone = ?, role = ?, docs_role = ?, desk_role = ?, assets_role = ?, rounds_role = ?, quality_role = ?, meetings_role = ?, department_id = ?, job_title = ?, active = ? WHERE id = ?').bind(
          data.name, data.name_en, data.email, data.phone, data.role, data.docs_role, data.desk_role, data.assets_role, data.rounds_role, data.quality_role, data.meetings_role, data.department_id, data.job_title, data.active, id,
        ),
      ];
      if (body.password) {
        const hash = await hashPassword(checkPassword(body.password));
        stmts.push(env.DB.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').bind(hash, id));
        stmts.push(env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(id));
        diff.password = ['***', '***'];
      }
      if ((body.password || !data.active) && id !== user.id) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
      // An admin who switches a portal-linked account on or off here decides for it: the sync no longer switches it back on.
      if (data.active !== (target.active ? 1 : 0) && target.portal_id) stmts.push(env.DB.prepare('UPDATE users SET portal_off = 0 WHERE id = ?').bind(id));
      stmts.push(logStmt(env, user, 'update', 'user', id, data.name, diff));
      await env.DB.batch(stmts);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      if (id === user.id) fail(400, 'cannot_change_self');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM acks WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(id),
        logStmt(env, user, 'delete', 'user', id, target.name),
      ]);
      return json({ ok: true });
    }
    fail(405, 'method_not_allowed');
  }

  // Backup. The system owner (first account) alone gets everything needed to rebuild the system (the database);
  // any other admin gets only the list of PDFs to download, never the data itself.
  // Password hashes, sessions and the mail token are never included. PDFs are fetched one by one by the page.
  if (route === 'GET /backup') {
    requireRole(user, ...ADMIN_ROLES);
    const all = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
    const ownerId = (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;
    if (user.id !== ownerId) {
      const [departments, files] = await Promise.all([
        all('SELECT id, name_ar, name_en FROM departments ORDER BY id'),
        all('SELECT id, department_id, name, file_number FROM files WHERE pdf_key IS NOT NULL ORDER BY id'),
      ]);
      await logStmt(env, user, 'backup', 'system', null, null, { files: files.length }).run();
      return json({ app: 'facilities-tracker', kind: 'pdf', created_at: nowIso(), data: { departments, files: files.map((f) => Object.assign(f, { has_pdf: true })) } });
    }
    const data = await fullBackupData(env);
    await logStmt(env, user, 'backup', 'system', null, null, { files: data.files.length }).run();
    return json({ app: 'facilities-tracker', kind: 'full', format: 1, created_at: nowIso(), created_by: user.email, data });
  }

  // Weekly copies the system makes on its own (system owner only): the list, and one copy to download.
  if (route === 'GET /backup/auto' || route === 'POST /backup/auto/email' || (method === 'GET' && seg[0] === 'backup' && seg[1] === 'auto' && seg.length === 3)) {
    requireRole(user, ...ADMIN_ROLES);
    const ownerId = (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;
    if (user.id !== ownerId) fail(403, 'forbidden');
    if (seg.length === 2) {
      const { objects } = await env.FILES.list({ prefix: AUTO_BACKUP_PREFIX });
      return json({ backups: objects.map((o) => ({ name: o.key.slice(AUTO_BACKUP_PREFIX.length), size: o.size, at: o.uploaded })).sort((a, b) => (a.name < b.name ? 1 : -1)) });
    }
    // Mail the newest copy to the owner now, to check that it arrives.
    if (route === 'POST /backup/auto/email') {
      const { objects } = await env.FILES.list({ prefix: AUTO_BACKUP_PREFIX });
      const newest = objects.map((o) => o.key).sort().pop();
      if (!newest) fail(404, 'not_found');
      const name = newest.slice(AUTO_BACKUP_PREFIX.length);
      const result = await emailBackup(env, await getSettings(env), name, await (await env.FILES.get(newest)).text());
      if (!result.ok) fail(result.error === 'backup_too_large' ? 413 : 502, result.error);
      await logStmt(env, user, 'backup', 'system', null, name, { emailed: 'yes' }).run();
      return json({ ok: true, to: user.email, name });
    }
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(seg[2])) fail(404, 'not_found');
    const obj = await env.FILES.get(AUTO_BACKUP_PREFIX + seg[2]);
    if (!obj) fail(404, 'not_found');
    await logStmt(env, user, 'backup', 'system', null, seg[2], { auto: true }).run();
    return new Response(obj.body, { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="backup-${seg[2]}"`, 'cache-control': 'no-store' } });
  }

  if (route === 'GET /logs') {
    requireRole(user, ...ADMIN_ROLES);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const { results } = await env.DB.prepare('SELECT id, at, user_name, action, entity, label, details FROM logs WHERE id < ? ORDER BY id DESC LIMIT 100').bind(before).all();
    return json({ logs: results });
  }

  if (seg[0] === 'settings') {
    requireRole(user, ...ADMIN_ROLES);
    // The Admin Center's Settings page (brand, mail, the assistant, two-step sign-in, licence) belongs to the
    // system owner (the first account) alone: other super admins neither see nor change any of it.
    // They keep each system's own settings (document reminders, request times), which come through here too.
    const isOwner = user.id === (await env.DB.prepare('SELECT MIN(id) AS id FROM users').first()).id;
    const ownerOnly = () => {
      if (!isOwner) fail(403, 'owner_only');
    };
    const settingsOut = (s) => ({
      near_days: s.near_days,
      repeat_days: s.repeat_days,
      email_lang: s.email_lang,
      demo: !!demoIds(s),
      require_qr: s.require_qr === '1',
      ...Object.fromEntries(SLA_KEYS.map((k) => [k, s[k]])),
      ...(isOwner
        ? {
            timezone: s.timezone,
            sender_name: s.sender_name,
            mail_url: s.mail_url,
            mail_token_set: !!s.mail_token, // the token itself never leaves the server
            mail_provider: s.mail_provider === 'brevo' ? 'brevo' : 'gas',
            brevo_key_set: !!s.brevo_key, // nor does this key
            mail_from: s.mail_from,
            mail_reply_to: s.mail_reply_to,
            backup_email: s.backup_email === '1',
            support_email: s.support_email,
            org_name_ar: s.org_name_ar,
            org_name_en: s.org_name_en,
            who_one_ar: s.who_one_ar,
            who_all_ar: s.who_all_ar,
            who_one_en: s.who_one_en,
            who_all_en: s.who_all_en,
            brand: brandOut(s),
            ai_enabled: s.ai_enabled === '1',
            ai_daily_limit: s.ai_daily_limit,
            ai_available: !!env.AI,
            require_2fa: TWO_FA_LEVELS.includes(s.require_2fa) ? s.require_2fa : 'off',
          }
        : {}),
    });

    if (route === 'GET /settings') {
      const [s, used, active] = await Promise.all([
        getSettings(env),
        env.DB.prepare('SELECT n FROM ai_usage WHERE day = ?').bind(nowIso().slice(0, 10)).first(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first(),
      ]);
      if (!isOwner) return json({ settings: settingsOut(s) });
      return json({ settings: { ...settingsOut(s), ai_used_today: used ? used.n : 0 }, license: { ...licenseOut(license, true), active_users: active.n } });
    }

    if (route === 'PUT /settings') {
      const body = await readJson(request);
      const current = await getSettings(env);
      // Each system's settings page sends only its own keys; the others keep their saved value.
      const given = (k) => body[k] !== undefined;
      if (OWNER_SETTINGS.some(given)) ownerOnly();
      checkLang((k) => body[k], ['who_one_ar', 'who_all_ar'], ['who_one_en', 'who_all_en']);
      const next = {
        near_days: given('near_days') ? Number(body.near_days) : current.near_days,
        repeat_days: given('repeat_days') ? Number(body.repeat_days) : current.repeat_days,
        timezone: given('timezone') ? str(body.timezone, 60) : current.timezone,
        sender_name: given('sender_name') ? str(body.sender_name, 80) || DEFAULT_SETTINGS.sender_name : current.sender_name,
        mail_url: given('mail_url') ? str(body.mail_url, 500) : current.mail_url,
        mail_provider: given('mail_provider') ? body.mail_provider : current.mail_provider,
        mail_from: given('mail_from') ? str(body.mail_from, 200).toLowerCase() : current.mail_from,
        mail_reply_to: given('mail_reply_to') ? str(body.mail_reply_to, 200).toLowerCase() : current.mail_reply_to,
        org_name_ar: given('org_name_ar') ? str(body.org_name_ar, 100) : current.org_name_ar,
        org_name_en: given('org_name_en') ? str(body.org_name_en, 100) : current.org_name_en,
        support_email: given('support_email') ? str(body.support_email, 200).toLowerCase() : current.support_email,
        ...Object.fromEntries(['who_one_ar', 'who_all_ar', 'who_one_en', 'who_all_en'].map((k) => [k, given(k) ? str(body[k], 40) || DEFAULT_SETTINGS[k] : current[k]])),
        require_qr: given('require_qr') ? (body.require_qr ? '1' : '0') : current.require_qr,
        ai_enabled: given('ai_enabled') ? (body.ai_enabled ? '1' : '0') : current.ai_enabled,
        ai_daily_limit: given('ai_daily_limit') ? Number(body.ai_daily_limit) : current.ai_daily_limit,
        require_2fa: given('require_2fa') ? body.require_2fa : current.require_2fa,
        backup_email: given('backup_email') ? (body.backup_email ? '1' : '0') : current.backup_email,
      };
      if (!TWO_FA_LEVELS.includes(next.require_2fa)) fail(400, 'bad_request');
      // Whoever turns it on for themselves must have it already, or they would shut themselves out of this page.
      if (next.require_2fa !== current.require_2fa && needs2fa(user, next.require_2fa) && !user.totp_on) fail(409, 'two_factor_self_first');
      if (!Number.isInteger(next.ai_daily_limit) || next.ai_daily_limit < 0 || next.ai_daily_limit > 5000) fail(400, 'invalid_ai_limit');
      // Ticket times in minutes: from 5 minutes to 90 days, and resolving never before receiving.
      for (const k of SLA_KEYS) {
        next[k] = body[k] === undefined ? current[k] : Number(body[k]);
        if (!Number.isInteger(next[k]) || next[k] < 5 || next[k] > 129600) fail(400, 'invalid_sla');
      }
      for (const p of [1, 2, 3, 4]) if (next[`sla_p${p}_res`] < next[`sla_p${p}_resp`]) fail(400, 'invalid_sla');
      if (!Number.isInteger(next.near_days) || next.near_days < 0 || next.near_days > 3650) fail(400, 'invalid_near_days');
      if (!Number.isInteger(next.repeat_days) || next.repeat_days < 0 || next.repeat_days > 365) fail(400, 'invalid_repeat_days');
      if (!isTimezone(next.timezone)) fail(400, 'invalid_timezone');
      // Only Google Apps Script web apps are accepted as the mail endpoint.
      if (next.mail_url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(next.mail_url)) fail(400, 'invalid_mail_url');
      if (!['gas', 'brevo'].includes(next.mail_provider)) fail(400, 'bad_request');
      for (const k of ['mail_from', 'mail_reply_to', 'support_email']) if (next[k] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next[k])) fail(400, 'invalid_email');
      const stmts = Object.entries(next).map(([k, v]) => setSettingStmt(env, k, v));
      const diff = changes(current, next, Object.keys(next));
      const token = typeof body.mail_token === 'string' ? body.mail_token.trim().slice(0, 200) : '';
      if (token) {
        stmts.push(setSettingStmt(env, 'mail_token', token));
        diff.mail_token = ['***', '***'];
      }
      const brevoKey = typeof body.brevo_key === 'string' ? body.brevo_key.trim().slice(0, 200) : '';
      if (brevoKey) {
        if (!/^xkeysib-[A-Za-z0-9-]{20,}$/.test(brevoKey)) fail(400, 'invalid_brevo_key');
        stmts.push(setSettingStmt(env, 'brevo_key', brevoKey));
        diff.brevo_key = ['***', '***'];
      }
      stmts.push(setSettingStmt(env, 'site_url', url.origin));
      stmts.push(logStmt(env, user, 'update', 'settings', null, null, diff));
      await env.DB.batch(stmts);
      return json({ ok: true, settings: settingsOut(await getSettings(env)) });
    }

    if (route === 'POST /settings/logo') {
      ownerOnly();
      const form = await request.formData().catch(() => fail(400, 'bad_request'));
      const f = form.get('logo');
      if (!f || typeof f === 'string' || !f.size) fail(400, 'logo_required');
      if (f.size > MAX_LOGO_BYTES) fail(413, 'logo_too_large');
      const bytes = await f.arrayBuffer();
      const type = logoType(bytes);
      if (!type) fail(400, 'logo_bad_type');
      const current = await getSettings(env);
      const key = `brand/${crypto.randomUUID()}`;
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
      const ver = Date.now().toString(36);
      try {
        await env.DB.batch([
          setSettingStmt(env, 'logo_key', key),
          setSettingStmt(env, 'logo_type', type),
          setSettingStmt(env, 'logo_ver', ver),
          setSettingStmt(env, 'site_url', url.origin),
          logStmt(env, user, 'update', 'settings', null, null, { logo: [current.logo_key ? 'logo' : null, str(f.name, 120) || 'logo'] }),
        ]);
      } catch (e) {
        await env.FILES.delete(key);
        throw e;
      }
      if (current.logo_key) await env.FILES.delete(current.logo_key);
      return json({ ok: true, brand: brandOut(await getSettings(env)) });
    }

    if (route === 'DELETE /settings/logo') {
      ownerOnly();
      const current = await getSettings(env);
      if (current.logo_key) {
        await env.DB.batch([
          setSettingStmt(env, 'logo_key', ''),
          setSettingStmt(env, 'logo_type', ''),
          setSettingStmt(env, 'logo_ver', ''),
          logStmt(env, user, 'update', 'settings', null, null, { logo: ['logo', null] }),
        ]);
        await env.FILES.delete(current.logo_key);
      }
      return json({ ok: true, brand: brandOut(await getSettings(env)) });
    }

    if (route === 'POST /settings/test-email') {
      ownerOnly();
      const settings = await getSettings(env);
      const mail = bothLangs(settings, (s) => {
        const L = EMAIL_TEXT[s.email_lang];
        const app = appName(s, s.email_lang);
        // The send time makes every test different, so mail apps do not fold a repeated test away.
        let when = nowIso();
        try {
          when = new Intl.DateTimeFormat(s.email_lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { timeZone: s.timezone || 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date());
        } catch {
          /* unknown time zone: the ISO time */
        }
        const html = `<div dir="${L.dir}" style="font-family:Tahoma,Segoe UI,sans-serif;color:#1f1a12;text-align:${L.dir === 'rtl' ? 'right' : 'left'}">${emailHeader(s)}<p>${escHtml(L.testBody)}</p><p style="font-size:13px;color:#6e6553">${escHtml(when)}</p><p style="font-size:12px;color:#6e6553">${escHtml(L.testFooter(app))}</p></div>`;
        return { subject: L.testSubject(app), html };
      });
      const result = await sendMail(settings, [{ to: user.email, ...mail }]);
      if (!result.ok) fail(502, result.error);
      return json({ ok: true, to: user.email });
    }

    if (route === 'POST /settings/demo') return json(await addDemo(env, user, url.origin));
    if (route === 'DELETE /settings/demo') return json(await removeDemo(env, user));

    if (route === 'POST /settings/run-ticket-alerts') {
      const result = await runTicketAlerts(env);
      if (!result.ok) fail(502, result.error);
      return json(result);
    }

    if (route === 'POST /settings/run-reminders') {
      const result = await runReminders(env, user);
      if (!result.ok) fail(502, result.error);
      return json(result);
    }
  }

  fail(404, 'not_found');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      return await handleApi(request, env, url, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      console.error(e);
      ctx.waitUntil(logServerError(env, request.method, url.pathname, e));
      return json({ error: 'server_error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env);
        // No emails or planned jobs from a copy without a valid license, or once it is read-only.
        const site = (await getSettings(env)).site_url;
        let host = '';
        try {
          host = new URL(site).hostname;
        } catch {
          /* no site address saved yet */
        }
        const license = await licenseState(env, host);
        if (license.locked || license.readonly) return console.log('license', license.state);
        // Daily: files near or past expiry, and the rounds due. Every 15 minutes: planned maintenance due, then late tickets.
        // A job that breaks is kept in the activity log, so it shows on the owner's health page.
        try {
          // One cron only (every 15 minutes): its 05:00 UTC run does the daily jobs. '0 5 * * *' still works when called by hand.
          const at = new Date(event.scheduledTime);
          if (event.cron === '0 5 * * *' || (at.getUTCHours() === 5 && at.getUTCMinutes() < 15)) {
            console.log('reminders', JSON.stringify(await runReminders(env, null)));
            console.log('round reminders', JSON.stringify(await runRoundReminders(env, null, false)));
            console.log('contract reminders', JSON.stringify(await runContractReminders(env)));
            console.log('stock reminders', JSON.stringify(await runStockReminders(env)));
            console.log('monthly report', JSON.stringify(await runMonthlyReport(env, null, false)));
            console.log('meeting jobs', JSON.stringify(await runMeetingJobs(env)));
            console.log('ovr reminders', JSON.stringify(await runOvrReminders(env)));
            // Indicators worked out from the system, and this month's readiness for the trend.
            const day = todayIn((await getSettings(env)).timezone);
            console.log('kpis', JSON.stringify(await refreshAutoKpis(env, day)));
            await snapshotReadiness(env, day);
          } else if (isAutoBackupTick(at)) {
            // One 15-minute run a week goes to the backup instead, so it has the run's whole query allowance.
            console.log('auto backup', JSON.stringify(await runAutoBackup(env)));
          } else {
            console.log('pm jobs', JSON.stringify(await runPmJobs(env)));
            console.log('ticket alerts', JSON.stringify(await runTicketAlerts(env)));
            // Once an hour (it checks the time itself); never throws, a failed read is kept on the link's status.
            console.log('fms link', JSON.stringify(await runFmsSync(env, { id: null, name: 'system' }, false)));
          }
        } catch (e) {
          console.error(e);
          await logStmt(env, null, 'cron_failed', 'job', null, event.cron, { error: String((e && e.message) || e).slice(0, 300) }).run().catch(() => {});
        }
      })(),
    );
  },
};
