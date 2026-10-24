import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTargetGroup, visibleTargets } from '../src/batch/batch-panel.js';

const owners = [
    { id: 'card-a', type: 'character', label: '故事甲.json' },
    { id: 'card-b', type: 'character', label: '故事乙.png' },
    { id: 'book-a', type: 'world', label: '故事甲设定.json' },
    { id: 'book-b', type: 'world', label: '无关世界书.json' },
];

test('group select and clear affect only that group and preserve other selections', () => {
    const original = new Set(['book-b']);
    const selected = selectTargetGroup(original, owners, 'character', true);
    assert.deepEqual([...selected], ['book-b', 'card-a', 'card-b']);
    assert.deepEqual([...original], ['book-b']);
    assert.deepEqual([...selectTargetGroup(selected, owners, 'character', false)], ['book-b']);
});

test('search selection affects only visible matches in the chosen group', () => {
    const selected = selectTargetGroup(new Set(['card-b', 'book-b']), owners, 'character', true, ' 故事甲 ');
    assert.deepEqual([...selected], ['card-b', 'book-b', 'card-a']);
    assert.deepEqual([...selectTargetGroup(selected, owners, 'character', false, '故事甲')], ['card-b', 'book-b']);
    assert.deepEqual(visibleTargets(owners, '角色卡').map(owner => owner.id), ['card-a', 'card-b']);
});
