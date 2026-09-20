/**
 * RFC 6902 ordering audit.
 *
 * Given the saved inputs (base + patchA + patchB), replays them with STRICT,
 * sequential RFC 6902 semantics in both orders (A then B, and B then A):
 *
 *  - every operation is evaluated against the document produced by the previous
 *    operation (never against base coordinates); in particular array indices
 *    are resolved on the current array, so insert/remove drift is visible;
 *  - the first operation that cannot be applied per RFC 6902 fails that order,
 *    reporting the failing side, the ORIGINAL operation index and the document
 *    state immediately before the failed operation;
 *  - when both orders apply, the results are compared: equal => "commutative",
 *    otherwise the lexicographically (code-unit) smallest RFC 6901 pointer of
 *    any leaf difference is reported together with the values on each side.
 *
 * Everything here is a pure function of the saved inputs, so repeating the
 * audit always yields the byte-identical response.
 */

import { parsePointer, formatPointer, deepEqual } from './merge.js';

export const ORDER_A_TO_B = 'A->B';
export const ORDER_B_TO_A = 'B->A';

export class Rfc6902Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Rfc6902Error';
    this.code = code;
  }
}

/* ------------------------------- pointer ops ----------------------------- */

function parseTokens(path) {
  try {
    return parsePointer(path);
  } catch (err) {
    throw new Rfc6902Error('INVALID_POINTER', err.message);
  }
}

/**
 * Strict RFC 6902 array index ABNF:  "0" / ([1-9] *DIGIT).
 * "-" is returned as the append sentinel (-1); anything else is invalid.
 */
function parseArrayIndex(token) {
  if (token === '-') return -1;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return null;
  const n = Number(token);
  return Number.isSafeInteger(n) ? n : null;
}

function descend(node, token) {
  if (Array.isArray(node)) {
    const idx = parseArrayIndex(token);
    if (idx === null || idx < 0) {
      throw new Rfc6902Error(
        'INVALID_INDEX',
        `"${token}" is not a valid RFC 6902 array index (leading zeroes are not allowed; "-" only addresses the append gap)`,
      );
    }
    if (idx >= node.length) {
      throw new Rfc6902Error(
        'TARGET_NOT_FOUND',
        `array index ${idx} is out of bounds (array length ${node.length})`,
      );
    }
    return node[idx];
  }
  if (node !== null && typeof node === 'object') {
    if (!Object.prototype.hasOwnProperty.call(node, token)) {
      throw new Rfc6902Error('TARGET_NOT_FOUND', `object member "${token}" does not exist`);
    }
    return node[token];
  }
  throw new Rfc6902Error(
    'UNRESOLVABLE_PATH',
    `cannot traverse into ${node === null ? 'null' : typeof node}`,
  );
}

function lookupValue(doc, segments) {
  if (segments.length === 0) return { exists: true, value: doc };
  let node = doc;
  for (const seg of segments) {
    try {
      node = descend(node, seg);
    } catch {
      return { exists: false };
    }
  }
  return { exists: true, value: node };
}

/* ------------------------------ one RFC 6902 op --------------------------- */

function applyOne(doc, op) {
  if (!op || typeof op !== 'object') {
    throw new Rfc6902Error('INVALID_OPERATION', 'operation must be an object');
  }
  const { op: kind, path } = op;
  if (kind !== 'add' && kind !== 'remove' && kind !== 'replace') {
    throw new Rfc6902Error('INVALID_OPERATION', `unsupported op "${kind}"`);
  }
  if (typeof path !== 'string') {
    throw new Rfc6902Error('INVALID_POINTER', 'path must be a string');
  }
  if (kind !== 'remove' && !('value' in op)) {
    throw new Rfc6902Error('INVALID_OPERATION', `"${kind}" requires a "value" member`);
  }

  const segments = parseTokens(path);

  // Root targets: add/replace replace the whole document; remove is an error.
  if (segments.length === 0) {
    if (kind === 'remove') {
      throw new Rfc6902Error('INVALID_OPERATION', 'removing the document root is not allowed');
    }
    return structuredClone(op.value);
  }

  let parent = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    parent = descend(parent, segments[i]);
  }
  const last = segments[segments.length - 1];

  if (Array.isArray(parent)) {
    const append = last === '-';
    const idx = append ? -1 : parseArrayIndex(last);
    if (idx === null) {
      throw new Rfc6902Error('INVALID_INDEX', `"${last}" is not a valid RFC 6902 array index`);
    }
    if (kind === 'add') {
      const at = append ? parent.length : idx;
      if (!append && at > parent.length) {
        throw new Rfc6902Error(
          'OUT_OF_BOUNDS',
          `add index ${at} is beyond the array length ${parent.length}`,
        );
      }
      parent.splice(at, 0, structuredClone(op.value));
    } else {
      if (append) {
        throw new Rfc6902Error(
          'INVALID_INDEX',
          'the "-" append index may only be used with add',
        );
      }
      if (idx >= parent.length) {
        throw new Rfc6902Error(
          'TARGET_NOT_FOUND',
          `array index ${idx} is out of bounds (array length ${parent.length})`,
        );
      }
      if (kind === 'remove') parent.splice(idx, 1);
      else parent[idx] = structuredClone(op.value);
    }
    return doc;
  }

  if (parent !== null && typeof parent === 'object') {
    const exists = Object.prototype.hasOwnProperty.call(parent, last);
    if (kind === 'remove') {
      if (!exists) {
        throw new Rfc6902Error('TARGET_NOT_FOUND', `object member "${last}" does not exist`);
      }
      delete parent[last];
    } else if (kind === 'replace') {
      if (!exists) {
        throw new Rfc6902Error('TARGET_NOT_FOUND', `cannot replace missing member "${last}"`);
      }
      parent[last] = structuredClone(op.value);
    } else {
      // RFC 6902: add on an existing object member replaces it.
      parent[last] = structuredClone(op.value);
    }
    return doc;
  }

  throw new Rfc6902Error(
    'UNRESOLVABLE_PATH',
    `target parent is ${parent === null ? 'null' : typeof parent}, not an object or array`,
  );
}

