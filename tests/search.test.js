import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRanges } from '../search.js';

test('literal search handles regex symbols, repeated hits, case and emoji offsets', () => {
    assert.deepEqual(searchRanges('😀a.b A.B aXb', ['a.b']), [{ start: 2, end: 5 }, { start: 6, end: 9 }]);
    assert.deepEqual(searchRanges('海边海边', ['海边', '海']), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    assert.deepEqual(searchRanges('[a]* [a]*', ['[a]*']), [{ start: 0, end: 4 }, { start: 5, end: 9 }]);
    assert.deepEqual(searchRanges('text', ['']), []);
});
