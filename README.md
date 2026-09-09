# SkyBlock Terminal

A Hypixel SkyBlock auction and bazaar terminal that runs in a browser tab.

**→ [alexcooper3710.github.io/skyblock-flipper](https://alexcooper3710.github.io/skyblock-flipper/)**

That link is the whole thing. No install, no API key, no server, nothing to run.
Open it, and it polls Hypixel itself and shows you the market. Send the link to
whoever you like — it works the same for them.

## What this is, and what it isn't

It's a personal build. Cofl and the other established flippers are more mature
than this: they run servers that have been collecting price history for years,
they push alerts to you, and they have had far more eyes on their numbers. If you
want the best flip feed available, use one of those.

What this does that they don't: it runs on a page you own, costs nothing, has no
tier that delays your data on purpose, and shows its working — every number is
one you can trace to an endpoint or a formula in this repo. It was built to
understand the market rather than to beat anyone to it.

It is also not faster than Hypixel. Nothing is. The auction snapshot refreshes
about once a minute and every client on earth waits for the same one.

## The panels

The layout is yours: drag a tab onto another panel to move it, near an edge to
split, and drag the gaps to resize. `+ panel` adds one, `reset` puts it back. The
arrangement is saved in your browser.

| Panel | |
|---|---|
| **Flips** | every BIN currently listed under its own resale price |
| **Chart** | price history for one item — open as many as you want, they become tabs |
| **Bazaar** | the full book, 2,197 products, sortable by movers / spread / price |
| **Crafts** | every conversion priced, profitable or not, with the bottleneck named |
| **Market** | movers, volume, spreads |
| **Watchlist** | bid, ask and spread per item, with a sparkline |
| **Order book** | the depth ladder for one product |
| **Sold feed** | the tape — what actually changed hands, seconds ago |
| **Alerts / Log** | threshold hits, and what the engine is doing |

Click a flip and `/viewauction <uuid>` goes to your clipboard, same as Cofl.

## Where the numbers come from

**Live prices** come from Hypixel directly. The auction and bazaar endpoints
allow cross-origin requests, so the page polls them itself with no proxy in
between. Item NBT is decoded in the tab by a dependency-free parser
(`docs/nbt.js`) that the test suite cross-checks against prismarine-nbt on real
`item_bytes`.

**History does not exist in Hypixel's API.** It only ever answers "right now",
which is why every site with charts runs a collector. Two things fill the gap:

- **[Coflnet](https://sky.coflnet.com/api)** publishes their archive openly and
  with CORS enabled — hourly auction and bazaar history, and a typical-sale price
  per item. That is what makes a chart have a past the moment you open it.
  (Moulberry's endpoints are dead; both fail to fetch.)
- **A GitHub Action in this repo** runs the same engine every five minutes,
  computes the board, and force-pushes a snapshot to an orphan `market-data`
  branch. The page reads that on load, so it opens with a real market instead of
  a blank one, then live polling takes over.

So yes, something *does* run on GitHub — that's `.github/workflows/market.yml`,
and it's free on a public repo.

## How prices are worked out

Items are keyed twice: a coarse `base` key that always has samples, and a
`variant` key carrying stars, recombobulator, hot potatoes, ability scrolls,
**enchantments, gemstones**, pet level band, held item, skin and attributes. A
stock copy gets its own `|stock` bucket rather than sharing the base key.

**Pricing uses the variant bucket only.** The base bucket holds every copy of an
item — clean, enchanted, gemmed — so pricing a stock item against it invents a
discount that isn't there. With no comparable listings of its own, an item
reports nothing rather than a number it can't justify.

Valuation uses the **second** lowest BIN, not the lowest: you have to undercut
something to actually sell, and if two people dumped at the same price, that
price is the truth and the "flip" isn't one.

How much the wall has to agree with itself scales with the size of the claim.
Four listings at 10m/12m/13m/14m are a market; four at 10m/40m/300m/900m are four
people guessing. A 200% margin needs a coherent wall behind it, not just a deep
one.

### The strategies

| Strategy | Prices against | Good for |
|---|---|---|
| **Lowest-BIN snipe** | second-lowest BIN for that exact variant | fast, needs no history |
| **Sold median** | trimmed median of `auctions_ended` over a rolling window | money that actually moved |
| **Attribute-aware** | the attribute *pair*, then a shard-derived model | Kuudra gear, where the roll is the value |
| **Bazaar + craft** | order-book spread and the conversion chain | steady, scales with capital |

Coflnet's per-item aggregate is used as a **veto, never a valuation**: it's keyed
by item id and knows nothing about enchants, so a "flip" claiming a resale beyond
anything that item has ever fetched is a key collision, not a find.

## The financial numbers

Each item shows the things you'd want before committing coins — edge per unit
(net of the 1.25% tax, which is *not* the spread), volatility, range, max
drawdown, book skew, true order counts, time to clear, queue ahead. Auction items
get undercut room, sales rate and sell-through instead.

Every one of them returns nothing rather than a figure it can't justify — a
volatility off four samples isn't a little information, it's misinformation with
a decimal point on it. Hover any tile for what it means.

## Running it locally

To look at the site without deploying:

```bash
node scripts/serve.mjs        # → http://localhost:8080
```

Opening `docs/index.html` directly does **not** work — it's ES modules, which
browsers block on `file://`.

There's also a server build (`npm run terminal`, then `http://127.0.0.1:8787`)
that stores history in SQLite via `node:sqlite` and keeps collecting whether or
not a tab is open. It shares every file with the web build; the only difference
is an index that doesn't load the in-tab engine, and that's generated, not
forked.

An Electron desktop app exists too (`npm start`), which is where the
`Ctrl+Alt+1`…`5` global copy shortcuts live — those don't apply to the browser.
It needs `npm install` to have actually fetched Electron's separate ~100MB
binary, which is the usual thing that goes wrong.

## The trade-off with a browser tab

A tab only collects while it's open. The collector snapshot and Coflnet's archive
cover the past, so it's useful immediately — but a long unbroken local history
only builds while a tab is up, and each browser keeps its own. If you want a
machine quietly recording forever, that's the server build.

Storage is IndexedDB in your own browser. **save** writes your history to a file,
**load** reads one back. An API key, if you set one, stays in that browser.

## Craft recipes

Hypixel removed recipes from `/resources/skyblock/items` — 0 of 5,650 items ship
one. Conversions therefore come from `src/main/engine/craft-ratios.json`, a
bundled table of 75 whose ids are validated against the live bazaar list. Add
your own; the engine logs any id it can't find.

## Tests

```bash
npm test
```

Ten suites, including a jsdom test that loads `index.html`, stubs the API and
drives the real UI — panels mount, events repaint them, tabs open and close, edge
drops split, the layout persists. The two worst bugs this project has had were
both "the page renders nothing", and neither would have survived loading the page
once.

## A note on rules

This copies a command to your clipboard. You paste it, you look at the auction,
you decide. No clicking for you, no automated buying, no packet injection.
Automating the purchase is what gets accounts banned, and it isn't what this is
for.