/* -------------------------------- one order ------------------------------- */

function makeStep(side, index, op, docAfter) {
  const step = {
    side,
    index,
    op: op.op,
    path: op.path,
  };
  if (op.op !== 'remove') step.value = structuredClone(op.value);
  // Re-resolve the operation's own pointer against the resulting document
  // (after an array removal an index may point at the shifted-in element).
  const hit = lookupValue(docAfter, parseTokens(op.path));
  step.afterExists = hit.exists;
  if (hit.exists) step.afterValue = hit.value;
  return step;
}

function runOrder(base, plan) {
  const steps = [];
  let doc = structuredClone(base);
  for (const { side, patch } of plan) {
    for (let index = 0; index < patch.length; index++) {
      const op = patch[index];
      const documentBefore = structuredClone(doc);
      try {
        doc = applyOne(doc, op);
      } catch (err) {
        return {
          status: 'failed',
          steps,
          result: null,
          error: {
            side,
            index,
            op: op && op.op,
            path: op && op.path,
            code: err.code || 'INVALID_OPERATION',
            message: err.message,
            documentBefore,
          },
        };
      }
      steps.push(makeStep(side, index, op, doc));
    }
  }
  return { status: 'applied', steps, result: doc, error: null };
}

/* ------------------------------ difference walk --------------------------- */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sideValue(exists, value) {
  return exists ? { exists: true, value: structuredClone(value) } : { exists: false };
}

function collectDifferences(a, b, segments, out) {
  if (deepEqual(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const childSegments = [...segments, String(i)];
      if (i >= a.length || i >= b.length) {
        out.push({
          path: formatPointer(childSegments),
          aToB: sideValue(i < a.length, a[i]),
          bToA: sideValue(i < b.length, b[i]),
        });
      } else {
        collectDifferences(a[i], b[i], childSegments, out);
      }
    }
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      const childSegments = [...segments, key];
      if (!inA || !inB) {
        out.push({
          path: formatPointer(childSegments),
          aToB: sideValue(inA, a[key]),
          bToA: sideValue(inB, b[key]),
        });
      } else {
        collectDifferences(a[key], b[key], childSegments, out);
      }
    }
    return;
  }
  // Scalar / type mismatch (including array-vs-object, null vs value): the
  // pointer of this node is itself the leaf difference.
  out.push({
    path: formatPointer(segments),
    aToB: sideValue(true, a),
    bToA: sideValue(true, b),
  });
}

function comparePointers(x, y) {
  // Code-unit lexicographic order on the RFC 6901 encoded strings.
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/* --------------------------------- audit ---------------------------------- */

export function auditOrders(base, patchA, patchB) {
  const reports = {
    [ORDER_A_TO_B]: runOrder(base, [
      { side: 'A', patch: patchA },
      { side: 'B', patch: patchB },
    ]),
    [ORDER_B_TO_A]: runOrder(base, [
      { side: 'B', patch: patchB },
      { side: 'A', patch: patchA },
    ]),
  };

  const audit = {
    base: structuredClone(base),
    patchA: structuredClone(patchA),
    patchB: structuredClone(patchB),
    orders: reports,
  };

  const firstFailed =
    reports[ORDER_A_TO_B].status === 'failed'
      ? { order: ORDER_A_TO_B, ...reports[ORDER_A_TO_B].error }
      : reports[ORDER_B_TO_A].status === 'failed'
        ? { order: ORDER_B_TO_A, ...reports[ORDER_B_TO_A].error }
        : null;

  if (firstFailed) {
    audit.verdict = 'failed';
    audit.failure = firstFailed;
    return audit;
  }

  const resultAB = reports[ORDER_A_TO_B].result;
  const resultBA = reports[ORDER_B_TO_A].result;
  if (deepEqual(resultAB, resultBA)) {
    audit.verdict = 'commutative';
    return audit;
  }

  const differences = [];
  collectDifferences(resultAB, resultBA, [], differences);
  differences.sort((x, y) => comparePointers(x.path, y.path));
  audit.verdict = 'divergent';
  audit.firstDifference = differences[0];
  audit.differences = differences;
  return audit;
}
