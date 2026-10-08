# Sonic Unleashed browser build — status

Updated 6 October 2026. This is a browser reimplementation using locally
extracted Xbox 360 assets. It does not execute the original game runtime and
is not a complete or visually identical port of Sonic Unleashed.

## Implemented

- Original Sonic model, 111-bone skeleton and 13 animations. Parent/child
  quaternion composition, matrix multiplication and original inverse binds are
  corrected. Arms, fingers and spin poses remain within character bounds.
- 21 daytime acts and 17 town environments selectable from the menu. Original
  terrain instance transforms, diffuse UVs, triangle-strip topology and large
  index buffers are decoded. Terrain streams by distance and uses conservative
  frustum culling. These are explorable environments, not 38 fully reproduced
  original levels. Shamar Town uses a nearby terrain spawn because its original
  starting sequence is not implemented.
- Original title/main-menu CSD assets, menu audio, Sega and Hedgehog Engine
  logos, title attract movie and opening movie. New game plays the opening;
  Continue resumes the browser save. The opening's AIX audio is decoded before
  AAC conversion. Movie seeking uses HTTP range responses.
- Original stage music and 11 gameplay effects, with keyboard/gamepad movement,
  jumping, boosting, rings, springs, dash panels, jump boards and goal objects.
- Original GoalRing, PointMarker and FallDeadCollision coordinates feed a
  reusable mission state machine. Intro/start, checkpoint/respawn, clear/fail,
  results, retry and browser saves are implemented. Current enemy combat,
  four Windmill challenge variants, lives/bonus rules and stage sequence use
  browser logic. Their scoring and ranks are explicitly labelled challenge
  results; they are not verified original scoring or storyline progression.

## Graphics changes

`tools/prepare_graphics.py` enriches every scene with the disc's light data,
material parameters, source-resolution textures and effect settings. All 791
archive lists now parse, including variable split counts, unsplit archives
and Japanese animation filenames. One added material, `myk_rock_hh_pot`, has no
matching source resource; all other exported material records resolve.

The renderer applies the original directional light orientation and colour,
normal/gloss/specular maps on UV0, diffuse/ambient/specular/emissive parameters,
opacity and supported texture wrap modes. Albedo lighting runs in linear
colour space. Original Rayleigh/Mie settings drive atmospheric scattering.
Sonic samples the original spatial light-field tree with trilinear probe
interpolation; terrain currently samples it at chunk centres. The latter is
an approximation to the original terrain lighting, not the original GI atlas.
The shadow view matrix and clip-volume tests are fixed; alpha-cutout foliage
casts shaped shadows instead of solid rectangles. Nearby point-light values
are applied, with at most eight lights selected per draw.

## Jump, loop and collision fixes

- The importer retains quaternion placement, normal/boost impulse speeds,
  control lock duration and multi-set launcher copies. JumpBoard elements are
  included alongside JumpBoard3D. A launcher preserves its speed/direction while
  controls are locked instead of being reduced immediately to normal run speed.
- First Windmill Isle gap boards 2351/2355 land on solid terrain about 48 metres
  from takeoff at both 30 and 60 Hz, with and without boost.
- Original SV Bezier edge pairs are sampled into world-space centrelines.
  Supported loop sections use browser route guidance; their camera stays upright
  and follows the entry direction through the vertical section. Source mode
  planes respect m_IsChangeCamera=false, and yaw interpolation handles repeated
  turns in either direction. Respawning clears guidance and launch state.
- Swept capsule approximations collide with opaque terrain walls and ceilings
  and allow sliding. Ground tests exclude vertical faces and require crossing
  from above. Water and vegetation cards are excluded from solids. Camera rays
  shorten the boom against walls instead of snapping above rooftops.
- These collision/route systems are browser approximations over render geometry.
  Original Havok meshes, moving platforms and complete scripted routes remain
  unported; this does not certify every act's traversal.

## Remaining differences and concrete blockers

- Original compiled Xenos shaders and the game's graphics command pipeline do
  not execute in this browser renderer. Shader translation and runtime
  integration are required for exact visual parity.
- Terrain GI atlases and UV1 mapping are recorded but not rendered. The
  renderer still lacks original HDR adaptation, bloom/star glare, depth of
  field, motion blur, accurate reflections/refraction and per-pixel static lighting.
  Current water, grass, particles and some HUD elements are custom approximations.
  Normal-map tangents are reconstructed from derivatives, not original tangent
  streams; UV1 material channels and border/mirror-once wrap are unsupported.
- Complete original collision/Havok behaviour, rails, guided movement,
  scripted cameras and correct 2D path constraints remain incomplete outside
  the supported SV routes. Full routes through every
  exported act have not been proven traversable.
- Original enemy AI, bosses, Werehog gameplay, NPC/story events, mission scripts,
  XP upgrades, scoring formula and storyline unlock graph are incomplete or
  absent. The Werehog entrance scene is intentionally unavailable.
- Only the four startup/title/opening movies are converted. Full story movie
  sequencing and original subtitle tracks are not integrated.
- The original recompiled game code compiles to WASM objects but is not linked
  into a working whole-game browser runtime. Kernel, memory, graphics, audio
  and physics integration remain major work.

