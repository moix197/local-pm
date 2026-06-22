// Unit tests for fuzzy.js
// Run with: pnpm test (node:test)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { score } from './fuzzy.js';

describe('fuzzy.score — match hits and misses', () => {
  it('returns 0 when query is not a subsequence of target', () => {
    assert.equal(score('xyz', 'abcdef'), 0);
  });

  it('returns 0 when query characters exist but in wrong order', () => {
    assert.equal(score('ba', 'abc'), 0); // b comes after a in target
  });

  it('returns positive when query is a subsequence of target', () => {
    assert.ok(score('ab', 'abc') > 0);
  });

  it('returns positive for full exact match', () => {
    assert.ok(score('main', 'main') > 0);
  });

  it('returns positive for scattered subsequence match', () => {
    assert.ok(score('mn', 'main') > 0);
  });

  it('returns 1 for empty query (matches everything equally)', () => {
    assert.equal(score('', 'anything'), 1);
    assert.equal(score('', ''), 1);
  });

  it('returns 0 when query is longer than target', () => {
    assert.equal(score('abcdef', 'abc'), 0);
  });
});

describe('fuzzy.score — scoring order: contiguous / word-boundary above scattered', () => {
  it('contiguous match scores higher than scattered match', () => {
    // 'main' as a contiguous run vs 'm...a...i...n' scattered
    const contiguous = score('feat', 'feat/main');        // contiguous 'feat' at start
    const scattered = score('feat', 'farther eastbound'); // f-e-a-t scattered
    assert.ok(contiguous > scattered, `contiguous(${contiguous}) should > scattered(${scattered})`);
  });

  it('word-boundary match scores higher than mid-word match', () => {
    // 'main' starting at a word boundary (after /)
    const boundary = score('main', 'feat/main');
    // 'main' embedded mid-word
    const midword = score('main', 'xmainx');
    assert.ok(boundary > midword, `boundary(${boundary}) should > midword(${midword})`);
  });

  it('start-of-string match scores higher than mid-target match', () => {
    const atStart = score('ab', 'abcdef');
    const inMiddle = score('ab', 'xyzabc');
    assert.ok(atStart > inMiddle, `atStart(${atStart}) should > inMiddle(${inMiddle})`);
  });
});

describe('fuzzy.score — case-insensitivity', () => {
  it('matches lowercase query against uppercase target', () => {
    assert.ok(score('main', 'MAIN') > 0);
  });

  it('matches uppercase query against lowercase target', () => {
    assert.ok(score('FEAT', 'feat/main') > 0);
  });

  it('mixed case query matches mixed case target', () => {
    assert.ok(score('fEaT', 'Feat/Main') > 0);
  });

  it('same string different case scores same as exact match', () => {
    const s1 = score('main', 'main');
    const s2 = score('MAIN', 'main');
    assert.equal(s1, s2);
  });
});
