// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works
// ------------
// The score of a level is set by pushes alone: P* pushes (the level's push optimum) earns full points and every
// extra push costs more than half, so this solver searches in push space and proves push optimality, instead of
// minimising steps the way a plain move-space A* does.
//
//   * A search state is the set of box squares plus the player's reachable region (named by its lowest square):
//     between pushes the player walks freely, so only the region matters, never the exact square.
//   * The search is A* over pushes. Its estimate is a minimum-cost matching of boxes to goals over precomputed
//     lone-box push distances (a box pushed around an otherwise empty board), which never overestimates, so the
//     first solution A* settles is push-optimal.
//   * Two deadlock tests prune states no push can save: a box resting on a dead square (one from which a lone box
//     can never reach a goal) and a freeze deadlock (boxes wedged against walls or each other so they can never
//     move again, found by a fixed-point pass; a frozen box off its goal is dead).
//   * Levels from this competition's generator are a hallway with independent rooms off it: a box can never
//     leave its room, so the level is cut into rooms (the dead squares of the player's own row are the hallway)
//     and each room is solved on its own with the other rooms' boxes standing as walls, exactly as the level's
//     optimum is the sum of its rooms'. A level that does not cut into rooms, or a room that resists, falls back
//     to a whole-level A*, then to a greedy search that at least solves it, then to an empty answer.
//
// Everything is budgeted in expanded states, never by the clock, and every tie breaks by square and insertion
// order, so two runs of this program on the same set write byte-identical answers.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions as [dx, dy, walk letter, push letter]; their order fixes every tie in the program. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** Work budgets, in expanded states: per room, per whole level, per greedy rescue, and one purse for the run. */
const ROOM_BUDGET = 700_000;
const LEVEL_BUDGET = 500_000;
const GREEDY_BUDGET = 800_000;
let purse = 4_000_000;

/**
 * A level read from XSB text: width, a wall mask (short rows and the board's frame count as walls), the goal
 * squares, the box squares (sorted) and the player's square.
 */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + w - 1] = 1;
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * For every goal, the fewest pushes that bring a lone box from each square to that goal, the other boxes ignored
 * and the player assumed able to stand where a push needs: a breadth-first walk backwards from the goal over the
 * push graph (a box on y came from y - d when both y - d and the stand square y - 2d are open). -1: unreachable.
 * A square is "live" when some goal's distance there is finite; a box resting anywhere else can never score.
 */
function goalDistances(w, wall, goals) {
  const size = wall.length;
  return goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (y < 0 || y >= size || dist[y] !== -1) continue;
        if (wall[y] || wall[y - d]) continue;
        dist[y] = dist[x] + 1;
        queue.push(y);
      }
    }
    return dist;
  });
}

/**
 * The squares the player reaches from `from` with the boxes of `boxMask` in the way, flood-filled into `seen`
 * under `stamp`; returns the region's lowest square, the name push-space states go by.
 */
function floodRegion(w, wall, boxMask, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const dn = p + w;
    const lf = p - 1;
    const rt = p + 1;
    if (!wall[up] && !boxMask[up] && seen[up] !== stamp) { seen[up] = stamp; stack[n++] = up; }
    if (!wall[dn] && !boxMask[dn] && seen[dn] !== stamp) { seen[dn] = stamp; stack[n++] = dn; }
    if (!wall[lf] && !boxMask[lf] && seen[lf] !== stamp) { seen[lf] = stamp; stack[n++] = lf; }
    if (!wall[rt] && !boxMask[rt] && seen[rt] !== stamp) { seen[rt] = stamp; stack[n++] = rt; }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, as lower-case LURD letters ('' when already there). */
function walkPath(w, wall, boxMask, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const letter = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, ch] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || boxMask[q] || prev[q] !== -1) continue;
      prev[q] = p;
      letter[q] = ch;
      queue.push(q);
    }
  }
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = letter[p] + out;
  return out;
}

/**
 * Freeze deadlock: a box that can never move again. A box is stuck along an axis when either neighbouring square
 * along it is a wall or an already-frozen box (one side denies the player a stand, the other the box a landing),
 * and frozen when stuck along both axes; iterate to a fixed point. Returns true when some frozen box is off goal.
 */
function hasFrozenBox(w, wall, boxMask, boxes, goalMask) {
  const frozen = new Uint8Array(wall.length);
  const stuck = (s) => wall[s] === 1 || (boxMask[s] === 1 && frozen[s] === 1);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen[b]) continue;
      const noHorizontal = stuck(b - 1) || stuck(b + 1);
      const noVertical = stuck(b - w) || stuck(b + w);
      if (noHorizontal && noVertical) {
        frozen[b] = 1;
        changed = true;
      }
    }
  }
  for (const b of boxes) if (frozen[b] && !goalMask[b]) return true;
  return false;
}

