import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditOrders,
  Rfc6902Error,
  ORDER_A_TO_B,
  ORDER_B_TO_A,
} from '../src/orderAudit.js';

test('disjoint object edits are commutative', () => {
  const audit = auditOrders(
    { a: 1, b: 2 },
    [{ op: 'replace', path: '/a', value: 10 }],
    [
      { op: 'replace', path: '/b', value: 20 },
      { op: 'add', path: '/c', value: 30 },
    ],
  );
  assert.equal(audit.verdict, 'commutative');
  assert.deepEqual(audit.orders[ORDER_A_TO_B].result, { a: 10, b: 20, c: 30 });
  assert.deepEqual(audit.orders[ORDER_B_TO_A].result, audit.orders[ORDER_A_TO_B].result);
  assert.equal(audit.orders[ORDER_A_TO_B].status, 'applied');
  assert.equal(audit.orders[ORDER_B_TO_A].status, 'applied');
});

test('each op inside an order applies to the previous result (array indices drift)', () => {
  const audit = auditOrders(
    { list: ['x', 'y'] },
    [{ op: 'add', path: '/list/1', value: 'A' }],
    [{ op: 'add', path: '/list/1', value: 'B' }],
  );
  assert.equal(audit.verdict, 'divergent');
  // A then B: B's "/list/1" resolves against the array A already shifted
  assert.deepEqual(audit.orders[ORDER_A_TO_B].result.list, ['x', 'B', 'A', 'y']);
  assert.deepEqual(audit.orders[ORDER_B_TO_A].result.list, ['x', 'A', 'B', 'y']);
  // the second add in A->B belongs to side B with its ORIGINAL index 0
  const lastStepAB = audit.orders[ORDER_A_TO_B].steps[1];
  assert.deepEqual([lastStepAB.side, lastStepAB.index], ['B', 0]);
  assert.equal(lastStepAB.afterValue, 'B');
});

test('intra-patch indices are never anchored at base: second op sees shifted array', () => {
  const audit = auditOrders(
    ['x', 'y'],
    [
      { op: 'add', path: '/0', value: 'A' },
      { op: 'replace', path: '/1', value: 'AFTER-A' },
    ],
    [],
  );
  assert.equal(audit.verdict, 'commutative');
  // strict RFC 6902: after inserting at 0, index 1 is the inserted element
  assert.deepEqual(audit.orders[ORDER_A_TO_B].result, ['A', 'AFTER-A', 'y']);
});

test('divergent result reports the lexicographically smallest RFC 6901 diff path', () => {
  const audit = auditOrders(
    { a: { m: 1 }, b: 0 },
    [{ op: 'replace', path: '/b', value: 2 }],
    [{ op: 'replace', path: '/b', value: 3 }],
  );
  assert.equal(audit.verdict, 'divergent');
  assert.equal(audit.firstDifference.path, '/b');
  // B runs last in A->B (B wins); A runs last in B->A (A wins)
  assert.deepEqual(audit.firstDifference.aToB, { exists: true, value: 3 });
  assert.deepEqual(audit.firstDifference.bToA, { exists: true, value: 2 });
});

test('divergence inside a subtree recurses to the leaf and escapes RFC 6901 tokens', () => {
  const audit = auditOrders(
    { 'obj': { 'a~b': { x: 1 }, z: 1 } },
    [
      { op: 'replace', path: '/obj/a~0b/x', value: 2 },
      { op: 'replace', path: '/obj/z', value: 20 },
    ],
    [
      { op: 'replace', path: '/obj/a~0b/x', value: 3 },
      { op: 'replace', path: '/obj/z', value: 30 },
    ],
  );
  assert.equal(audit.verdict, 'divergent');
  // "/obj/a~0b/x" < "/obj/z" lexicographically; recurse past "obj"
  assert.equal(audit.firstDifference.path, '/obj/a~0b/x');
  assert.equal(audit.firstDifference.aToB.value, 3);
  assert.equal(audit.firstDifference.bToA.value, 2);
  assert.deepEqual(audit.differences.map((d) => d.path), ['/obj/a~0b/x', '/obj/z']);
});

test('one failed order reports failing side, original index and document before failure', () => {
  const audit = auditOrders(
    { a: 1 },
    [{ op: 'remove', path: '/a' }],
    [{ op: 'replace', path: '/a', value: 2 }],
  );
  assert.equal(audit.verdict, 'failed');
  // B->A applies (replace then remove); A->B fails when B replaces the removed member
  assert.equal(audit.orders[ORDER_B_TO_A].status, 'applied');
  assert.deepEqual(audit.orders[ORDER_B_TO_A].result, {});
  assert.equal(audit.orders[ORDER_A_TO_B].status, 'failed');
  const { failure } = audit;
  assert.equal(failure.order, 'A->B');
  assert.equal(failure.side, 'B');
  assert.equal(failure.index, 0);
  assert.equal(failure.code, 'TARGET_NOT_FOUND');
  assert.deepEqual(failure.documentBefore, {});
  // only the successful step (A#0) is retained
  assert.deepEqual(
    audit.orders[ORDER_A_TO_B].steps.map((s) => [s.side, s.index]),
    [['A', 0]],
  );
});

