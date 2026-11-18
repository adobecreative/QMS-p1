// Automated tests only: the real worker, with the outside services (Workers AI, Brevo, Apps Script)
// replaced by stand-ins. What would have been sent is read back at GET /api/__sent.
import worker from '../../src/worker.js';

// Answers by the shape asked for: the first incident type listed with minor harm, a fixed analysis draft,
// and no request type.
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
