#!/bin/bash
# Builds the Docker image, starts it, and checks that it answers, keeps its data across a restart,
# and reports healthy.
set -u
cd "$(dirname "$0")/../.."
docker build -q -t portal-ci . > /dev/null || exit 1
docker rm -f portal-ci > /dev/null 2>&1
docker run -d --name portal-ci -p 8795:8787 portal-ci > /dev/null || exit 1
up() { for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:8795/ && return 0; sleep 0.5; done; return 1; }
RC=0
up && echo "PASS the container starts" || { echo "FAIL the container starts"; RC=1; }
curl -s -X POST http://localhost:8795/api/setup -H 'content-type: application/json' -H 'x-requested-with: fetch' \
  -d '{"name":"المالك","name_en":"Owner","email":"owner@example.com","password":"secret-pass-1"}' | grep -q '"ok":true' \
  && echo "PASS first setup in the container" || { echo "FAIL first setup in the container"; RC=1; }
docker restart portal-ci > /dev/null; up
curl -s http://localhost:8795/api/bootstrap | grep -q '"needsSetup":false' \
  && echo "PASS the data is kept after a restart" || { echo "FAIL the data is kept after a restart"; RC=1; }
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' portal-ci)" = healthy ] && break; sleep 2; done
[ "$(docker inspect -f '{{.State.Health.Status}}' portal-ci)" = healthy ] && echo "PASS the container reports healthy" || { echo "FAIL the container reports healthy"; RC=1; }
[ $RC -ne 0 ] && docker logs portal-ci 2>&1 | tail -20
docker rm -f portal-ci > /dev/null
exit $RC