## Main files changed

| File | Responsibility |
| --- | --- |
| `web/pose.mjs`, `tools/prepare_sonic_anims.py` | Skeleton composition, inverse binds and animation conversion |
| `tools/disc.py`, `tools/mirage.py`, `tools/vertex_arrays.py`, `tools/prepare_stage.py` | Archive lookup, original model/material data and terrain topology |
| `tools/prepare_scene_catalog.py`, `tools/check_scenes.mjs` | Scene publication and geometry/asset/spawn verification |
| `tools/prepare_graphics.py`, `web/scene.mjs` | Original material/light export, lighting, shadows and rendering |
| `web/light-field.mjs`, `web/render-math.mjs` | Spatial probe decoding/interpolation and render matrix helpers |
| `tools/prepare_movies.py`, `web/cinematics.mjs`, `web/menu.mjs`, `tools/serve_probe.py` | Original movies, menu flow and seekable local playback |
| `tools/prepare_game_sfx.py`, `tools/prepare_gameplay.py`, `web/player.mjs`, `web/play.mjs` | Audio, source launch/path data, browser movement, HUD and gameplay integration |
| `web/collision.mjs`, `web/routes.mjs`, `tools/check_gameplay.mjs` | Swept terrain/camera contacts, supported loop guidance and real-terrain regression checks |
| `tools/prepare_missions.py`, `web/missions.mjs` | Source trigger extraction, reusable mission states/objectives and browser progression |
| `tests/`, `docs/reference-audit.md` | Regression checks and explicitly limited reference observations |

## Verification

- 19 Python parser/input regression tests passed.
- 25 Node tests passed, including pose bounds across every exported animation,
  movement/jump/boost, mission state/failure/retry/save rules, shadow matrices,
  light-field interpolation and corrupt-pointer handling. Challenge-rank tests
  verify the browser rules only.
- All 38 scene geometry, texture and audio references and spawn surfaces passed
  `tools/check_scenes.mjs`. Original light-field samples are finite at every spawn.
- Browser checks: original menu navigation, stage loading, Start/Continue,
  original movie playback/skip, skinned Sonic, music and 11 effects. WebGL errors
  are checked during gameplay. Checkpoint/result loops are state-engine tests;
  this is not a claim of completing the full original campaign in the browser.
- Windmill Isle and Rooftop Run loaded with normal maps and spatial lighting
  active and zero reported rendering errors. Rooftop Run uses 99 source light
  records and 75 loaded normal maps. Menu → title movie → skip → Continue →
  Continue stage restored the saved scene and elapsed mission time.

See README.md for regeneration commands. Reference observations are in
[docs/reference-audit.md](docs/reference-audit.md). The complete five-hour video
has not been watched; no unobserved behaviour is claimed reproduced.

## Scenery and companion update — 8 October 2026

- Added local `prepare_chip.py` export of the original WhipRoot model, 112 bones,
  four textures and four original animation clips. Chip follows Sonic and talks
  during hints; the follow behaviour is custom browser code.
- Replaced one-time random grass placement with deterministic, material-aware
  surface sampling and streaming nearby instances. Flowers are sparse rather
  than present on every grass tuft; pavement and vegetation cards are excluded.
- Fixed material/primitive water flag mismatch, enabled animated sea shading,
  scene refraction and depth-based shoreline foam. Water is excluded from solid
  collision and opaque shadow casting. Sky reflection remains an approximation.
- Added restrained bloom from a quarter-resolution separable highlight blur.
  Scene targets are recreated after canvas resize. This is an LDR browser effect,
  not a restoration of the original game HDR pipeline.
- Limited simultaneous terrain fetches to four to avoid connection overload.

Validation: 30 JavaScript tests and 19 Python tests pass. Companion continuity,
triangle scatter bounds, material classification and existing gameplay are
covered. Exact original lighting/graphics parity remains unfinished.

Browser verification: Windmill renders through the bloom pipeline with terrain,
18,274 nearby grass instances, one visible water primitive and an active Chip
rig. Shader/GL diagnostics reported zero errors. Final movement screenshots
could not be captured after the browser automation connection became unavailable;
visual checks of Chip following and shoreline foam remain limited. Existing jump
and loop asset checks still pass with water excluded from solid geometry.

## Dash-pad ground collision fix — 8 October 2026

The source dash pads can apply 70–100 m/s impulses. Capsule walls were swept in
small steps, but feet were grounded only at the final frame position. Uphill
terrain could pass above Sonic's feet and then push the capsule farther under
the ramp. Grounded movement now follows nearby terrain before each 20 cm capsule
step and resolves floor contact after it. Airborne landings still require a
surface crossing, and genuine gaps still allow falling.

Validation: the uphill regression failed before the fix and now passes uphill
and downhill at 20/30/60 Hz without reducing pad speed. All 20 Windmill dash-pad
placements passed on extracted terrain at those three rates (60 trials), along
with the existing eight island-jump trials and two loop checks. The wall, ceiling,
camera and genuine-gap regression tests also pass. The local preview player
module is updated; these checks run against the source controller and disc data.
