// Two-step sign-in, set up by each person for their own account.
import { b32e, needs2fa, newRecoveryCodes, readJson, totpCheck, verifyPassword } from '../lib/auth.js';
import { TOTP_PERIOD, appName } from '../lib/config.js';
import { getSettings, logStmt } from '../lib/db.js';
import { fail, json, str } from '../lib/util.js';

/* two-step sign-in, set up by each person for their own account */

export async function handleTwoFactor(request, env, url, seg, method, user) {
  const route = `${method} /${seg.join('/')}`;
  const me = await env.DB.prepare('SELECT password_hash, totp_secret, totp_pending, totp_on, totp_step FROM users WHERE id = ?').bind(user.id).first();
  const left = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').bind(user.id).first()).n;
  const level = (await getSettings(env)).require_2fa;
  // Turning it off or making new codes needs the password and a current code from the app.
  const confirm = async (body) => {
    if (!(await verifyPassword(typeof body.password === 'string' ? body.password : '', me.password_hash))) fail(400, 'wrong_password');
    const step = await totpCheck(me.totp_secret, str(body.code, 20).replace(/\s+/g, ''), me.totp_step);
    if (!step) fail(400, 'wrong_code');
    const took = await env.DB.prepare('UPDATE users SET totp_step = ? WHERE id = ? AND totp_step < ?').bind(step, user.id, step).run();
    if (!took.meta.changes) fail(400, 'wrong_code');
  };

  if (route === 'GET /me/2fa') return json({ on: !!me.totp_on, recovery_left: me.totp_on ? await left() : 0, required: needs2fa(user, level) });

  // A new secret, kept aside until a code from the app proves it was saved.
  if (route === 'POST /me/2fa/setup') {
    const body = await readJson(request);
    if (me.totp_on) fail(409, 'two_factor_on');
    if (!(await verifyPassword(typeof body.password === 'string' ? body.password : '', me.password_hash))) fail(400, 'wrong_password');
    const secret = b32e(crypto.getRandomValues(new Uint8Array(20)));
    await env.DB.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').bind(secret, user.id).run();
    const issuer = appName(await getSettings(env), 'en');
    const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(user.email);
    return json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}` });
  }

  if (route === 'POST /me/2fa/enable') {
    const body = await readJson(request);
    if (me.totp_on) fail(409, 'two_factor_on');
    if (!me.totp_pending) fail(400, 'login_expired');
    const step = await totpCheck(me.totp_pending, str(body.code, 20).replace(/\s+/g, ''), 0);
    if (!step) fail(400, 'wrong_code');
    const rc = await newRecoveryCodes(env, user.id);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_on = 1, totp_step = ? WHERE id = ? AND totp_on = 0').bind(step, user.id),
      ...rc.stmts,
      // Every other device signs in again, this time with the code.
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(user.id, user.token_hash),
      logStmt(env, user, '2fa_on', 'user', user.id, user.name),
    ]);
    return json({ ok: true, codes: rc.codes });
  }

  if (route === 'POST /me/2fa/recovery') {
    const body = await readJson(request);
    if (!me.totp_on) fail(409, 'two_factor_off');
    await confirm(body);
    const rc = await newRecoveryCodes(env, user.id);
    await env.DB.batch([...rc.stmts, logStmt(env, user, '2fa_codes', 'user', user.id, user.name)]);
    return json({ ok: true, codes: rc.codes });
  }

  if (route === 'POST /me/2fa/disable') {
    const body = await readJson(request);
    if (!me.totp_on) fail(409, 'two_factor_off');
    if (needs2fa(user, level)) fail(409, 'two_factor_enforced');
    await confirm(body);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_on = 0, totp_step = 0 WHERE id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(user.id),
      logStmt(env, user, '2fa_off', 'user', user.id, user.name),
    ]);
    return json({ ok: true });
  }
  fail(404, 'not_found');
}
