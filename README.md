# gtav-mapagent

An AI-assisted map editor for GTA V / FiveM. You fly a camera through the real GTA V world, describe a scene in chat ("set up a small camp: a fire in the middle, three benches facing it, two tents behind"), and a Claude agent places, checks, looks at and fixes the props until an independent reviewer accepts the result. Maps are saved as `.ymap` files and can be exported as ready-to-use FiveM resources.

It is a personal, local tool: the AI runs on your machine through your own Claude account, and only the exported maps go to a server.

## How it works

```
┌──────────────────────── Electron editor (editor/) ────────────────────────┐
│  Scene panel          3D view (CodeWalker window embedded)        Chat    │
│  props, folders,      camera toolbar: 3D/2D, presets, focus       builder │
│  undo/redo, export                                                agent   │
└───────────────┬───────────────────────────────────────────────────┬───────┘
                │ HTTP on 127.0.0.1:35873                           │ Claude Agent SDK
┌───────────────▼────────── CodeWalker fork (codewalker/) ──────────┐ │
│ LocalApi: place/move/delete props, geometric validation,         │ ├─ builder session
│ annotated screenshots, camera control, undo, open/save ymaps     │ └─ critic session (read-only tools)
└───────────────────────────────────────────────────────────────────┘
```

- **CodeWalker** (vendored from [dexyfex/CodeWalker](https://github.com/dexyfex/CodeWalker)) renders the real game world from your GTA V install. The fork adds a localhost API (`CodeWalker/LocalApi/`) and an embedded mode where it runs as a child window of the editor with its own UI hidden.
- **The editor** (`editor/`) is an Electron app that owns the whole UI and drives CodeWalker through that API.
- **The builder agent** works through tools: search props, place/move/delete them (camera-relative, world north/east, or turned to face another prop), organise them into folders, and save/export.
- **Geometric validation** runs after every placement: overlaps with other props (oriented boxes), collisions with buildings and other world geometry, floating/buried/overhanging props and steep ground, each with a suggested fix.
- **Visual feedback**: `look_at_scene` renders the scene from several viewpoints and annotates each image with prop footprints, `#id` labels, front-facing arrows, validation colours and a north arrow.
- **Independent critic**: when a scene is built, a separate agent session that only sees the user's request, the builder's acceptance checklist and the scene (through read-only tools) returns a structured pass/fail verdict with concrete fixes. The builder iterates, up to 5 reviews per request.

## Requirements

- Windows 10/11, x64, DirectX 11 GPU
- GTA V (PC) installed; CodeWalker reads the game files from it
- A recent [.NET SDK](https://dotnet.microsoft.com/download) (tested with 9; builds the .NET Framework 4.8 CodeWalker project)
- [Node.js](https://nodejs.org) 18 or newer
- [Claude Code](https://code.claude.com) installed and signed in (`claude`, then `/login`). The agent uses that login; no API key is needed.

## Setup

```sh
git clone https://github.com/cngil/gtav-mapagent.git
cd gtav-mapagent/editor
npm install
npm run start:all
```

`start:all` builds CodeWalker and the editor, then starts the editor, which launches CodeWalker embedded. On the very first run CodeWalker asks for your GTA V folder; it remembers it afterwards. Loading the world takes a little while.

Later runs:

| Command | When |
| --- | --- |
| `npm start` | Only the editor (`editor/`) changed |
| `npm run start:all` | CodeWalker changed too (rebuilds `CodeWalker.exe`; close the editor first, the exe is locked while it runs) |

## Using it

- **Camera**: click the 3D view, then WASD + mouse. The toolbar above the view switches 3D/2D (top-down map), jumps to eye level or a bird's-eye view, turns north, orbits 90° around what you look at, and focuses on the nearest group of props (press again for the next group). Double-click a prop in the scene panel to focus it.
- **Chat**: point the camera where you want to build and describe the scene. The agent shows its acceptance checklist, builds, and posts what it saw (thumbnails, click to enlarge) and each review verdict. *Stop* interrupts; *New chat* clears the conversation but keeps the props.
- **Scene panel**: all props in the map, grouped in folders (drag props onto a folder, double-click to rename), with show/hide per prop or folder (editor only; hidden props are still saved), delete, and undo/redo (`Ctrl+Z` / `Ctrl+Y`; one agent request is one undo step).
- **Maps**: *New*, *Open* (`.ymap`), and *FiveM'e aktar* (export), which saves `maps/<name>.ymap` plus its folder layout and writes a FiveM resource to `maps/fivem/<name>/`. Copy that folder into your server's `resources` and add `ensure <name>`.
- **Status bar**: CodeWalker state, what the agent is doing (e.g. looking at the scene), token usage and plan limits, and the model picker (models available to your Claude account; the choice is remembered).

## Repository layout

```
codewalker/                      CodeWalker source (vendored)
  CodeWalker/LocalApi/
    LocalApiServer.cs            HTTP API, validation, undo history, camera control
    PlacementGeometry.cs         oriented boxes, overlap test, collision sampling
    FrameCapture.cs              reads rendered frames back from the GPU
    SceneLook.cs                 annotates captured frames for the agent
    EmbedHost.cs                 hosts the world view inside the editor window
editor/
  src/main.ts                    Electron main process: launches CodeWalker, IPC
  src/agent.ts                   builder agent: tools and system prompt
  src/critic.ts                  independent reviewer session
  src/inspection.ts              read-only tools shared by builder and critic
  src/codewalker.ts              client for the LocalApi
  src/layout.ts                  folders and visibility (<map>.layout.json)
  src/export.ts                  save and FiveM export
  renderer/                      UI (plain HTML/CSS/JS)
maps/                            saved maps and exports (not tracked)
```

## Configuration

Environment variables read by the editor, all optional:

| Variable | Default |
| --- | --- |
| `CODEWALKER_EXE` | `codewalker/CodeWalker/bin/Debug/net48/CodeWalker.exe` |
| `CODEWALKER_API` | `http://127.0.0.1:35873` |
| `MAP_OUTPUT_DIR` | `maps/` in the repository |
| `MAP_EDITOR_MODEL` | the model chosen in the UI, else your account's default |

## Local API

CodeWalker listens on `127.0.0.1:35873` only. Endpoints take and return JSON over `POST`:

- Scene: `/status`, `/search_props`, `/place_entity`, `/move_prop`, `/delete_prop`, `/list_props`, `/set_visibility`
- Checks and sight: `/validate`, `/look`
- History and files: `/undo`, `/redo`, `/new_map`, `/open_map`, `/save_project`
- Camera and embedding: `/get_camera_view`, `/camera/mode`, `/camera/preset`, `/camera/rotate`, `/camera/zoom`, `/camera/focus`, `/embed/bounds`, `/embed/release_focus`

Conventions: positions for placing are relative to the camera (`forward`, `right`, `up`) or world-aligned for moves (`north`, `east`); `worldHeading` is degrees counter-clockwise from north; a prop's front is its local −Y.

## Troubleshooting

- **Electron starts as plain Node** ("does not provide an export named BrowserWindow"): `ELECTRON_RUN_AS_NODE` is set in that shell; unset it.
- **The 3D view stays black or shows "loading" while the status says ready**: another CodeWalker from an earlier run may still hold the API port. Close stray `CodeWalker.exe` processes and restart.
- **Build fails with "file is locked by CodeWalker.exe"**: close the editor before `npm run start:all`.
- **The agent reports props floating right after the camera jumped far**: collision data streams in lazily; ask it to check again.
- **Costs**: a full build with several look/review rounds can use a noticeable share of your plan's limits. Token usage is shown in the status bar.

## License

CodeWalker is © dexyfex and contributors; see `codewalker/Notice.txt` for the licenses of its components (including a GPL-licensed FBX reading/writing library). Check those terms before sharing builds.
