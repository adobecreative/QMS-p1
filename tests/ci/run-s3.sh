#!/bin/bash
# The Node.js server with its files in S3-compatible storage: starts a local S3 server (versitygw, which
# checks request signatures like the real services), then runs s3.mjs and the whole of run-node.sh on it.
set -u
cd "$(dirname "$0")"
export S3_ENDPOINT=http://localhost:7070 S3_BUCKET=portal S3_ACCESS_KEY=portaltest S3_SECRET_KEY=portaltest-secret-1 S3_REGION=us-east-1
docker rm -f portal-s3 >/dev/null 2>&1
docker run -d --name portal-s3 -p 7070:7070 -e ROOT_ACCESS_KEY=$S3_ACCESS_KEY -e ROOT_SECRET_KEY=$S3_SECRET_KEY versity/versitygw posix /srv > /dev/null || exit 1
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:7070/ && break; sleep 0.5; done
docker exec portal-s3 mkdir -p /srv/$S3_BUCKET
node s3.mjs
RC=$?
bash run-node.sh || RC=1
docker rm -f portal-s3 > /dev/null
exit $RC
