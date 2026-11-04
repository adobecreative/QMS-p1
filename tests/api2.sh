#!/bin/bash
B=http://localhost:8787/api
J='content-type: application/json'
login() { curl -s -m 20 -i -X POST $B/login -H "$J" -d "{\"email\":\"$1\",\"password\":\"$2\"}" | grep -i set-cookie | sed -E 's/.*fm_session=([0-9a-f]+).*/\1/'; }
SA="Cookie: fm_session=$(login owner@example.com secret-pass-1)"
printf '%%PDF-1.4\n%%test pdf one\n' > /tmp/a.pdf
printf '%%PDF-1.4\n%%test pdf two (replacement)\n' > /tmp/b.pdf
echo "not a pdf" > /tmp/c.pdf

echo "--- users: create dept admin (dept 1), dept admin (dept 2), viewer"
curl -s -m 20 -X POST $B/users -H "$SA" -H "$J" -d '{"name":"Safety Admin","email":"safety@example.com","password":"secret-pass-2","role":"dept_admin","department_id":1}'
curl -s -m 20 -X POST $B/users -H "$SA" -H "$J" -d '{"name":"Maint Admin","email":"maint@example.com","password":"secret-pass-3","role":"dept_admin","department_id":2}'
curl -s -m 20 -X POST $B/users -H "$SA" -H "$J" -d '{"name":"Reader","email":"reader@example.com","password":"secret-pass-4","role":"viewer"}'
echo; echo "--- duplicate email / weak password / dept admin without dept"
curl -s -m 20 -X POST $B/users -H "$SA" -H "$J" -d '{"name":"Dup","email":"reader@example.com","password":"secret-pass-4","role":"viewer"}'
curl -s -m 20 -X POST $B/users -H "$SA" -H "$J" -d '{"name":"Weak","email":"weak@example.com","password":"123","role":"viewer"}'
curl -s -m 20 -X POST $B/users -H "$SA" -H "$J" -d '{"name":"NoDept","email":"nodept@example.com","password":"secret-pass-4","role":"dept_admin"}'
echo
DA="Cookie: fm_session=$(login safety@example.com secret-pass-2)"
DB="Cookie: fm_session=$(login maint@example.com secret-pass-3)"
VW="Cookie: fm_session=$(login reader@example.com secret-pass-4)"

