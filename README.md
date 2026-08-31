# SkyBlock Flipper

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

## Running it

```bash
npm install
npm start          # the Electron app
npm run engine     # same engine, headless, prints to the terminal
npm test           # offline tests against real Hypixel item_bytes
```

Put your key in Settings, or drop a `config.json` next to `config.example.json`.
The auction and bazaar endpoints are public; a key mainly buys you headroom.

## Copying without alt-tabbing

`Ctrl+Alt+1` … `Ctrl+Alt+5` copy the top five live flips from anywhere, so you
can stay in Minecraft. Clicking a row copies it too.

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
