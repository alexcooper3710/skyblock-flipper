# SkyBlock Terminal

A self-hosted Hypixel SkyBlock auction flipper. Same copy-and-paste workflow as
Cofl — you click a flip, it puts `/viewauction <uuid>` on your clipboard, you
paste it in chat — but nothing sits between you and the API.

## Why this is faster than a hosted flipper

It isn't faster than Hypixel. It's faster than *waiting your turn*.

The auction house snapshot only refreshes about once a minute
(`cache-control: max-age=60`, and the body carries its own `lastUpdated`). Hosted
flippers add a queue on top of that, and free tiers add a deliberate delay on top
of *that*. This app:

1. Reads `lastUpdated` from the snapshot it just processed.
2. Sleeps until ~800ms before the next one is due.
3. Probes page 0 every 250ms until `lastUpdated` actually moves.
4. Pulls all pages in parallel the instant it does (46 pages / ~45k auctions at
   the time of writing), diffs against the previous snapshot, and scores only the
   listings that are genuinely new.

So you see a snapshot within about a second of it existing, every minute, instead
of 30–60 seconds late. **The ceiling is the API's own refresh rate** — no client
can beat that, and anyone claiming otherwise is selling something.

## Two ways to run it

**The terminal** (recommended) - a local server you open in a browser:

```bash
npm run terminal      # then open http://127.0.0.1:8787
```

Windows: double-click **`run-terminal.bat`**, which starts it and opens the tab.

Six live panels: flip feed, item detail with price history, bazaar order book and
craft flips, market overview (movers / volume / spreads), watchlist, and alerts.
Storage is SQLite through **`node:sqlite`**, which ships inside Node 22.5+ - no
native build step and no postinstall download, so there is nothing that can
silently fail to install.

## The GitHub Pages build

`docs/` is a second build of the same terminal that runs **entirely in the
browser** - no server, no install, no `.bat`. Point GitHub Pages at
`main` / `docs` and it is just a URL you and anyone you send it to can open.

It works because the Hypixel auction and bazaar endpoints allow cross-origin
requests, so the page polls them itself. Verified from a non-Hypixel origin:
2,197 bazaar products and 45 auction pages came back fine. Item NBT is decoded
in-tab with a dependency-free parser (`docs/nbt.js`) that is cross-checked
against prismarine-nbt on real `item_bytes` in the test suite.

**The one real trade-off:** a browser tab only collects while it is open. Flip
detection needs two snapshots, so it is useful about two minutes after you open
it - but long-run history only accumulates while a tab is up, and each browser
keeps its own copy. If you want a machine quietly recording the market forever,
that is the server build.

Storage is IndexedDB in your own browser. The **save** button writes your
collected history to a real file; **load** reads one back - so you can keep it
wherever you like, or hand a snapshot to someone else. Your API key, if you set
one, is kept in that browser's local storage and never leaves it.

### One source of truth

The pricing, strategy and bazaar logic is **not** duplicated for the web build.
`npm run build:web` mechanically converts those modules from the server sources
into `docs/shared/`, and refuses to emit a file it could not fully convert. The
UI (`app.js`, `styles.css`) is copied, not forked. A fix to the bid/ask handling
lands in both builds or neither.

To try the browser build against the live API before publishing it:
`npm run terminal`, then open **http://127.0.0.1:8787/pages/**.

### Publishing it

Double-click **`publish-to-github.bat`**. It needs Git for Windows (not the
GitHub CLI), asks for your username, opens the page to create the empty repo,
pushes, and then opens the Pages settings. Sign-in happens in the browser, so
there is no token to paste anywhere.

Pages is free on a public repo - a subscription is only needed to publish Pages
from a private one. Nothing runs on GitHub: it serves nine static files and the
terminal does all its work in your browser, storing data on your own machine.

## Running the desktop app instead

Windows: double-click **`run-flipper.bat`** — it installs on first run, then launches.

Or by hand:

```bash
npm install
npm start          # the Electron app
npm run engine     # same engine, headless, prints to the terminal
npm test           # offline tests against real Hypixel item_bytes
```

## Sharing it with someone else

They do **not** need an API key, Node, or anything installed. The key (if you use
one) lives on your machine; they just open a URL.

