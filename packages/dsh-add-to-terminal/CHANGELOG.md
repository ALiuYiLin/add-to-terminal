# Changelog

## 0.2.1 — first public release

DSH-side half of the [Add to Terminal](https://github.com/ALiuYiLin/add-to-terminal) bridge:
references selected in VS Code land in the DSH Web composer draft, unsubmitted.

- **Host half**: loopback HTTP rendezvous under `/dsh-add-to-terminal`
  (`/ping`, `/targets`, `/context`, `/push`, `/stream`, `/present`, `/ack`),
  a bearer-token discovery file in the OS temp directory, SSE delivery with an
  ack, and a bounded queue-free design: nothing is written anywhere the page
  would not write it itself.
- **Client half**: one SSE connection per browser tab, session-aware label
  (`工作区 · 标题`), writes the draft through the public
  `conversation.input.left` → `inputActions` face, flashes `●` in the tab title
  so the receiving tab is obvious.
- **Page safety rules** (learned from a production incident):
  the SSE opens only after `/ping` proves the bridge answers, every reconnect
  goes through that probe with exponential backoff, module registration cannot
  throw into the boot audit, and `apply()` never throws. Without these, a page
  whose backend has no bridge sits in a hot `text/html` MIME-error retry loop
  and starves the app's own connection budget.
- **Host robustness**: the discovery file is republished on connect and every
  30 s (self-healing), and a disposing instance never deletes a newer
  instance's file — safe under live plugin reloads.
- **Diagnostics**: `/targets` reports each page's `client` build, `stage`
  (`loaded → applied → slot-registered → seated`), and last client-side `note`.
- TypeScript sources (`src/`) compiled to `lib/`; `npm run check` runs the
  host and client suites against the compiled output.

Known limitation: the client half is served from the package, so after changing
it a DSH restart (or a page reload) is required — client-artifact HMR did not
pick up in-process changes in testing.
