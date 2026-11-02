import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const review = JSON.parse(readFileSync('docs/releases/mobile-reliability-reviews.json', 'utf8'));
assert.equal(review.scope, 'mobile-reliability-20261102');
assert.equal(review.production_authorized, true);
assert.equal(review.reviews.length, 7);
assert.equal(new Set(review.reviews.map(r => r.reviewer)).size, 7);
assert.equal(new Set(review.reviews.map(r => r.gate)).size, 7);
for (const result of review.reviews) {
  assert.equal(result.status, 'pass', 'Independent review did not pass');
  assert.ok(result.evidence && result.limits !== undefined, 'Evidence and limits required');
}
assert.ok(Object.keys(review.candidate_sha256).length >= 5, 'Candidate files are not pinned');
for (const [path, expected] of Object.entries(review.candidate_sha256)) {
  assert.ok(/^(?:public|src|migrations|scripts)\/[A-Za-z0-9_./-]+$/.test(path) && !path.includes('..'));
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected, 'Reviewed file changed: ' + path);
}
console.log('Seven independent reviews match candidate source files. Physical-device acceptance is recorded separately.');
