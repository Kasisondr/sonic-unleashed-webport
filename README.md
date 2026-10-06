# Sonic Unleashed browser port

A browser gameplay prototype using locally extracted Sonic Unleashed assets.
It **does not execute the original game runtime**. The original story,
Werehog combat, enemies, scripted cameras, stage events and full progression
are not yet ported.

The menu uses the disc's Ninja CSD layouts, textures and audio. New game plays
the original opening and launches Windmill Isle; Continue restores the browser
save; Stage select opens 21 daytime acts and 17 town environments for exploration.
Sonic uses the original model, bone tables and inverse binds with 13 disc
animations. Running, steering, jumping, boosting, rings, springs, dash panels,
jump boards and goals use a custom JavaScript controller.

The controller now preserves source jump-board rotation, launch speed and control
lock duration so the first Windmill Isle island crossing is reachable. Original
SV Bezier routes guide supported loops. Solid terrain triangles stop Sonic at
walls and ceilings; camera obstruction shortens the view instead of lifting it
above a building. Source mode triggers respect the unchanged-camera setting.
This is a browser collision fallback, not the original Havok simulation.

The renderer now uses original light definitions and material normal/gloss maps,
and samples the disc's light-field probes. Exact graphics parity still requires
the original terrain GI atlas, shader and post-processing pipeline. The current
water/grass effects and browser challenge scoring are approximations.

The Sega logo, Hedgehog Engine logo, idle title demo and opening are converted
from the disc's SFD movies. The opening's audio is an AIX container of three
stereo ADX layers; it is demuxed and decoded with vgmstream before downmixing.
The title demo starts after 30 seconds of title-screen inactivity or through
Watch title demo. Movies can be skipped with Enter, A or the skip button.

See [STATUS.md](STATUS.md) for scope and validation.

## Running it

This repository contains source and asset-conversion tools. Game archives,
extracted models/textures, music and movies are **not included**. On a fresh clone,
complete the Python/native-helper setup and asset regeneration below using your
own local disc image before starting the preview.

```sh
.tools/bin/python tools/serve_probe.py
```

Open <http://127.0.0.1:8778/>. Press Enter or click the title to enter the menu.
The browser requires a gesture to enable audio; initial logo playback may be
muted. Mouse/keyboard utility controls appear at the bottom on hover or focus.
Gameplay supports keyboard and gamepad; Esc returns to the menu and R respawns.
Continue saves the latest scene, safe position, heading, rings, score and collected
objects in localStorage. This save is separate from the original Xbox save format.

## Regenerating the assets

Install the pinned packages in `requirements-dev.txt`; build the native LZX and
vgmstream helpers described below. Extracted/derived assets stay in ignored
`private/`, `build/` and `dist/` directories.

```sh
.tools/bin/python tools/prepare_stage.py "<iso>"
.tools/bin/python tools/prepare_sonic.py "<iso>"
.tools/bin/python tools/prepare_sonic_anims.py "<iso>"
.tools/bin/python tools/prepare_sky.py "<iso>"
.tools/bin/python tools/prepare_ui.py "<iso>"
.tools/bin/python tools/prepare_menu.py "<iso>"
.tools/bin/python tools/prepare_stage_audio.py "<iso>"
.tools/bin/python tools/prepare_scene_catalog.py "<iso>"
.tools/bin/python tools/prepare_game_sfx.py "<iso>"
.tools/bin/python tools/prepare_graphics.py "<iso>"
.tools/bin/python tools/prepare_gameplay.py "<iso>"
.tools/bin/python tools/prepare_missions.py "<iso>"
.tools/bin/python tools/prepare_movies.py "<iso>"
cp web/* dist/probe/
```

`prepare_scene_catalog.py` supports repeated `--stage` arguments, resumes completed
exports, and publishes only ready scenes. Terrain uses original instance transforms,
UV channel zero for diffuse textures, and triangle strips even without restart
markers. Vertex indices are 16-bit; index-buffer *lengths* are not limited to 65,535.
The exporter vectorizes vertex decoding while keeping the scalar decoder as a
regression reference.

### Native asset helpers

After creating `.tools` and running `tools/bootstrap_upstream.py` as shown below,
build the LZX decompressor:

```sh
.tools/bin/cmake -S . -B build/host -G Ninja -DCMAKE_MAKE_PROGRAM="$PWD/.tools/bin/ninja" -DCMAKE_BUILD_TYPE=Release
.tools/bin/cmake --build build/host --target x_decompress -j 4
```

The movie and sound exporters use this pinned vgmstream CLI build. Skip the clone
when the checkout already exists:

```sh
git clone https://github.com/vgmstream/vgmstream.git build/tools/vgmstream-src
git -C build/tools/vgmstream-src checkout 71e2361042531fe767fb98300cf8c1ee95e539a0
.tools/bin/cmake -S build/tools/vgmstream-src -B build/tools/vgmstream-build -DCMAKE_BUILD_TYPE=Release -DBUILD_CLI=ON -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC=OFF -DBUILD_AUDACIOUS=OFF -DBUILD_V123=OFF -DUSE_ATRAC9=OFF -DUSE_CELT=OFF -DUSE_FFMPEG=OFF -DUSE_G719=OFF -DUSE_G7221=OFF -DUSE_MPEG=OFF -DUSE_SPEEX=OFF -DUSE_VORBIS=OFF
.tools/bin/cmake --build build/tools/vgmstream-build -j 4
```

