// Automated tests only: the real worker, with the outside services (Workers AI, Brevo, Apps Script)
// replaced by stand-ins. What would have been sent is read back at GET /api/__sent.
import worker from '../../src/worker.js';

// Answers by the shape asked for: the first incident type listed with minor harm, a fixed analysis draft,
// a complaint subject, a fixed text, the first chapter for each document (plus two bad ones), minutes lines, and no request type.
const fakeAI = {
  async run(model, opts) {
    const props = (opts.response_format && opts.response_format.json_schema && opts.response_format.json_schema.properties) || {};
    if (props.type_id) {
      const m = opts.messages[0].content.match(/\n(\d+): /);
      return { response: { type_id: m ? Number(m[1]) : 0, harm: 'minor' } };
    }
    if (props.whys) {
      return { response: { whys: ['لم يُتحقق من الاسم', 'لا توجد خطوة تحقق ثانية', 'الإجراء لا ينص عليها'], people: ['ضغط العمل'], methods: ['لا يوجد تحقق مزدوج'], equipment: [], environment: [], materials: [], communication: ['تسليم ناقص بين المناوبات'] } };
    }
    if (props.category) return { response: { category: 'waiting' } };
    if (props.text) return { response: { text: 'ملخص تجريبي.\n\nتوصية: متابعة الإجراءات المتأخرة.' } };
    const row = props.items && props.items.items && props.items.items.properties;
    if (row && row.chapter) {
      const ids = [...opts.messages[1].content.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      return { response: { items: [...ids.map((id) => ({ id, chapter: row.chapter.enum[0] })), { id: 999999, chapter: row.chapter.enum[0] }, { id: ids[0] || 1, chapter: 'NOPE' }] } };
    }
    if (row && row.subject) {
      return {
        response: {
          items: [
            { subject: 'نظافة الأقسام', discussion: 'نوقشت نتائج الجولة.', action: 'رفع خطة تحسين', responsibility: 'مدير الخدمات', target_date: '2026-12-01' },
            { subject: '', discussion: '', action: '', responsibility: '', target_date: '' },
            { subject: 'التدريب', discussion: 'تأجل.', action: '', responsibility: '', target_date: 'غدًا' },
          ],
        },
      };
    }
    return { response: { category_id: 0 } };
  },
};
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://api.brevo.com/v3/smtp/email') {
    sent.push({ via: 'brevo', body: JSON.parse(init.body) });
    return Response.json({ messageIds: ['<test@relay>'] }, { status: 201 });
  }
  if (url.startsWith('https://script.google.com/')) {
    sent.push({ via: 'gas', body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  }
  return realFetch(input, init);
};
const wrap = (env) => ({ ...env, AI: fakeAI });
export default {
  fetch: (req, env, ctx) => (new URL(req.url).pathname === '/api/__sent' ? Response.json(sent.splice(0)) : worker.fetch(req, wrap(env), ctx)),
  scheduled: (ev, env, ctx) => worker.scheduled(ev, wrap(env), ctx),
};
