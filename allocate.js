// ============================================================
// allocate.js — Exam Alloc Seating Algorithm  v2
// ============================================================
//
// Algorithms / Techniques:
//   1. Round Robin Distribution   : Subject interleaving before seating
//   2. Position-Aware Swap Search : Candidate MUST be conflict-free at target seat
//   3. 4-Directional Adjacency    : Left, Right, Up, Down neighbor checks
//   4. Gap Seating (NEW)          : Skip seat & leave empty gap when:
//                                   - No valid swap exists in lookahead window
//                                   - Remaining global capacity > students left
//                                   - Avoids forcing a violation when spare seats exist
//   5. Forced Violation Fallback  : Only fires when capacity is truly exhausted
//   6. Global Capacity Tracking   : Accurate remaining-slot accounting across halls
//
// ============================================================
// Why v1 had tail violations:
//   Round-robin runs out of "partner" subjects first. The dominant
//   subject fills the tail of the queue with consecutive same-subject
//   students. v1 could only look left, not up/down, and its swap
//   candidate check only tested subject ≠ conflictSubject — it didn't
//   verify the candidate was actually conflict-free at that exact seat.
//
// v2 fixes:
//   • checkAdjacency now checks all 4 directions
//   • findSwappableStudent passes the live grid + seat coordinates,
//     so it only accepts candidates that are TRULY non-conflicting
//   • When no valid swap is found but spare capacity exists (hall has
//     more seats than students left), skip the seat and leave an empty
//     gap — the student is placed at the next seat with no conflict
//   • violations only increment when capacity is fully exhausted
// ============================================================

/**
 * Main entry point
 * @param {Object} groupedStudents  { subject_code: [{ student_id, student_name, subject_code }] }
 * @param {Array}  halls            [{ hall_id, hall_name, capacity, total_rows, total_cols }]
 * @returns {{ allocations, unallocated, violations }}
 */
function runAllocationAlgorithm(groupedStudents, halls) {
  const allocations = [];
  const unallocated = [];
  let   violations  = 0;

  // ── STEP 1: Round Robin interleave ──────────────────────────────────────────
  // e.g. subjects A,B,C → [A1,B1,C1,A2,B2,C2,...] — natural subject separation
  const subjects     = Object.keys(groupedStudents);
  const queues       = subjects.map(s => [...groupedStudents[s]]);
  const studentQueue = roundRobinMerge(queues);

  const totalStudents = studentQueue.length;
  const totalCapacity = halls.reduce((sum, h) => sum + h.capacity, 0);

  // globalConsumed tracks all seats consumed (placed + skipped) across ALL halls
  // so the gap-decision formula stays accurate even as we move between halls
  let globalConsumed = 0;
  let studentIdx     = 0;

  // ── STEP 2: Greedy Hall-by-Hall Allocation ──────────────────────────────────
  for (const hall of halls) {
    const grid       = buildEmptyGrid(hall.total_rows, hall.total_cols);
    let   hallConsumed = 0; // seats placed + skipped inside this hall

    outer:
    for (let row = 1; row <= hall.total_rows; row++) {
      for (let col = 1; col <= hall.total_cols; col++) {

        if (hallConsumed  >= hall.capacity)       break outer;
        if (studentIdx    >= studentQueue.length) break outer;

        const r       = row - 1;           // 0-indexed for grid
        const c       = col - 1;
        const student = studentQueue[studentIdx];

        // ── 4-Direction Adjacency Check ────────────────────────────────────
        const hasConflict = checkAdjacency(grid, r, c, student.subject_code);

        if (!hasConflict) {
          // ✅  Clean placement — no conflict at this seat
          placeStudent(grid, r, c, student, hall, row, col, allocations);
          hallConsumed++;
          studentIdx++;

        } else {
          // ── Position-Aware Swap ──────────────────────────────────────────
          // Scan ahead for a student whose subject does NOT conflict
          // at this EXACT seat position (checks all 4 neighbors on live grid)
          const swapIdx = findSwappableStudent(studentQueue, studentIdx, grid, r, c);

          if (swapIdx !== -1) {
            // Swap guaranteed to be conflict-free — place immediately
            [studentQueue[studentIdx], studentQueue[swapIdx]] =
              [studentQueue[swapIdx], studentQueue[studentIdx]];

            const swapped = studentQueue[studentIdx];
            placeStudent(grid, r, c, swapped, hall, row, col, allocations);
            hallConsumed++;
            studentIdx++;

          } else {
            // ── Gap Seating vs Forced Violation ─────────────────────────────
            //
            // Gap seating condition:
            //   remaining global capacity > students still waiting
            //   i.e. we have at least one extra seat to "waste" as a gap
            //
            // By skipping this seat, the student will be tried at the
            // next position which likely has different neighbors — resolving
            // the conflict without any violation at all.
            //
            const studentsLeft      = totalStudents - studentIdx;
            const remainingCapacity = totalCapacity - globalConsumed - hallConsumed;

            if (remainingCapacity > studentsLeft) {
              // ✅  Gap skip — leave seat empty, student retried next iteration
              // Grid cell stays null (visible empty gap in the seating chart)
              hallConsumed++;
              // studentIdx intentionally NOT incremented — same student,
              // next seat will have different neighbors

            } else {
              // ⚠️  Capacity exhausted — cannot afford a gap
              // Force-place and log as violation
              violations++;
              placeStudent(grid, r, c, student, hall, row, col, allocations);
              hallConsumed++;
              studentIdx++;
            }
          }
        }
      }
    }

    globalConsumed += hallConsumed;
  }

  // ── STEP 3: Overflow — students remaining after all halls filled ────────────
  while (studentIdx < studentQueue.length) {
    const s = studentQueue[studentIdx++];
    unallocated.push({
      student_id:   s.student_id,
      student_name: s.student_name || '',
      subject_code: s.subject_code || '',
      reason:       'Capacity overflow — no seats remaining across all halls',
    });
  }

  return { allocations, unallocated, violations };
}