/**
 * The A* estimate: a minimum-cost matching of boxes to distinct goals over the lone-box push distances (subset
 * dynamic programming for up to ten boxes, a sum of per-box minima beyond that). Admissible: every box must be
 * pushed at least its matched distance, and one push moves one box one square. Infinity when some box reaches
 * no goal at all.
 */
function estimate(boxes, goalDists) {
  const nb = boxes.length;
  const ng = goalDists.length;
  if (nb > ng) return Infinity;
  if (nb > 10) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let j = 0; j < ng; j++) {
        const d = goalDists[j][b];
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  const full = 1 << ng;
  const dp = new Float64Array(full).fill(Infinity);
  dp[0] = 0;
  for (let mask = 0; mask < full; mask++) {
    const base = dp[mask];
    if (base === Infinity) continue;
    let i = 0;
    for (let m = mask; m; m &= m - 1) i++;
    if (i >= nb) continue;
    const b = boxes[i];
    for (let j = 0; j < ng; j++) {
      if (mask & (1 << j)) continue;
      const d = goalDists[j][b];
      if (d < 0) continue;
      const next = mask | (1 << j);
      if (base + d < dp[next]) dp[next] = base + d;
    }
  }
  let best = Infinity;
  for (let mask = 0; mask < full; mask++) {
    let i = 0;
    for (let m = mask; m; m &= m - 1) i++;
    if (i === nb && dp[mask] < best) best = dp[mask];
  }
  return best;
}

/**
 * A push-optimal solve of one board: A* over pushes from `startBoxes` to `goals` with the player starting at
 * `playerStart`, expanding at most `budget` states (and never more than the shared purse holds). With `greedy`
 * set, the queue runs best-first on the estimate alone and the first solution found wins, optimal or not.
 * Returns { pushes, moves, endPlayer } or null when the budget runs out first.
 */
