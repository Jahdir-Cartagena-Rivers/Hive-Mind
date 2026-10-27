import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newContinuity } from '../src/core/continuity.ts';
import { cloudMergeBase, mergeCloudArchives } from '../src/cloud-merge.mjs';

const empty = () => ({ format: 'hive-mind.archive.v1', store: { version: 1, memories: [], continuity: newContinuity() }, images: {} });
const memory = (id, subject, fact) => ({ id, subject, fact, scope: 'general', project: null,
  sourceThreadId: 'synthetic', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const key = subject => JSON.stringify(['general', '', subject]);

test('independent additions and one-sided corrections merge without choosing a timestamp winner', () => {
  const base = empty(); base.store.memories = [memory('a', 'alpha', 'before')];
  const left = structuredClone(base), right = structuredClone(base);
  left.store.memories[0].fact = 'corrected';
  right.store.memories.push(memory('b', 'beta', 'new'));
  const result = mergeCloudArchives(base, left, right);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.archive.store.memories.map(m => m.fact), ['corrected', 'new']);
  assert.equal(base.store.memories[0].fact, 'before');
});

test('competing edits and concurrent same-subject UUIDs remain conflicts; no input changes', () => {
  const base = empty(); base.store.memories = [memory('a', 'alpha', 'before')];
  const left = structuredClone(base), right = structuredClone(base);
  left.store.memories[0].fact = 'one'; right.store.memories[0].fact = 'two';
  const result = mergeCloudArchives(base, left, right);
  assert.equal(result.archive, null); assert.equal(result.conflicts.length, 1);
  assert.equal(left.store.memories[0].fact, 'one'); assert.equal(right.store.memories[0].fact, 'two');
  const a = empty(), b = empty();
  a.store.memories.push(memory('first', ' Same ', 'one'));
  b.store.memories.push(memory('second', 'same', 'two'));
  assert.equal(mergeCloudArchives(empty(), a, b).archive, null);
});

test('forget dominates a stale correction while explicit re-remember after observed forget can proceed', () => {
  const base = empty(); base.store.memories = [memory('a', 'alpha', 'before')];
  const left = structuredClone(base), right = structuredClone(base);
  left.store.memories = []; left.store.forgotten = [key('alpha')];
  right.store.memories[0].fact = 'stale correction';
  const result = mergeCloudArchives(base, left, right);
  assert.deepEqual(result.archive.store.memories, []);
  assert.deepEqual(result.archive.store.forgotten, [key('alpha')]);
  const readded = structuredClone(left);
  readded.store.forgotten = []; readded.store.memories = [memory('new', 'alpha', 'explicit new memory')];
  assert.equal(mergeCloudArchives(left, readded, left).archive.store.memories[0].id, 'new');
});

test('retry receipts merge by key and reject reused event identity with different content', () => {
  const base = empty(), left = empty(), right = empty();
  left.store.continuity.receipts = [{ key: 'one', digest: 'a', id: 'a' }];
  right.store.continuity.receipts = [{ key: 'two', digest: 'b', id: 'b' }];
  assert.equal(mergeCloudArchives(base, left, right).archive.store.continuity.receipts.length, 2);
  right.store.continuity.receipts = [{ key: 'one', digest: 'different', id: 'a' }];
  assert.equal(mergeCloudArchives(base, left, right).archive, null);
});

test('malformed input and duplicate natural identities reject before any merge', () => {
  assert.throws(() => mergeCloudArchives(empty(), {}, empty()), /validated/);
  const duplicate = empty(); duplicate.store.memories = [memory('a', 'same', 'a'), memory('b', 'same', 'b')];
  assert.throws(() => mergeCloudArchives(empty(), duplicate, empty()), /Duplicate/);
});

test('merge base follows causality and rejects unrelated or criss-cross histories', () => {
  const checkpoints = new Map([
    ['root', { version: 2, parents: [] }], ['one', { version: 2, parents: ['root'] }],
    ['two', { version: 2, parents: ['root'] }], ['left', { version: 2, parents: ['one', 'two'] }],
    ['right', { version: 2, parents: ['two', 'one'] }],
  ]);
  assert.equal(cloudMergeBase({ checkpoints, heads: ['one', 'two'] }), 'root');
  assert.throws(() => cloudMergeBase({ checkpoints, heads: ['left', 'right'] }), /unique shared base/);
  checkpoints.set('unrelated', { version: 2, parents: [] });
  assert.throws(() => cloudMergeBase({ checkpoints, heads: ['one', 'unrelated'] }), /unique shared base/);
});
