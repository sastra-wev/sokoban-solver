# Sokoban Solver — push-optimal, room by room

[![Competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/sastra-wev/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/sastra-wev/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A Sokoban solver for the make.fun bounty [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121). One program, `main.ts` (Node 22, no dependencies), reads every instance of a set from `/input/<id>/level.txt` and writes its moves to `/output/<id>/solution.txt`.

## Why pushes, not moves

The checker scores a level by pushes alone: a solution in the level's push-optimal count P* earns the full 1,000 points, and every extra push more than halves it. A move-optimal search (like the house baseline's plain A*) spends its budget walking well instead of pushing well. This solver searches in push space and proves push optimality.

## How it works

- **Push-space states.** A state is the set of box squares plus the player's reachable region, named by its lowest square — between pushes the player walks freely, so only the region matters.
- **A\* over pushes.** The estimate is a minimum-cost matching of boxes to goals over precomputed lone-box push distances (how many pushes a box needs on an otherwise empty board). It never overestimates, so the first solution A\* settles is push-optimal.
- **Deadlock pruning.** A box on a dead square (one from which a lone box can never reach a goal) kills a state at birth, and a fixed-point freeze test catches boxes wedged against walls or each other that can never move again.
- **Room decomposition.** Levels from this competition's generator are a hallway with independent rooms off it, and a box can never leave its room. The solver cuts the level into rooms (the dead squares of the player's row are the hallway) and solves each room on its own with the other rooms' boxes standing as walls — the level's optimum is the sum of its rooms'. A level that does not cut, or a room that resists, falls back to a whole-level A\*, then a greedy best-first rescue, then an empty (but valid) answer.
- **Deterministic by construction.** All budgets are expanded-state counts, never the clock; every tie breaks by square and insertion order. Two runs on the same set write byte-identical answers.

## Results

On the kit's practice set the solver scores **1,000,000 / 1,000,000** — every instance solved in exactly P* pushes (13, 16, 29, 47, 60) — in about 0.4 s for the whole set. The house baseline (plain-astar 1.0.0) scores 200,000 on the same set. The solver was also cross-checked on 200 freshly drawn generator levels: every one solved at exactly P*.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<dir with i001..i005/level.txt> MAKEFUN_OUTPUT_DIR=out node main.ts
```

Without the environment variables it reads `/input` and writes `/output`, as the grader mounts them.
