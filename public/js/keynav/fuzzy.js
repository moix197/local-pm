// Pure vanilla subsequence fuzzy matcher with scoring.
// No deps, no DOM. Exported for unit tests.
//
// score(query, target) → number (0 = no match, positive = match quality).
// Higher is better. Bonuses:
//   +3 per contiguous run of matched characters
//   +2 per match at a word boundary (start-of-string, space, /, -)
//   +1 per match at start of any word segment

/**
 * Returns a match score for query against target.
 * Returns 0 if query is not a subsequence of target.
 * Case-insensitive.
 * @param {string} query
 * @param {string} target
 * @returns {number} 0 means no match; positive means match (higher = better)
 */
export function score(query, target) {
  if (!query) return 1; // empty query matches everything equally
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = 0; // index into query
  let ti = 0; // index into target
  let total = 0;
  let prevMatchedAt = -2; // last index in target that was matched

  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      let bonus = 1; // base match
      // Contiguous with previous match?
      if (ti === prevMatchedAt + 1) bonus += 3;
      // Word boundary bonus: start-of-string or preceded by space / / or -
      const prev = ti > 0 ? t[ti - 1] : null;
      if (prev === null || prev === ' ' || prev === '/' || prev === '-') bonus += 2;
      total += bonus;
      prevMatchedAt = ti;
      qi++;
    }
    ti++;
  }

  // If we didn't consume the whole query, it's not a subsequence match.
  if (qi < q.length) return 0;
  return total;
}