test('B->A failure is reported when A->B applies', () => {
  const audit = auditOrders(
    { a: 1 },
    [{ op: 'replace', path: '/a', value: 2 }],
    [{ op: 'remove', path: '/a' }],
  );
  assert.equal(audit.verdict, 'failed');
  assert.equal(audit.orders[ORDER_A_TO_B].status, 'applied');
  assert.equal(audit.orders[ORDER_B_TO_A].status, 'failed');
  assert.equal(failureOrThrow(audit).order, 'B->A');
  assert.equal(failureOrThrow(audit).side, 'A');
  assert.deepEqual(failureOrThrow(audit).documentBefore, {});
});

function failureOrThrow(audit) {
  if (!audit.failure) throw new Error('expected failure');
  return audit.failure;
}

test('out-of-bounds add after the other patch shrank the array fails with pre-doc', () => {
  const audit = auditOrders(
    { list: [1, 2] },
    [{ op: 'remove', path: '/list/0' }],
    [{ op: 'add', path: '/list/2', value: 'B' }], // valid on base (length 2)
  );
  assert.equal(audit.verdict, 'failed');
  const { failure } = audit;
  assert.equal(failure.order, 'A->B');
  assert.equal(failure.side, 'B');
  assert.equal(failure.code, 'OUT_OF_BOUNDS');
  assert.deepEqual(failure.documentBefore, { list: [2] });
});

test('"-" appends are commutative across patches', () => {
  const audit = auditOrders(
    ['x'],
    [{ op: 'add', path: '/-', value: 'A' }],
    [{ op: 'add', path: '/-', value: 'B' }],
  );
  // append gap is order-dependent too under strict replay
  assert.deepEqual(audit.orders[ORDER_A_TO_B].result, ['x', 'A', 'B']);
  assert.deepEqual(audit.orders[ORDER_B_TO_A].result, ['x', 'B', 'A']);
  assert.equal(audit.verdict, 'divergent');
});

test('leading-zero array index is invalid under strict RFC 6902', () => {
  const audit = auditOrders(
    ['x', 'y'],
    [{ op: 'remove', path: '/00' }],
    [],
  );
  assert.equal(audit.verdict, 'failed');
  assert.equal(audit.failure.code, 'INVALID_INDEX');
  assert.equal(audit.failure.side, 'A');
  assert.equal(audit.failure.index, 0);
});

test('steps record per-operation path and post-value, including shifted removes', () => {
  const audit = auditOrders(
    { list: ['x', 'y', 'z'] },
    [{ op: 'remove', path: '/list/0' }],
    [],
  );
  const [step] = audit.orders[ORDER_A_TO_B].steps;
  assert.equal(step.op, 'remove');
  assert.equal(step.path, '/list/0');
  assert.equal(step.afterExists, true); // index 0 now holds the shifted element
  assert.equal(step.afterValue, 'y');
  assert.ok(!('value' in step));
});

test('empty patches are commutative and leave the base untouched', () => {
  const audit = auditOrders({ a: 1 }, [], []);
  assert.equal(audit.verdict, 'commutative');
  assert.deepEqual(audit.orders[ORDER_A_TO_B].result, { a: 1 });
  assert.deepEqual(audit.orders[ORDER_A_TO_B].steps, []);
});

test('root replace replaces the whole document and reports the new doc as afterValue', () => {
  // B's write (/w = 3) is already present in A's replacement document, so the
  // orders converge despite the root replace.
  const audit = auditOrders(
    { v: 1 },
    [{ op: 'replace', path: '', value: { v: 2, w: 3 } }],
    [{ op: 'add', path: '/w', value: 3 }],
  );
  assert.equal(audit.verdict, 'commutative');
  const rootStepAB = audit.orders[ORDER_A_TO_B].steps[0];
  assert.deepEqual(rootStepAB.afterValue, { v: 2, w: 3 });
  assert.deepEqual(audit.orders[ORDER_B_TO_A].result, { v: 2, w: 3 });
});

test('audit is deterministic and does not mutate its inputs', () => {
  const base = { list: ['x'] };
  const patchA = [{ op: 'add', path: '/list/0', value: { n: 1 } }];
  const patchB = [{ op: 'add', path: '/list/0', value: { n: 2 } }];
  const r1 = auditOrders(base, patchA, patchB);
  const r2 = auditOrders(base, patchA, patchB);
  assert.deepEqual(r1, r2);
  assert.deepEqual(base, { list: ['x'] });
  assert.deepEqual(patchA, [{ op: 'add', path: '/list/0', value: { n: 1 } }]);
  // cloning the embedded value must not be able to poison later audits
  r1.orders[ORDER_A_TO_B].steps[0].afterValue.n = 999;
  const r3 = auditOrders(base, patchA, patchB);
  assert.equal(r3.orders[ORDER_A_TO_B].steps[0].afterValue.n, 1);
});

test('Rfc6902Error carries an RFC-style code', () => {
  const err = new Rfc6902Error('TARGET_NOT_FOUND', 'boom');
  assert.equal(err.code, 'TARGET_NOT_FOUND');
  assert.equal(err.message, 'boom');
});
