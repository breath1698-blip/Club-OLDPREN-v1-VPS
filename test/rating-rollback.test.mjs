import test from 'node:test';
import assert from 'node:assert/strict';
import { standings, mvpWinners } from '../domain.mjs';

test('fractional monthly gains keep their order and small positive winners count', () => {
  const winners = gains => mvpWinners(gains.map((gain, name) => ({ gain, name })));
  assert.deepEqual(winners([16, 15.8]), [0]);
  assert.deepEqual(winners([0, 0.4]), [1]);
  assert.deepEqual(winners([0, -1]), []);
  assert.deepEqual(winners([0.1 + 0.2, 0.3]), [0, 1]);
});

test('v2, rollback and redeploy use the recorded rules, even with overlapping players', () => {
  const players = ['a','b','c','d'].map(id => ({id, initialTier:'F'}));
  const matches = [2, undefined, 2].map((ratingVersion, i) => ({ratingVersion, finishOrder:i+1, finishedAt:'2026-11-24T08:00:00Z', teams:[['a','b'],['c','d']], score:[21,19]}));
  const replay = n => standings({players,sessions:[{matches:matches.slice(0,n)}]},['2026-11']).get('a');
  // Each close win in the old server's replay earns 3 old points here;
  // mapping 1003 -> 1006 adds 50 new points, not the new formula's 16.
  assert.equal(replay(1).rating,266);
  assert.equal(replay(2).rating,316);
  assert.equal(replay(2).monthly.get('2026-11'),66);
  assert.equal(replay(3).games,3);
  assert.ok(replay(3).rating > replay(2).rating);
});