## Validation

```sh
.tools/bin/python -m unittest discover -s tests -v
node --test tests/*.test.mjs
node tools/check_scenes.mjs
node tools/check_gameplay.mjs
```

The pose check skins every vertex at five samples of every exported animation.
The scene check verifies geometry/texture/audio paths and controller spawn surfaces.
For browser exploration starts that depend on unimplemented set objects, the checker
can write a nearby terrain start with `--repair-spawn`; it preserves the disc's
`spawn` and records the alternate in `browserSpawn`. This does not recreate the
original starting sequence or prove that a complete act is traversable.
The gameplay check uses the real Windmill Isle terrain: both first-gap boards
must land at 30/60 Hz with and without boost, and both supported loop routes must
finish with an upright camera. Asset-dependent checks require the local exports.

Format references include [SharpNeedle](https://github.com/hedge-dev/SharpNeedle),
[Kunai](https://github.com/NextinMono/kunai), and
[HedgeLib](https://github.com/Radfordhound/HedgeLib/blob/6b51064d80174516cf50a4146e1f561c28c2b381/HedgeLib/src/models/hl_hh_model.cpp).
License copies are in `third_party/`. Movie conversion uses the FFmpeg executable
bundled by imageio-ffmpeg; CSB/AIX decoding uses vgmstream.

Lighting/probe format and scattering references also include
[HedgeGI](https://github.com/blueskythlikesclouds/HedgeGI); its MIT license is
retained in `third_party/HedgeGI-LICENSE.md`.

## The earlier compilation checkpoint

This project started as a XenonRecomp feasibility study. The local Xbox 360 disc
and title update match the versions supported by the pinned
[UnleashedRecomp](https://github.com/hedge-dev/UnleashedRecomp) source. Its
XenonRecomp tool generated 66,833 mapped functions across 261 game-code
translation units. All 261 compile to WebAssembly objects. Four isolated,
dependency-free game functions also ran in WebAssembly and matched their native
results across 16,384 calls per target.

That whole-game route is still unproven; the playable stage above is a
data-driven reimplementation that reads the disc directly rather than
executing the original binaries.

## Reproduce the checkpoint

Run these commands from this folder on macOS with Git, Python 3 and the Xcode command-line tools installed. Emscripten 4.0.20 was used for this checkpoint. The existing SDK in the sibling Super Sponge project is reused below; another installation can be sourced instead.

```sh
python3 -m venv .tools
.tools/bin/python -m pip install -r requirements-dev.txt
.tools/bin/python tools/bootstrap_upstream.py
.tools/bin/cmake -S . -B build/host -G Ninja -DCMAKE_MAKE_PROGRAM="$PWD/.tools/bin/ninja" -DCMAKE_BUILD_TYPE=Release
.tools/bin/cmake --build build/host --target XenonRecomp XenonAnalyse extract_update -j 4
source ../supersponge-web/vendor/emsdk/emsdk_env.sh
.tools/bin/python -m unittest discover -s tests -v
.tools/bin/python tools/build_probe.py
```

To prepare locally supplied game files, first extract the disc archive to an ISO. If the title update is a package, extract its executable patch with the native helper. On this machine the validated candidate already exists, so the extraction command should be skipped when rerunning the checkpoint; the helper refuses to overwrite it.

```sh
mkdir -p private
build/host/extract_update '../sonic unleashed game rom/Sonic Unleashed Title Update #2/TU_19KA20I_000000C000000.00000000000G3' private/candidate-default.xexp
.tools/bin/python tools/audit_input.py '../sonic unleashed game rom/Sonic Unleashed (Europe) (En,Ja,Fr,De,Es,It).iso' --update private/candidate-default.xexp
.tools/bin/python tools/generate_game.py
.tools/bin/python tools/compile_game_probe.py --units all
.tools/bin/python tools/test_game_functions.py
```

The ISO auditor reads the disc directory and extracts only the executable and shader archive. The executable, shader archive and update patch must pass upstream XXH3 checks before use. It does not install the complete title update or stage game assets for gameplay. Code generation preserves the upstream function addresses and hooks.

To open the separate runtime probe:

```sh
.tools/bin/python tools/serve_probe.py
```

Visit <http://127.0.0.1:8778>. The server serves only `dist/probe`. If the preview is already running, use that server instead of starting a second one.

## Source and output layout

| Path | Purpose |
| --- | --- |
| `upstream-pin.json` | Exact upstream and recompiler revisions |
| `tools/` | Input validation, patch extraction, code generation and checks |
| `src/guest_memory.h` | Prototype translation of guest addresses to allocated regions |
| `probes/` | Small browser runtime test, independent of game execution |
| `tests/` | Synthetic disc-reader boundary and path checks |
| `private/` | Local executable, shader archive and executable patch; ignored |
| `generated/` | Derived browser header and game C++; ignored |
| `build/` | Native tools, WASM objects, reports and diagnostics; ignored |
| `dist/probe/` | Developer runtime preview; ignored |

Game inputs and generated game code remain local and are excluded from Git. The upstream project and its dependencies retain their respective licenses; attribution and license files are in the pinned checkout. This checkpoint does not produce a distributable game build.