Double-click **`run-terminal-shared.bat`**. It binds to your whole network and
prints the URLs to hand out:

```
  Share these with anyone on your network - no API key needed their end:
    http://192.168.1.24:8787
```

Windows will ask to allow Node through the firewall the first time - say yes for
**Private** networks only.

Guests get a **read-only** view: every panel, every chart, live updates. Writes
(watchlist edits, marking alerts read, and `/api/purge`, which deletes your whole
history) are refused from any address but your own machine unless they carry the
edit token the launcher prints. That token is generated once and saved, so you
can edit from your own phone with `?t=<token>` while everyone else just watches.

Outside your house, don't port-forward this - there's no login on it. Put both
machines on [Tailscale](https://tailscale.com) and share the Tailscale IP; it
behaves exactly like the LAN case.

### The API key

The auction and bazaar endpoints are public - the terminal works with no key at
all, at lower rate limits. To use one, either:

```bash
set HYPIXEL_API_KEY=your-key        # Windows, this shell only
export HYPIXEL_API_KEY=your-key     # bash
```

or copy `config.example.json` to `config.json` and fill in `apiKey`.
`config.json` is gitignored, so a key never ends up in a commit. On boot the
terminal prints which of the two it found.

## It remembers the market between runs

`auctions_ended` only hands out ~90 sales a minute, so a cold start needs the
full 45-minute window before sold-median pricing means anything. The price book
is written to `price-book.json` in the app's user-data folder every 60s and on
quit, and reloaded at launch (samples outside the window are dropped, a corrupt
file starts cold with a warning). So the second launch onward is useful
immediately instead of 45 minutes later.

## Copying without alt-tabbing

`Ctrl+Alt+1` … `Ctrl+Alt+5` copy the top five live flips from anywhere, so you
can stay in Minecraft. Clicking a row copies it too.

The window always opens centred on a display that currently exists, and only
after the first paint - a saved position from a monitor you no longer have is a
classic way to end up with an app that is "running" but nowhere on screen.

## The four strategies

| Strategy | What it prices against | When it's right |
|---|---|---|
| **Lowest-BIN snipe** | the second-lowest BIN for that exact variant | fast, no history needed, but the wall can be a lie |
| **Sold median** | trimmed median of `auctions_ended` over a rolling window | prices against money that actually moved |
| **Attribute-aware** | the attribute *pair*, then a shard-derived model | Kuudra gear and equipment, where the roll is the value |
| **Bazaar + craft** | order-book spread, and the enchanted-item conversion chain | steady, low-drama, scales with capital |

Items are keyed twice: a coarse `base` key that always has samples, and a
`variant` key carrying stars, recombobulator, hot potatoes, ability scrolls,
gemstones, pet level band, held item, skin, and the top two attributes. Variant
evidence always outranks base evidence, and sold data outranks listed data.

Valuation deliberately uses the **second** lowest BIN, not the lowest. You have to
undercut something to actually sell, and if two people dumped the same item at the
same low price, that price is the truth and the "flip" isn't one.

## If it won't start

`npm start` failing with *"Electron failed to install correctly"* means the
dependency tree installed but Electron's separate ~100MB binary download from
GitHub did not. The tell is `node_modules/electron` sitting at ~2MB with no
`path.txt` in it.

`run-flipper.bat` detects exactly that and repairs it: it clears
`node_modules\electron` **and** Electron's zip cache under
`%LocalAppData%\electron\Cache` (a truncated cached download fails identically),
reinstalls, and falls back to the npmmirror CDN if GitHub is unreachable. If it
still can't, it drops `flipper-run.log` and `npm-last.log` beside the script with
the real error in them.

## Known limitation: craft recipes

Hypixel removed recipes from `/resources/skyblock/items` — 0 of 5,650 items
currently ship one. Craft flips therefore run off
`src/main/engine/craft-ratios.json`, a bundled table of 75 conversions whose
item ids are all validated against the live bazaar product list. Add your own
entries there; the app picks them up on restart, and the engine logs any id it
can't find in the bazaar.

## A note on rules

This copies a command to your clipboard. You paste it, you look at the auction,
you decide. That's it — no clicking for you, no automated buying, no packet
injection. Keep it that way; automating the purchase is what gets accounts
banned, and it's not what this is for.
