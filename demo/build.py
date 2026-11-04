import base64, json
P = '/home/claude/facilities-tracker/public/'
css = open(P + 'styles.css', encoding='utf-8').read()
i18n = open(P + 'i18n.js', encoding='utf-8').read()
app = open(P + 'app.js', encoding='utf-8').read()
mock = open('mock.js', encoding='utf-8').read()
pdf_b64 = base64.b64encode(open('sample.pdf', 'rb').read()).decode()
CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'

def swap(s, a, b):
    assert s.count(a) == 1, (s.count(a), a)
    return s.replace(a, b)

# The demo talks to the in-page stand-in instead of a server.
app = swap(app, "st.doc = await window.pdfjsLib.getDocument({ url, isEvalSupported: false, cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/' }).promise;",
           "st.doc = await window.pdfjsLib.getDocument({ data: window.__demoPdf(file.id), isEvalSupported: false }).promise;")
app = swap(app, "'/vendor/pdf.min.js'", "'" + CDN + "pdf.min.js'")
app = swap(app, "'/vendor/pdf.worker.min.js'", "'" + CDN + "pdf.worker.min.js'")
app = swap(app, "    a.click();\n", "    toast(t('demo.export'));\n")
app = swap(app, "  window.addEventListener('popstate', onUrlChange);\n  boot();", "  window.addEventListener('popstate', onUrlChange);\n  window.__boot = boot;\n  window.__resetRoute = () => {\n    S.route = '';\n    setUrl('', false);\n  };\n  boot();")

extra_i18n = """
Object.assign(window.I18N.ar, {
  'err.demo': 'النسخة التجريبية لا ترسل بريدًا حقيقيًا. في النظام الفعلي تُرسل الرسالة من Gmail.',
  'demo.export': 'في النظام الفعلي ينزل هنا ملف تقرير يفتح في Excel.',
});
Object.assign(window.I18N.en, {
  'err.demo': 'The demo does not send real email. The real system sends it from Gmail.',
  'demo.export': 'In the real system a report file that opens in Excel downloads here.',
});
"""

demo_css = """
/* demo-only additions */
:root { box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
html { scroll-padding-top: env(safe-area-inset-top, 0px); }
#demo-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; padding: 8px clamp(16px, 4vw, 32px); background: #fbe7a1; color: #5a3e00; font-size: 13.5px; line-height: 1.5; }
#demo-bar strong { font-weight: 700; }
.demo-as { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.demo-as select { width: auto; min-height: 40px; padding: 4px 10px; border-color: #c99400; color: #15211f; font-size: 14px; font-weight: 500; }
.auth { min-height: calc(100dvh - 120px); }
.toast { inset-block-end: calc(20px + env(safe-area-inset-bottom, 0px)); }
.pdf-full { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); background: #ffffff; }
"""

demo_bar_js = """
(function () {
  var TXT = {
    ar: { title: 'نسخة تجريبية للمراجعة.', note: 'البيانات وهمية، وأي تعديل يختفي عند إعادة فتح الصفحة.', as: 'الدخول كـ', opts: ['سوبر أدمن', 'أدمن قسم السلامة', 'مستخدم (قراءة فقط)'] },
    en: { title: 'Demo for review.', note: 'Sample data; changes disappear when the page is reopened.', as: 'Sign in as', opts: ['Super Admin', 'Safety department admin', 'Viewer (read only)'] },
  };
  var sel = document.getElementById('demo-user');
  function paint() {
    var L = TXT[document.documentElement.lang === 'en' ? 'en' : 'ar'];
    document.getElementById('demo-title').textContent = L.title;
    document.getElementById('demo-note').textContent = L.note;
    document.getElementById('demo-as-label').textContent = L.as;
    for (var i = 0; i < 3; i++) sel.options[i + 1].textContent = L.opts[i];
  }
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  sel.addEventListener('change', function () {
    window.__demoSetUser(Number(sel.value));
    window.__resetRoute();
    window.__boot();
  });
  window.__demoSync = function (id) { sel.value = id ? String(id) : ''; };
  paint();
})();
"""

html = f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<title>إدارة المرافق - نسخة تجريبية</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap" rel="stylesheet">
<style>
{css}
{demo_css}
</style>
</head>
<body>
<div id="demo-bar" role="note">
  <span><strong id="demo-title"></strong> <span id="demo-note"></span></span>
  <label class="demo-as"><span id="demo-as-label"></span>
    <select id="demo-user"><option value="" hidden>-</option><option value="1" selected></option><option value="2"></option><option value="3"></option></select>
  </label>
</div>
<div id="app"></div>
<script async src="{CDN}pdf.min.js"></script>
<script async src="{CDN}pdf.worker.min.js"></script>
<script>window.__NO_HREF = true; window.__DEMO_PDF_B64 = {json.dumps(pdf_b64)};</script>
<script>
{i18n}
{extra_i18n}
</script>
<script>
{mock}
</script>
<script>
{demo_bar_js}
</script>
<script>
{app}
</script>
</body>
</html>
"""
assert '</script>' not in i18n and '</script>' not in app and '</script>' not in mock
out = '/mnt/user-data/outputs/facilities-demo.html'
open(out, 'w', encoding='utf-8').write(html)
print('written', out, len(html.encode('utf-8')), 'bytes')
