#!/bin/bash
python3 /home/claude/facilities-tracker/tests/mock_mail.py > /dev/null 2>&1 < /dev/null & MP=$!
sleep 0.5; rm -f /tmp/mail.log
echo "--- cron #1"; curl -s -m 20 -o /dev/null -w "http %{http_code}\n" "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+5+*+*+*"; sleep 1.5; cat /tmp/mail.log 2>/dev/null || echo "(no mail)"
rm -f /tmp/mail.log
echo "--- cron #2 (same day, expect no mail)"; curl -s -m 20 -o /dev/null -w "http %{http_code}\n" "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+5+*+*+*"; sleep 1.5; cat /tmp/mail.log 2>/dev/null || echo "(no mail)"
kill $MP
