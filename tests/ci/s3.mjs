// The S3 file storage (server/s3.mjs) against a real S3-compatible server that checks signatures
// (versitygw, started by run-s3.sh): Arabic names, binary files, missing files, paging, delete, wrong key.
import { s3Files } from '../../server/s3.mjs';

let failed = 0;
const check = (cond, label, extra) => {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300)));
};
const opts = { endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION, bucket: process.env.S3_BUCKET, accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY };
const f = s3Files(opts);

const name = 'unit/ملف تجربة (1)+&.pdf';
await f.put(name, new Uint8Array([0, 1, 2, 255]), { httpMetadata: { contentType: 'application/pdf' } });
const g = await f.get(name);
check(g && g.size === 4 && g.httpMetadata.contentType === 'application/pdf', 'an Arabic file name is stored and read back', g && { size: g.size, meta: g.httpMetadata });
check(g && String(new Uint8Array(await g.arrayBuffer())) === '0,1,2,255', 'binary content comes back unchanged');
for (let i = 0; i < 5; i++) await f.put(`unit/list/x${i}.json`, JSON.stringify({ i }), { httpMetadata: { contentType: 'application/json' } });
check((await (await f.get('unit/list/x2.json')).json()).i === 2, 'a JSON file reads back');
check((await f.head('unit/list/x1.json'))?.size === 7, 'head gives the size without the content');
check((await f.get('unit/none')) === null && (await f.head('unit/none')) === null, 'a missing file is null');
const page = await f.list({ prefix: 'unit/list/', limit: 3 });
check(page.objects.length === 3 && page.truncated, 'the list stops at the limit and says there is more', page);
const all = await f.list({ prefix: 'unit/list/' });
check(all.objects.length === 5 && !all.truncated && all.objects[0].uploaded instanceof Date, 'the full list has every file with its date');
await f.delete(['unit/list/x0.json', 'unit/list/x1.json', name]);
await f.delete('unit/none');
check((await f.list({ prefix: 'unit/' })).objects.length === 3, 'files are deleted, and deleting a missing file is fine');
const wrong = await s3Files({ ...opts, secretKey: 'wrong-key' }).get('unit/list/x2.json').then(() => 'read', (e) => e.message);
check(/403/.test(wrong), 'a wrong secret key is refused by the storage', wrong);
await f.delete(['unit/list/x2.json', 'unit/list/x3.json', 'unit/list/x4.json']);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