// ============================================================
// HELPER: placeStudent
// Writes subject to grid and pushes allocation record
// ============================================================
function placeStudent(grid, r, c, student, hall, row, col, allocations) {
  grid[r][c] = student.subject_code;
  allocations.push({
    student_id: student.student_id,
    hall_id:    hall.hall_id,
    seat_row:   row,
    seat_col:   col,
    seat_label: `R${row}C${col}`,
  });
}

// ============================================================
// HELPER: checkAdjacency  (4-directional)
// Returns true if any of the 4 orthogonal neighbors (L/R/U/D)
// holds the same subject_code as the candidate student.
// Diagonal neighbors are NOT checked (exam convention).
// ============================================================
function checkAdjacency(grid, r, c, subjectCode) {
  const rows = grid.length;
  const cols = grid[0].length;

  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr][nc] === subjectCode) {
      return true; // conflict found
    }
  }
  return false;
}

// ============================================================
// HELPER: findSwappableStudent  (position-aware)
//
// v1 searched for any student with subject ≠ conflictSubject.
// That candidate could still conflict with an UP/DOWN neighbor.
//
// v2 passes the live grid + target (r, c) and calls checkAdjacency
// directly on each candidate — so the returned candidate is
// GUARANTEED to be placeable at this exact seat with zero conflict.
//
// Lookahead: 30 students (O(1) cap, handles heavy subject skew)
// ============================================================
function findSwappableStudent(queue, currentIdx, grid, r, c, lookahead = 30) {
  const limit = Math.min(currentIdx + 1 + lookahead, queue.length);

  for (let i = currentIdx + 1; i < limit; i++) {
    if (!checkAdjacency(grid, r, c, queue[i].subject_code)) {
      return i; // this candidate fits cleanly
    }
  }

  return -1; // no suitable swap found in window
}

// ============================================================
// HELPER: Round Robin Merge
// Interleaves students from all subject queues evenly
// Input : [[A1,A2,A3], [B1,B2], [C1]]
// Output: [A1, B1, C1, A2, B2, A3]
// ============================================================
function roundRobinMerge(queues) {
  const result = [];
  const q      = queues.map(arr => [...arr]);
  let   i      = 0;

  while (q.some(arr => arr.length > 0)) {
    const idx = i % q.length;
    if (q[idx].length > 0) result.push(q[idx].shift());
    i++;
  }

  return result;
}

// ============================================================
// HELPER: Build Empty Grid
// Returns a 2D array of nulls representing an empty hall
// ============================================================
function buildEmptyGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(null));
}

// ============================================================
module.exports = { runAllocationAlgorithm };