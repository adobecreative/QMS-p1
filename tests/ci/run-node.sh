#!/bin/bash
# The same checks against the Node.js server (server/node.mjs: SQLite + files on disk), the edition for
# hosting inside the Kingdom. Used by GitHub Actions after run.sh; works locally too.
set -u
cd "$(dirname "$0")"
node --check ../../server/node.mjs || exit 1
rm -rf .state .state2
WORKER=tests/ci/entry.js DATA_DIR=.state PORT=8787 TEST_SCHEDULED=1 setsid node ../../server/node.mjs > node.log 2>&1 < /dev/null &
PID=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:8787/ && break; sleep 0.5; done
node smoke.mjs
RC=$?
node systems.mjs || RC=1
node quality.mjs || RC=1
node meetings.mjs || RC=1
node ovr.mjs || RC=1
node ovr2.mjs || RC=1
node inv.mjs || RC=1
node risk.mjs || RC=1
node pex.mjs || RC=1
node qplan.mjs || RC=1
node survey.mjs || RC=1
ON_NODE=1 node restore.mjs || RC=1
kill -TERM -- -$PID 2>/dev/null
[ $RC -ne 0 ] && tail -40 node.log
exit $RC
