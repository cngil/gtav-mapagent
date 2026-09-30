# Contributing

Bug reports, test results for the export platforms and pull requests are welcome. For anything bigger than a fix, open an issue first so we can agree on the approach.

## Project layout

```
codewalker/                      CodeWalker source (vendored from dexyfex/CodeWalker)
  CodeWalker/LocalApi/
    LocalApiServer.cs            HTTP API, validation, undo history, camera control
    PlacementGeometry.cs         oriented boxes, overlap test, collision sampling
    FrameCapture.cs              reads rendered frames back from the GPU
    SceneLook.cs                 annotates captured frames for the agent
    EmbedHost.cs                 hosts the world view inside the editor window
editor/
  src/app-info.ts                app name and id (rename the app here)
  src/main.ts                    Electron main process: CodeWalker, projects, autosave, IPC
  src/agent.ts                   builder agent: tools and system prompt
  src/critic.ts                  independent reviewer session
  src/inspection.ts              read-only tools shared by builder and critic
  src/codewalker.ts              client for the local API
  src/layout.ts                  folders and visibility (<map>.layout.json)
  src/export.ts                  export platforms
  src/projects.ts                projects, which chats belong to them, migration of older maps
  src/threads.ts                 chats: list, history, rename, delete
  src/transcript.ts              conversation messages → chat UI events (live and history)
  src/settings.ts                editor settings (settings.json)
  renderer/                      UI: plain HTML/CSS/JS, no framework or bundler
  assets/icon.svg                app icon; `npm run icon` renders icon.png and icon.ico
  scripts/                       Electron launcher, icon and banner renderers
docs/                            screenshot, social preview (`npm run banner`), llms.txt
maps/                            projects (not tracked), one folder each:
  <project>/project.json         name and dates
  <project>/<project>.ymap       the map, plus <project>.layout.json
  <project>/threads.json         the project's chats, pins and settled state
  <project>/exports/<platform>/  exports
```

## Development

```sh
cd editor
npm install
npm run start:all   # builds CodeWalker and the editor, starts the app
npm start           # editor only (after changing editor/)
npm run build       # type-check and compile editor/src to editor/dist
```

- Close the app before rebuilding CodeWalker; `CodeWalker.exe` is locked while it runs.
- Only one app instance can run at a time: CodeWalker's API port and the 3D scene are shared.
- The renderer runs under a strict Content Security Policy: no inline `<script>`, no inline `style="…"` attributes (set styles from script or use classes).
- Icons are an SVG sprite at the top of `renderer/index.html`; use `icon("name")` in script.
- Nothing can be drawn over the 3D view: CodeWalker is a native child window on top of the page. Panels, popovers and toasts must stay in the side panels, the toolbar or the status bar.
- Keep the agent's tools map-only. It has no file, shell or network tools, and that is on purpose.

## Local API

CodeWalker listens on `127.0.0.1:35873` only. Endpoints take and return JSON over `POST`:

- Scene: `/status`, `/search_props`, `/place_entity`, `/move_prop`, `/delete_prop`, `/list_props`, `/set_visibility`
- Checks and sight: `/validate`, `/look`
- History and files: `/undo`, `/redo`, `/new_map`, `/open_map`, `/save_project`
- Camera and embedding: `/get_camera_view`, `/camera/mode`, `/camera/preset`, `/camera/rotate`, `/camera/zoom`, `/camera/focus`, `/camera/settings`, `/embed/bounds`, `/embed/release_focus`

Conventions: positions for placing are relative to the camera (`forward`, `right`, `up`) or world-aligned for moves (`north`, `east`); `worldHeading` is degrees counter-clockwise from north; a prop's front is its local −Y. `list_props` also reports each prop's world `rotation` quaternion and `yaw`.

## Adding an export platform

Exports live in `editor/src/export.ts`:

1. Add an id to `EXPORT_TARGETS` and a label and one-line description to `EXPORT_TARGET_INFO`. The export form and the agent's `export_map` tool pick it up from there.
2. Add a `case` to `exportMap()` that writes into `path.join(source.dir, "exports", target)` and returns `result(path, nextSteps)`, where `nextSteps` tells the user how to install it.
3. Streaming formats copy the project's `.ymap` under its own file name (it is also the map's in-game name). Script formats use `exportedProps()`, which gives model, hash, position and GTA euler rotation for every prop.
4. Add the platform to the README table, and say in the pull request how you tested it (in-game, on a server, or only by inspecting the files).

## Pull requests

- `npm run build` must pass (CI also builds CodeWalker).
- Match the style around you: short comments that explain why, no drive-by refactors.
- For UI changes, include a screenshot.
