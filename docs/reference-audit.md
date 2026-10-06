# Reference coverage and remaining differences

Reference: [Sonic Unleashed — Full Game (4K), Sonic Central](https://www.youtube.com/watch?v=VYy6W9HG7oA).
The video is approximately 5:18:27 and shows Unleashed Recompiled PC gameplay.
The prior browser audit observed the samples below and saved screenshots.
It did not watch the complete video. This document is a partial audit, not a
complete timestamped gameplay specification.

| Observed time | Observed behaviour | Browser coverage |
| --- | --- | --- |
| 15:13 | Windmill Isle daytime play, side-on curved traversal; lives/time/score at top left and rings/speed/energy at bottom left | Original assets and a custom HUD/controller; curved guide paths and correct 2D constraints are missing |
| 16:43 | Sonic reaches the large goal ring | Source GoalRing triggers browser completion; original finish animation/camera are missing |
| 16:48 | Results show time 02:44:76, rings 45400, speed 13762, enemy 11500, tricks 19849, total 149034, Next prompt | Browser results/retry exist; original category formulas and ranks are not reproduced |
| 16:50 | XP upgrade allocation | Not implemented |
| 16:55 | Miles Electric loading transition | Not implemented as the original sequence |

Prior observations were saved locally in build/reference/daytime-hud-15m13s.png
and build/reference/results-16m48s.png. A single result does not establish the
original rank formula or bonus rules.

## Original scripting data found

The hashed stage structure archives contain PointMarker checkpoints,
ChangeMode_3Dto2D/ChangeMode_3DtoForward entries, ChangeVolumeCamera references,
EventCollision target lists, original enemy placements and XML Bezier guide
paths (StageGuidePath.path.xml and stage-specific path files). Goal/checkpoint
and death-plane coordinates are extracted into game/missions.json. The full
script graph, camera targets, path constraints and enemy behaviours still need
runtime implementations; their presence in data does not mean they work.

## Mission architecture

web/missions.mjs evaluates reusable trigger shapes and explicit states:
LOADING, INTRO, READY, PLAYING, RESPAWNING, COMPLETE/FAILED and RESULTS.
web/play.mjs connects events to control gating, audio, HUD, respawn, collected
objects and persistent browser saves. Goal completion is triggered by actual
object contact; typed challenges use collected/defeated/timer/score events.
The four extra Windmill challenges and default scoring/progression rules are
browser additions, not verified original missions.

## Graphics architecture

tools/prepare_graphics.py exports material/light/effect metadata and original
map images. web/scene.mjs consumes these records; web/light-field.mjs samples
original HE1 probe trees. web/render-math.mjs supplies correct shadow matrices
and conservative clipping. Exact original graphics require the compiled shader
pipeline and terrain GI atlas/UV1 integration; current water/post effects are
not a parity implementation.
