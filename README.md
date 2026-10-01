# Add to Terminal

Monorepo for the **Add to Terminal** toolchain: select code in VS Code, press one key, and the reference lands in the input box you are actually typing in — a terminal, or a **DSH Web composer draft**.

```
packages/
  vscode-add-to-terminal/   VS Code extension: picks the reference, renders it, delivers it
  dsh-add-to-terminal/      DSH plugin (publishable to npm): bridge host + Web page writer
```

## How the two halves work together

```
VS Code  ──Ctrl+Alt+T──▶  extension sink
                             │  destination = dsh
                             ▼
                    HTTP (loopback + token)          ┌─ DSH host half: /dsh-add-to-terminal/*
   dsh-add-to-terminal (DSH) ────────────── SSE ──▶  ┤  rendezvous, queue-free, ack'd
                                                     └─ DSH page half: writes the composer draft
```

- The extension reads `<os.tmpdir()>/dsh-add-to-terminal/bridge.json` (URL + per-process token), so nothing is configured by hand and a random port works.
- The page half only opens its stream after `/ping` proves the bridge answers; if DSH is simply not running, the extension stays quiet and references go to the terminal.

Each package has its own README with protocol details, safety rules and known limits:

- [`packages/dsh-add-to-terminal/README.md`](packages/dsh-add-to-terminal/README.md)
- [`packages/vscode-add-to-terminal/README.md`](packages/vscode-add-to-terminal/README.md)

## Quick start (contributors)

```bash
pnpm install
pnpm build          # build every package
pnpm check          # offline suites for the DSH plugin (host 23 + client 28)
pnpm compile        # compile the VS Code extension
pnpm vsix           # package the extension as a .vsix
```

> The extension keeps its published identity (`name: add-to-terminal`, `publisher: EeLynn`) so existing installs upgrade normally.

## Installing (users)

1. **VS Code extension** — from the Marketplace: search **Add to Terminal** (0.5.0+), or install a `.vsix`.
2. **DSH plugin** — in DSH Web: *Settings → Plugins* → enable `dsh-add-to-terminal`, or
   ```bash
   dsh plugin --profile web add dsh-add-to-terminal
   ```
   Offline / unstable registry? Install the tarball instead: `dsh plugin --profile web add ./dsh-add-to-terminal-0.2.1.tgz`

Then open a DSH Web page; the extension's Explorer sidebar shows a **DSH 页面** section listing open pages. Click one to connect, and press `Ctrl+Alt+T` in the editor from then on.

## Publishing

```bash
pnpm --filter dsh-add-to-terminal publish --access public   # DSH plugin (also runs the build)
pnpm --filter add-to-terminal publish                       # VS Code extension (vsce)
```

## Notes

- Design notes, the full option comparison and both incident write-ups: [`docs/DESIGN.md`](docs/DESIGN.md). (The live-bridge verification scripts still live in a separate `dsh-info` repo — they are machine-specific.)
- Do **not** hand-write a `link:` dependency into a DSH profile to enable the bridge: DSH rejects startup when an explicitly enabled plugin fails to activate. Use the plugin manager, or a file-path row in `cordis.patch.yml` (documented in the plugin README) for local debugging.

## License

MIT