echo "--- files: create (SA) expired / near / valid / permanent / review"
curl -s -m 20 -X POST $B/files -H "$SA" -F name='Fire system check' -F file_number=FM-SAF-007 -F doc_type=procedure -F department_id=1 -F issue_date=2025-09-10 -F expiry_date=2026-09-10 -F pdf=@/tmp/a.pdf
curl -s -m 20 -X POST $B/files -H "$SA" -F name='Lift contract' -F file_number=FM-MNT-014 -F doc_type=program -F department_id=2 -F issue_date=2025-11-01 -F expiry_date=2026-10-20 -F pdf=@/tmp/a.pdf
curl -s -m 20 -X POST $B/files -H "$DA" -F name='Evacuation plan' -F file_number=FM-SAF-001 -F doc_type=program -F department_id=1 -F issue_date=2025-01-15 -F expiry_date=2027-01-15 -F near_days=60 -F pdf=@/tmp/a.pdf
curl -s -m 20 -X POST $B/files -H "$DA" -F name='Org guide' -F file_number=FM-SAF-100 -F doc_type=policy -F department_id=1 -F issue_date=2023-02-12 -F pdf=@/tmp/a.pdf
curl -s -m 20 -X POST $B/files -H "$DA" -F name='Work permits' -F file_number=FM-SAF-011 -F doc_type=policy -F department_id=1 -F under_review=1 -F notify_date=2026-09-30 -F pdf=@/tmp/a.pdf
echo; echo "--- rejects: dept admin into other dept / no pdf / fake pdf / viewer create / bad type / expiry before issue"
curl -s -m 20 -X POST $B/files -H "$DA" -F name='X' -F file_number=X -F doc_type=policy -F department_id=2 -F pdf=@/tmp/a.pdf
curl -s -m 20 -X POST $B/files -H "$SA" -F name='X' -F file_number=X -F doc_type=policy -F department_id=1
curl -s -m 20 -X POST $B/files -H "$SA" -F name='X' -F file_number=X -F doc_type=policy -F department_id=1 -F pdf=@/tmp/c.pdf
curl -s -m 20 -X POST $B/files -H "$VW" -F name='X' -F file_number=X -F doc_type=policy -F department_id=1 -F pdf=@/tmp/a.pdf
curl -s -m 20 -X POST $B/files -H "$SA" -F name='X' -F file_number=X -F doc_type=form -F department_id=1 -F pdf=@/tmp/a.pdf
curl -s -m 20 -X POST $B/files -H "$SA" -F name='X' -F file_number=X -F doc_type=policy -F department_id=1 -F issue_date=2026-05-01 -F expiry_date=2026-01-01 -F pdf=@/tmp/a.pdf
echo; echo "--- list as SA (id,status,days)"
curl -s -m 20 $B/files -H "$SA" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f['id'],f['department_id'],f['name'],f['status'],f['days_left'],f['near_days'],f['has_pdf']) for f in d['files']]"
echo "--- list as dept admin 2 (should be only dept 2)"
curl -s -m 20 $B/files -H "$DB" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f['id'],f['department_id'],f['name'],f['status']) for f in d['files']]"
echo "--- departments as dept admin 2 / viewer count"
curl -s -m 20 $B/departments -H "$DB"; echo; curl -s -m 20 $B/files -H "$VW" | python3 -c "import sys,json; print('viewer sees', len(json.load(sys.stdin)['files']))"
echo "--- pdf: viewer reads file 1; dept admin 2 blocked from file 1"
curl -s -m 20 -D - $B/files/1/pdf -H "$VW" | tr -d '\r' | grep -iE "^HTTP|content-type|content-disposition|test pdf"
curl -s -m 20 $B/files/1/pdf -H "$DB"; echo
echo "--- update: dept admin 2 edits file 1 (blocked) / viewer edits (blocked)"
curl -s -m 20 -X PUT $B/files/1 -H "$DB" -F name='Hack' -F file_number=X -F doc_type=policy -F department_id=2; curl -s -m 20 -X PUT $B/files/1 -H "$VW" -F name='Hack' -F file_number=X -F doc_type=policy -F department_id=1; echo
echo "--- renew expired file 1: new dates + replace pdf"
curl -s -m 20 -X PUT $B/files/1 -H "$DA" -F name='Fire system check' -F file_number=FM-SAF-007 -F doc_type=procedure -F department_id=1 -F issue_date=2026-09-30 -F expiry_date=2027-09-30 -F pdf=@/tmp/b.pdf; echo
curl -s -m 20 $B/files/1/pdf -H "$VW" | tail -1
curl -s -m 20 $B/files -H "$DA" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f['id'],f['name'],f['status'],f['days_left'],f['pdf_name']) for f in d['files'] if f['id']==1]"
echo "--- dept admin moves own file to other dept (blocked)"
curl -s -m 20 -X PUT $B/files/3 -H "$DA" -F name='Evacuation plan' -F file_number=FM-SAF-001 -F doc_type=program -F department_id=2; echo
echo "--- delete file 4 as dept admin 1, then 404"
curl -s -m 20 -X DELETE $B/files/4 -H "$DA"; curl -s -m 20 $B/files/4/pdf -H "$SA"; echo
echo "--- delete dept with files (blocked) ; non-SA hitting users/logs/settings"
curl -s -m 20 -X DELETE $B/departments/1 -H "$SA"; curl -s -m 20 $B/users -H "$DA"; curl -s -m 20 $B/logs -H "$VW"; curl -s -m 20 $B/settings -H "$DA"; echo
echo "--- SA self-demote (blocked), deactivate viewer, viewer session dies"
curl -s -m 20 -X PUT $B/users/1 -H "$SA" -H "$J" -d '{"name":"Owner","email":"owner@example.com","role":"viewer"}'
curl -s -m 20 -X PUT $B/users/4 -H "$SA" -H "$J" -d '{"name":"Reader","email":"reader@example.com","role":"viewer","active":false}'
curl -s -m 20 $B/files -H "$VW"; echo
echo "--- change own password (wrong current / ok)"
curl -s -m 20 -X POST $B/me/password -H "$DA" -H "$J" -d '{"current":"bad","password":"new-secret-pass"}'; curl -s -m 20 -X POST $B/me/password -H "$DA" -H "$J" -d '{"current":"secret-pass-2","password":"new-secret-pass"}'; echo
echo "--- logs"
curl -s -m 20 $B/logs -H "$SA" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(l['id'],l['user_name'],l['action'],l['entity'],l['label'],l['details']) for l in d['logs']]"
echo "--- lockout after 5 wrong logins"
for i in 1 2 3 4 5 6; do curl -s -m 20 -X POST $B/login -H "$J" -d '{"email":"maint@example.com","password":"wrong"}'; done; echo
