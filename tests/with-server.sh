#!/bin/bash
# Usage: with-server.sh <command...>  -- starts the local dev server, runs the command, stops the server.
cd /home/claude/facilities-tracker
WRANGLER_SEND_METRICS=false CI=1 setsid npx wrangler dev --port 8787 --test-scheduled > /tmp/wr.log 2>&1 < /dev/null &
WPID=$!
for i in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null http://localhost:8787/api/bootstrap; then break; fi
  sleep 0.5
done
"$@"
RC=$?
kill -TERM -- -$WPID 2>/dev/null
sleep 1
kill -KILL -- -$WPID 2>/dev/null
echo "[server stopped, rc=$RC]"
exit $RC