function solvePushes(w, wall, goals, startBoxes, playerStart, budget, greedy) {
  const size = wall.length;
  const goalMask = new Uint8Array(size);
  for (const g of goals) goalMask[g] = 1;
  const goalDists = goalDistances(w, wall, goals);
  const live = new Uint8Array(size);
  for (let s = 0; s < size; s++) {
    for (let j = 0; j < goals.length; j++) {
      if (goalDists[j][s] >= 0) { live[s] = 1; break; }
    }
  }
  for (const b of startBoxes) if (!live[b]) return null;

  const boxMask = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes, region) => String.fromCharCode(region, ...boxes);
  const hCache = new Map();
  const estimateOf = (boxes) => {
    const k = String.fromCharCode(...boxes);
    let h = hCache.get(k);
    if (h === undefined) {
      h = estimate(boxes, goalDists);
      hCache.set(k, h);
    }
    return h;
  };

  // The states, in the order found: their boxes (as a char-code string), the player's square after the push that
  // made them, their parent, their push count, and the push itself (the box's old square and its direction).
  const stBoxes = [];
  const stPlayer = [];
  const stParent = [];
  const stDepth = [];
  const stFrom = [];
  const stDir = [];
  const bestDepth = new Map();
  const heap = [];
  let counter = 0;
  const heapLess = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  const addState = (boxes, player, parent, depth, from, dir) => {
    const idx = stBoxes.length;
    stBoxes.push(String.fromCharCode(...boxes));
    stPlayer.push(player);
    stParent.push(parent);
    stDepth.push(depth);
    stFrom.push(from);
    stDir.push(dir);
    return idx;
  };

  for (const b of startBoxes) boxMask[b] = 1;
  const startRegion = floodRegion(w, wall, boxMask, playerStart, seen, ++stamp, stack);
  for (const b of startBoxes) boxMask[b] = 0;
  const h0 = estimateOf(startBoxes);
  if (h0 === Infinity) return null;
  const root = addState(startBoxes, playerStart, -1, 0, -1, -1);
  bestDepth.set(keyOf(startBoxes, startRegion), 0);
  heapPush([greedy ? h0 : h0, 0, counter++, root]);
  if (startBoxes.every((b) => goalMask[b])) return { pushes: 0, moves: '', endPlayer: playerStart };

  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && found < 0) {
    if (expanded >= budget || expanded >= purse) {
      purse -= expanded;
      return null;
    }
    const [, , , s] = heapPop();
    const boxes = [...stBoxes[s]].map((ch) => ch.charCodeAt(0));
    for (const b of boxes) boxMask[b] = 1;
    const here = ++stamp;
    const region = floodRegion(w, wall, boxMask, stPlayer[s], seen, here, stack);
    if (bestDepth.get(keyOf(boxes, region)) !== stDepth[s]) {
      for (const b of boxes) boxMask[b] = 0;
      continue;
    }
    expanded++;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const dest = b + d;
        const stand = b - d;
        if (seen[stand] !== here || wall[dest] || boxMask[dest] || !live[dest]) continue;
        boxMask[b] = 0;
        boxMask[dest] = 1;
        const next = boxes.slice();
        next[bi] = dest;
        next.sort((x, y) => x - y);
        const dead = hasFrozenBox(w, wall, boxMask, next, goalMask);
        let region = -1;
        if (!dead) region = floodRegion(w, wall, boxMask, b, mark, ++stamp, stack);
        boxMask[dest] = 0;
        boxMask[b] = 1;
        if (dead) continue;
        const key = keyOf(next, region);
        const depth = stDepth[s] + 1;
        const seenDepth = bestDepth.get(key);
        if (seenDepth !== undefined && seenDepth <= depth) continue;
        const h = estimateOf(next);
        if (h === Infinity) continue;
        bestDepth.set(key, depth);
        const idx = addState(next, b, s, depth, b, k);
        heapPush([greedy ? h : depth + h, depth, counter++, idx]);
        if (next.every((bb) => goalMask[bb])) found = idx;
      }
    }
    for (const b of boxes) boxMask[b] = 0;
  }
  purse -= expanded;
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's stand square on the board as it then stood, then push.
  const chain = [];
  for (let s = found; s > 0; s = stParent[s]) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = playerStart;
  let boxes = startBoxes.slice();
  for (const s of chain) {
    const from = stFrom[s];
    const d = DIRS[stDir[s]][1] * w + DIRS[stDir[s]][0];
    for (const b of boxes) boxMask[b] = 1;
    moves += walkPath(w, wall, boxMask, player, from - d);
    for (const b of boxes) boxMask[b] = 0;
    moves += DIRS[stDir[s]][3];
    boxes[boxes.indexOf(from)] = from + d;
    boxes.sort((x, y) => x - y);
    player = from;
  }
  return { pushes: stDepth[found], moves, endPlayer: player };
}

/**
 * The level's rooms, or null when the level is no set of rooms. The hallway is the player's row: its squares a
 * box could never push through to a goal (the dead ones) are cut out of the floor, and each part of what remains
 * that holds boxes is a room, with its squares, boxes and goals. Null when a box starts in the hallway, a goal
 * falls in a cut square, or some part's boxes and goals disagree in number.
 */
function roomsOf(level, goalDistsAll) {
  const { w, wall, goals, boxes, player } = level;
  const live = new Uint8Array(wall.length);
  for (let s = 0; s < wall.length; s++) {
    for (let j = 0; j < goals.length; j++) {
      if (goalDistsAll[j][s] >= 0) { live[s] = 1; break; }
    }
  }
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= wall.length || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = rooms.length;
        squares.push(q);
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** One level's moves: room by room at the push optimum where the level cuts into rooms, else the fallbacks. */
function solveLevel(text) {
  const level = parseLevel(text);
  const { w, wall, goals, boxes, player } = level;
  if (boxes.length === 0) return '';
  const goalMask = new Uint8Array(wall.length);
  for (const g of goals) goalMask[g] = 1;
  if (boxes.every((b) => goalMask[b])) return '';

  const rooms = roomsOf(level, goalDistances(w, wall, goals));
  if (rooms !== null) {
    let playerPos = player;
    let moves = '';
    let complete = true;
    for (const room of rooms) {
      const subWall = wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const s of other.done ? other.goals : other.boxes) subWall[s] = 1;
      }
      const solved = solvePushes(w, subWall, room.goals, room.boxes, playerPos, ROOM_BUDGET, false);
      if (solved === null) {
        complete = false;
        break;
      }
      moves += solved.moves;
      playerPos = solved.endPlayer;
      room.done = true;
    }
    if (complete) return moves;
  }

  const whole = solvePushes(w, wall, goals, boxes, player, LEVEL_BUDGET, false);
  if (whole !== null) return whole.moves;
  const rescued = solvePushes(w, wall, goals, boxes, player, GREEDY_BUDGET, true);
  if (rescued !== null) return rescued.moves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
