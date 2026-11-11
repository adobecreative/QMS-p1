#!/bin/bash
# Starts the worker locally with fresh data, runs the checks, stops it. Used by GitHub Actions; works locally too.
set -u
cd "$(dirname "$0")"
for f in ../../src/worker.js ../../public/app.js ../../public/i18n.js; do node --check "$f" || exit 1; done
rm -rf .state
WRANGLER_SEND_METRICS=false CI=1 setsid npx wrangler dev -c wrangler.jsonc --persist-to .state --port 8787 --test-scheduled > wrangler.log 2>&1 < /dev/null &
PID=$!
for i in $(seq 1 120); do curl -s -o /dev/null http://localhost:8787/ && break; sleep 0.5; done
node smoke.mjs
RC=$?
node systems.mjs || RC=1
node quality.mjs || RC=1
node meetings.mjs || RC=1
node ovr.mjs || RC=1
node restore.mjs || RC=1
kill -TERM -- -$PID 2>/dev/null
[ $RC -ne 0 ] && tail -40 wrangler.log
exit $RC
