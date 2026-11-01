"use strict";

// Compares two complete release tracklists by ordered recording occurrence. Sets would treat
// [A, B, A] and [A, B, B] as equal, so every occurrence keeps its own position.

function ordered(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .map((track) => ({ discNumber: track.discNumber, trackNumber: track.trackNumber, title: track.title || "", recordingMbid: track.recordingMbid || "" }))
    .sort((left, right) => left.discNumber - right.discNumber || left.trackNumber - right.trackNumber);
}

function discLayout(tracks) {
  const counts = [];
  for (const track of tracks) counts[track.discNumber - 1] = (counts[track.discNumber - 1] || 0) + 1;
  return Array.from(counts, (count) => count || 0);
}

// Longest common subsequence of recording IDs. Tracklists are capped at 200 tracks, so the
// quadratic table stays small.
function alignment(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = left[i].recordingMbid === right[j].recordingMbid
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i].recordingMbid === right[j].recordingMbid) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

function compareTracklists(baseTracks, otherTracks) {
  const base = ordered(baseTracks);
  const other = ordered(otherTracks);
  const pairs = alignment(base, other);
  const matchedBase = new Set(pairs.map(([i]) => i));
  const matchedOther = new Set(pairs.map(([, j]) => j));
  // A gap is the stretch between two aligned occurrences; both sides use the same numbering.
  const gapOf = (index, side) => pairs.filter((pair) => pair[side] < index).length;
  let unmatchedBase = base.map((track, index) => ({ track, gap: gapOf(index, 0) })).filter((_, index) => !matchedBase.has(index));
  let unmatchedOther = other.map((track, index) => ({ track, gap: gapOf(index, 1) })).filter((_, index) => !matchedOther.has(index));

  // The same recording elsewhere in the other release is a move, not an omission and an addition.
  const moved = [];
  unmatchedBase = unmatchedBase.filter((entry) => {
    const index = unmatchedOther.findIndex((candidate) => candidate.track.recordingMbid === entry.track.recordingMbid);
    if (index === -1) return true;
    moved.push({ base: entry.track, other: unmatchedOther[index].track });
    unmatchedOther.splice(index, 1);
    return false;
  });

  // Different recordings in the same gap replace each other one for one.
  const substituted = [];
  unmatchedBase = unmatchedBase.filter((entry) => {
    const index = unmatchedOther.findIndex((candidate) => candidate.gap === entry.gap);
    if (index === -1) return true;
    substituted.push({ base: entry.track, other: unmatchedOther[index].track });
    unmatchedOther.splice(index, 1);
    return false;
  });

  const baseLayout = discLayout(base);
  const otherLayout = discLayout(other);
  const discLayoutDiffers = baseLayout.length !== otherLayout.length || baseLayout.some((count, index) => count !== otherLayout[index]);
  const sameOrder = pairs.length === base.length && pairs.length === other.length;
  return {
    equivalent: sameOrder && !discLayoutDiffers,
    discLayoutDiffers,
    discs: { base: baseLayout, other: otherLayout },
    added: unmatchedOther.map((entry) => entry.track),
    omitted: unmatchedBase.map((entry) => entry.track),
    substituted,
    moved,
  };
}

module.exports = { compareTracklists };
