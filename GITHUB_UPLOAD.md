# Sonic Unleashed Web Port — GitHub Handoff

Updated: 7 October 2026.

Repository: [Kasisondr/sonic-unleashed-webport](https://github.com/Kasisondr/sonic-unleashed-webport).

## What to push

Push the **source project inside `unleashed-web`**, not the parent Downloads folder.
Keep the folder structure intact. The source is already saved in local commit
`8aee2e3`, with this guide in a separate local documentation commit.
Git pushes both commits together; you do not need to upload files one by one.

Include these root files:

- `.gitignore` — excludes local tools, builds and game data.
- `CMakeLists.txt` — native helper build configuration.
- `LICENSE` — the repository's existing MIT license.
- `README.md` — setup, asset conversion and running instructions.
- `STATUS.md` — implemented features, validation and remaining differences.
- `GITHUB_UPLOAD.md` — this handoff and upload checklist.
- `requirements-dev.txt` — Python dependencies.
- `upstream-pin.json` — pinned upstream source revisions.

Include these folders and their tracked contents:

| Folder | Contents |
| --- | --- |
| `web/` | Browser renderer, controls, player, collisions, loop routes, missions, menus and styling. Exclude `chip_avatar.png`. |
| `tools/` | Disc/archive parsers, asset exporters, build helpers and validation scripts. |
| `tests/` | Python and JavaScript regression tests. |
| `src/` | Prototype guest-memory support. |
| `probes/` | Earlier WebAssembly feasibility probe source. |
| `docs/` | Reference observations and coverage notes. |
| `third_party/` | License and attribution notices. |

The exact file list appears at the end of this document.

## What to keep local

Do **not** manually upload these folders or files:

- `.git/` — Git's local database; `git push` handles repository history.
- `.tools/` — the local Python environment and installed packages.
- `upstream/` — downloaded dependency checkouts; bootstrap scripts fetch them.
- `build/` — native tools, caches, test reports and screenshots.
- `private/` — extracted executables, shaders and title-update data.
- `generated/` — recompiled game code and generated headers.
- `dist/` — local browser build containing extracted game assets.
- Game archives and inputs, including `.iso`, `.7z`, `.xex`, `.xexp` and `.ar` files.
- Extracted textures, models, music, sound effects and movies.
- `web/chip_avatar.png`, `.DS_Store`, Python caches and log files.

The existing `.gitignore` excludes these local paths. The parent
`sonic unleashed game rom` folder is outside this source repository and must
also stay local. Do not use `git add -f` to include ignored game data.

## Push from this Mac

Open Terminal and enter the project folder:

```sh
cd "/Users/kas/Downloads/webporting games on mac/unleashed-web"
```

Check the destination and current changes:

```sh
git remote -v
git status --short
git log -1 --oneline
```

`origin` is already configured as:

```text
https://github.com/Kasisondr/sonic-unleashed-webport.git
```

Check GitHub sign-in:

```sh
gh auth status
```

If you are not signed in, start a fresh login. An earlier one-time device code
may have expired; use the new code displayed by this command:

```sh
gh auth login --hostname github.com --git-protocol https --web
```

Complete GitHub's sign-in/authorization page yourself. Do not put a password or
access token in the repository or send it in chat. GitHub CLI is installed on this
Mac. Its authorization page displays the account permissions it requests.

Configure Git to use that login, then push the prepared commits:

```sh
gh auth setup-git
git push -u origin main
```

If Git reports that the remote has newer commits, stop and reconcile those
changes before retrying. Do not force-push over them.

## What this publication contains

This is a **source-code publication**, not a hosted playable game. A fresh clone
needs locally supplied game files and the asset preparation commands in
[README.md](README.md). Uploading the source alone does not create a playable
GitHub Pages build.

The project is a browser reimplementation using original game assets locally.
It does not yet execute the complete original Sonic Unleashed runtime.

## Fixes included in the source commit

- **First Windmill Isle island crossing:** jump-board quaternion rotation,
  source launch speeds and control-lock duration are retained. The controller
  preserves launch momentum instead of immediately reducing it to running speed.
- **Loop camera:** supported original SV Bezier routes guide loop traversal.
  The camera stays upright, respects unchanged-camera source triggers and
  handles repeated turns in both directions.
- **Collisions:** swept capsule approximations stop Sonic at solid terrain
  walls and ceilings while retaining sliding. Camera obstruction shortens
  its distance rather than lifting it above buildings. Respawning clears
  launch and route state.

These are browser approximations over exported render geometry. Original Havok
collision, moving platforms, full stage scripting, rails, bosses and Werehog
systems remain incomplete. See [STATUS.md](STATUS.md) for the complete scope.

## Validation completed before this handoff

| Check | Result |
| --- | --- |
| Python regression suite | 19 passed |
| JavaScript regression suite | 25 passed |
| First-gap jump trials | 8 passed: two boards, 30/60 Hz, with/without boost |
| Windmill loop-route checks | Both supported loop routes finished with stable camera yaw |
| Scene assets and spawn surfaces | All 38 checked successfully |
| Browser smoke check | Windmill Isle entered gameplay, Sonic grounded, audio running, zero reported rendering errors |

These checks do not prove that every original act or the full campaign is
playable from beginning to end. Some checks require the locally exported assets.

Commands to repeat the checks after setup and asset generation:

```sh
.tools/bin/python -m unittest discover -s tests -v
node --test tests/*.test.mjs
node tools/check_scenes.mjs
node tools/check_gameplay.mjs
```

## Exact source file list

This is the tracked source manifest at the time of the handoff, plus this guide.
Future source edits may add files; always review `git status` before committing.

```text
.gitignore
CMakeLists.txt
GITHUB_UPLOAD.md
LICENSE
README.md
STATUS.md
docs/reference-audit.md
probes/browser_core.cpp
probes/index.html
probes/upstream_context.cpp
requirements-dev.txt
src/guest_memory.h
tests/collision.test.mjs
tests/light-field.test.mjs
tests/missions.test.mjs
tests/player.test.mjs
tests/pose.test.mjs
tests/render-math.test.mjs
tests/test_gameplay.py
tests/test_graphics.py
tests/test_input.py
tests/test_vertices.py
third_party/HedgeGI-LICENSE.md
third_party/HedgeLib-LICENSE.txt
third_party/Kunai-LICENSE
third_party/SharpNeedle-LICENSE
third_party/vgmstream-LICENSE
tools/audit_input.py
tools/bootstrap_upstream.py
tools/build_probe.py
tools/check_gameplay.mjs
tools/check_scenes.mjs
tools/compile_game_probe.py
tools/csd.py
tools/diag_bind.py
tools/diag_bind2.py
tools/diag_bind3.py
tools/diag_limb.py
tools/diag_match.py
tools/diag_meshes.py
tools/diag_pose.py
tools/diag_skin.py
tools/disc.py
tools/dump_rig.py
tools/export_apotos_props.py
tools/extract_update.cpp
tools/generate_game.py
tools/hkx.py
tools/hkx_anim.py
tools/host_prelude.h
tools/make_browser_context.py
tools/menu_archive.py
tools/mirage.py
tools/prepare_game_sfx.py
tools/prepare_gameplay.py
tools/prepare_graphics.py
tools/prepare_menu.py
tools/prepare_missions.py
tools/prepare_movies.py
tools/prepare_scene_catalog.py
tools/prepare_sky.py
tools/prepare_sonic.py
tools/prepare_sonic_anims.py
tools/prepare_stage.py
tools/prepare_stage_audio.py
tools/prepare_ui.py
tools/serve_probe.py
tools/test_game_functions.py
tools/vertex_arrays.py
upstream-pin.json
web/audio.mjs
web/cinematics.mjs
web/collision.mjs
web/csd-runtime.mjs
web/index.html
web/input.mjs
web/light-field.mjs
web/menu.mjs
web/missions.mjs
web/play.css
web/play.html
web/play.mjs
web/player.mjs
web/pose.mjs
web/render-math.mjs
web/renderer.mjs
web/routes.mjs
web/scene.mjs
web/style.css
```
