# Tauri desktop scaffold (optional)

A minimal Tauri v2 wrapper around the static app, if you want a native window
instead of double-clicking `index.html` from the zip. The zip (`node
tools/package-zip.js`) is the primary desktop path and needs nothing here.

## Layout

```text
tauri-src/
  tauri.conf.json     # frontendDist points at the repo root (index.html)
  src-tauri/
    Cargo.toml
    build.rs
    src/main.rs
    src/lib.rs
```

## Build

```bash
cargo install tauri-cli   # once
cd tauri-src/src-tauri
cargo tauri build         # or: cargo tauri dev
```

Tauri serves the repo root directly (`frontendDist: ".."`), so the app runs
exactly as it does from the zip — no bundling step, no copy of the statics.

Notes:
- Not wired to CI or the zip builder; it is a starting point.
- Bundling icons are not included; add them under `src-tauri/icons/` and
  reference them in `tauri.conf.json` `bundle.icon` when packaging for release.
