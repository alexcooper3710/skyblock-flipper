// GENERATED from src/main/engine/bazaar.js by scripts/build-web.js - do not edit.
// Bazaar side of the house: order-book spread flips and craft conversions.
// Completely independent of the auction poller - different data, different tempo.

const RATIOS = {
  "_comment": "Hypixel stopped shipping recipes in /resources/skyblock/items, so conversions live here. output -> {input, qty}. All ids validated against the live bazaar product list. Add your own; the app reloads this on restart.",
  "ENCHANTED_COAL": {
    "input": "COAL",
    "qty": 160
  },
  "ENCHANTED_CHARCOAL": {
    "input": "ENCHANTED_COAL",
    "qty": 160
  },
  "ENCHANTED_IRON": {
    "input": "IRON_INGOT",
    "qty": 160
  },
  "ENCHANTED_IRON_BLOCK": {
    "input": "ENCHANTED_IRON",
    "qty": 160
  },
  "ENCHANTED_GOLD": {
    "input": "GOLD_INGOT",
    "qty": 160
  },
  "ENCHANTED_GOLD_BLOCK": {
    "input": "ENCHANTED_GOLD",
    "qty": 160
  },
  "ENCHANTED_DIAMOND": {
    "input": "DIAMOND",
    "qty": 160
  },
  "ENCHANTED_DIAMOND_BLOCK": {
    "input": "ENCHANTED_DIAMOND",
    "qty": 160
  },
  "ENCHANTED_LAPIS_LAZULI": {
    "input": "INK_SACK:4",
    "qty": 160
  },
  "ENCHANTED_EMERALD": {
    "input": "EMERALD",
    "qty": 160
  },
  "ENCHANTED_EMERALD_BLOCK": {
    "input": "ENCHANTED_EMERALD",
    "qty": 160
  },
  "ENCHANTED_REDSTONE": {
    "input": "REDSTONE",
    "qty": 160
  },
  "ENCHANTED_REDSTONE_BLOCK": {
    "input": "ENCHANTED_REDSTONE",
    "qty": 160
  },
  "ENCHANTED_QUARTZ": {
    "input": "QUARTZ",
    "qty": 160
  },
  "ENCHANTED_QUARTZ_BLOCK": {
    "input": "ENCHANTED_QUARTZ",
    "qty": 160
  },
  "ENCHANTED_OBSIDIAN": {
    "input": "OBSIDIAN",
    "qty": 160
  },
  "ENCHANTED_GLOWSTONE": {
    "input": "GLOWSTONE_DUST",
    "qty": 160
  },
  "ENCHANTED_GLOWSTONE_DUST": {
    "input": "GLOWSTONE_DUST",
    "qty": 160
  },
  "ENCHANTED_COBBLESTONE": {
    "input": "COBBLESTONE",
    "qty": 160
  },
  "ENCHANTED_ENDSTONE": {
    "input": "ENDER_STONE",
    "qty": 160
  },
  "ENCHANTED_ENDER_PEARL": {
    "input": "ENDER_PEARL",
    "qty": 160
  },
  "ENCHANTED_EYE_OF_ENDER": {
    "input": "ENCHANTED_ENDER_PEARL",
    "qty": 160
  },
  "ENCHANTED_STRING": {
    "input": "STRING",
    "qty": 160
  },
  "ENCHANTED_BONE": {
    "input": "BONE",
    "qty": 160
  },
  "ENCHANTED_SLIME_BALL": {
    "input": "SLIME_BALL",
    "qty": 160
  },
  "ENCHANTED_SLIME_BLOCK": {
    "input": "ENCHANTED_SLIME_BALL",
    "qty": 160
  },
  "ENCHANTED_ROTTEN_FLESH": {
    "input": "ROTTEN_FLESH",
    "qty": 160
  },
  "ENCHANTED_GUNPOWDER": {
    "input": "SULPHUR",
    "qty": 160
  },
  "ENCHANTED_SPIDER_EYE": {
    "input": "SPIDER_EYE",
    "qty": 160
  },
  "ENCHANTED_MAGMA_CREAM": {
    "input": "MAGMA_CREAM",
    "qty": 160
  },
  "ENCHANTED_GHAST_TEAR": {
    "input": "GHAST_TEAR",
    "qty": 160
  },
  "ENCHANTED_SUGAR": {
    "input": "SUGAR_CANE",
    "qty": 160
  },
  "ENCHANTED_SUGAR_CANE": {
    "input": "ENCHANTED_SUGAR",
    "qty": 160
  },
  "ENCHANTED_CACTUS_GREEN": {
    "input": "CACTUS",
    "qty": 160
  },
  "ENCHANTED_CACTUS": {
    "input": "ENCHANTED_CACTUS_GREEN",
    "qty": 160
  },
  "ENCHANTED_POTATO": {
    "input": "POTATO_ITEM",
    "qty": 160
  },
  "ENCHANTED_BAKED_POTATO": {
    "input": "ENCHANTED_POTATO",
    "qty": 160
  },
  "ENCHANTED_CARROT": {
    "input": "CARROT_ITEM",
    "qty": 160
  },
  "ENCHANTED_GOLDEN_CARROT": {
    "input": "ENCHANTED_CARROT",
    "qty": 160
  },
  "ENCHANTED_MELON": {
    "input": "MELON",
    "qty": 160
  },
  "ENCHANTED_MELON_BLOCK": {
    "input": "ENCHANTED_MELON",
    "qty": 160
  },
  "ENCHANTED_PUMPKIN": {
    "input": "PUMPKIN",
    "qty": 160
  },
  "ENCHANTED_SEEDS": {
    "input": "SEEDS",
    "qty": 160
  },
  "ENCHANTED_BREAD": {
    "input": "WHEAT",
    "qty": 160
  },
  "ENCHANTED_HAY_BLOCK": {
    "input": "ENCHANTED_BREAD",
    "qty": 160
  },
  "ENCHANTED_COCOA": {
    "input": "INK_SACK:3",
    "qty": 160
  },
  "ENCHANTED_MUTTON": {
    "input": "MUTTON",
    "qty": 160
  },
  "ENCHANTED_COOKED_MUTTON": {
    "input": "ENCHANTED_MUTTON",
    "qty": 160
  },
  "ENCHANTED_PORK": {
    "input": "PORK",
    "qty": 160
  },
  "ENCHANTED_GRILLED_PORK": {
    "input": "ENCHANTED_PORK",
    "qty": 160
  },
  "ENCHANTED_RAW_CHICKEN": {
    "input": "RAW_CHICKEN",
    "qty": 160
  },
  "ENCHANTED_RABBIT_FOOT": {
    "input": "RABBIT_FOOT",
    "qty": 160
  },
  "ENCHANTED_RABBIT_HIDE": {
    "input": "RABBIT_HIDE",
    "qty": 160
  },
  "ENCHANTED_LEATHER": {
    "input": "LEATHER",
    "qty": 160
  },
  "ENCHANTED_FEATHER": {
    "input": "FEATHER",
    "qty": 160
  },
  "ENCHANTED_RAW_FISH": {
    "input": "RAW_FISH",
    "qty": 160
  },
  "ENCHANTED_PRISMARINE_SHARD": {
    "input": "PRISMARINE_SHARD",
    "qty": 160
  },
  "ENCHANTED_PRISMARINE_CRYSTALS": {
    "input": "PRISMARINE_CRYSTALS",
    "qty": 160
  },
  "ENCHANTED_CLAY_BALL": {
    "input": "CLAY_BALL",
    "qty": 160
  },
  "ENCHANTED_SAND": {
    "input": "SAND",
    "qty": 160
  },
  "ENCHANTED_FLINT": {
    "input": "FLINT",
    "qty": 160
  },
  "ENCHANTED_ACACIA_LOG": {
    "input": "LOG_2",
    "qty": 160
  },
  "ENCHANTED_BIRCH_LOG": {
    "input": "LOG:2",
    "qty": 160
  },
  "ENCHANTED_DARK_OAK_LOG": {
    "input": "LOG_2:1",
    "qty": 160
  },
  "ENCHANTED_JUNGLE_LOG": {
    "input": "LOG:3",
    "qty": 160
  },
  "ENCHANTED_OAK_LOG": {
    "input": "LOG",
    "qty": 160
  },
  "ENCHANTED_SPRUCE_LOG": {
    "input": "LOG:1",
    "qty": 160
  },
  "ENCHANTED_NETHER_STALK": {
    "input": "NETHER_STALK",
    "qty": 160
  },
  "MUTANT_NETHER_STALK": {
    "input": "ENCHANTED_NETHER_STALK",
    "qty": 160
  },
  "ENCHANTED_MITHRIL": {
    "input": "MITHRIL_ORE",
    "qty": 160
  },
  "ENCHANTED_TITANIUM": {
    "input": "TITANIUM_ORE",
    "qty": 160
  },
  "ENCHANTED_HARD_STONE": {
    "input": "HARD_STONE",
    "qty": 160
  },
  "ENCHANTED_SULPHUR_CUBE": {
    "input": "ENCHANTED_GUNPOWDER",
    "qty": 160
  },
  "ENCHANTED_LAPIS_LAZULI_BLOCK": {
    "input": "ENCHANTED_LAPIS_LAZULI",
    "qty": 160
  },
  "ENCHANTED_BLAZE_ROD": {
    "input": "BLAZE_ROD",
    "qty": 160
  }
};

// Hypixel's summaries are named from the API's point of view, not yours, and
// they are the opposite way round to what the names suggest. Verified against
// live data: for ENCHANTED_LAPIS_LAZULI, buy_summary[0] = 1103.5 matched
// quick_status.buyPrice (instant BUY, the high side) and sell_summary[0] = 794.3
// matched quick_status.sellPrice (instant SELL, the low side). So:
//   buy_summary  = the ASK side (sell offers you can buy from)
//   sell_summary = the BID side (buy orders you can sell into)
// To place a buy order you outbid the best bid; to sell you undercut the best
// ask. Reading these backwards makes every spread negative and silently kills
// every order flip - which is exactly what it did.
// Keep the ladder, not just its first rung. "8 orders exist" tells you nothing;
// "84,654 units sitting at 1266.2" tells you where the wall actually is.
const LADDER_LEVELS = 10;
function ladder(levels) {
  return (levels || []).slice(0, LADDER_LEVELS).map(l => ({
    price: l.pricePerUnit, amount: l.amount, orders: l.orders,
  }));
}

function topOfBook(product) {
  const ask = product.buy_summary && product.buy_summary[0];
  const bid = product.sell_summary && product.sell_summary[0];
  return {
    asks: ladder(product.buy_summary),   // ascending: cheapest offer first
    bids: ladder(product.sell_summary),  // descending: best bid first
    buyOrder: bid ? bid.pricePerUnit + 0.1 : 0,   // outbid the best buy order
    sellOrder: ask ? ask.pricePerUnit - 0.1 : 0,  // undercut the cheapest offer
    instantBuy: product.quick_status ? product.quick_status.buyPrice : 0,
    instantSell: product.quick_status ? product.quick_status.sellPrice : 0,
    buyVolWeek: product.quick_status ? product.quick_status.buyMovingWeek : 0,
    sellVolWeek: product.quick_status ? product.quick_status.sellMovingWeek : 0,
  };
}

function orderFlips(products, cfg) {
  const taxRate = (cfg.bazaar.taxPct ?? 1.25) / 100;
  const out = [];
  for (const [id, product] of Object.entries(products)) {
    const t = topOfBook(product);
    if (!t.buyOrder || !t.sellOrder) continue;

    // Both sides must actually move, or your order sits unfilled forever.
    const volume = Math.min(t.buyVolWeek, t.sellVolWeek);
    if (volume < cfg.bazaar.minWeeklyVolume) continue;

    const net = t.sellOrder * (1 - taxRate);
    const perUnit = net - t.buyOrder;
    if (perUnit <= 0) continue;
    const spreadPct = (perUnit / t.buyOrder) * 100;
    if (spreadPct < cfg.bazaar.minSpreadPct) continue;

    // Size the flip by what the thinner side clears in an hour, capped by budget.
    const hourly = volume / (7 * 24);
    const affordable = Math.floor(cfg.maxBudget / t.buyOrder);
    const units = Math.max(1, Math.floor(Math.min(hourly, affordable)));
    const profit = Math.round(perUnit * units);
    if (profit < cfg.bazaar.minProfitPerFlip) continue;

    out.push({
      kind: 'bazaar-order', id,
      buyAt: Number(t.buyOrder.toFixed(1)),
      sellAt: Number(t.sellOrder.toFixed(1)),
      perUnit: Number(perUnit.toFixed(2)),
      spreadPct: Number(spreadPct.toFixed(1)),
      units, profit, weeklyVolume: volume,
    });
  }
  return out.sort((a, b) => b.profit - a.profit);
}

function craftFlips(products, cfg) {
  const taxRate = (cfg.bazaar.taxPct ?? 1.25) / 100;
  const out = [];
  for (const [outputId, recipe] of Object.entries(RATIOS)) {
    if (outputId.startsWith('_')) continue;
    const outP = products[outputId];
    const inP = products[recipe.input];
    if (!outP || !inP) continue;

    const outT = topOfBook(outP);
    const inT = topOfBook(inP);
    if (!outT.sellOrder || !inT.buyOrder) continue;

    const costPerCraft = inT.buyOrder * recipe.qty;
    const revenuePerCraft = outT.sellOrder * (1 - taxRate);
    const perCraft = revenuePerCraft - costPerCraft;
    if (perCraft <= 0) continue;
    const marginPct = (perCraft / costPerCraft) * 100;
    if (marginPct < cfg.bazaar.minSpreadPct) continue;

    // You can only craft as many as the input side supplies and the output side absorbs.
    const inHourly = inT.buyVolWeek / (7 * 24);
    const outHourly = outT.sellVolWeek / (7 * 24);
    const byInput = Math.floor(inHourly / recipe.qty);
    const byBudget = Math.floor(cfg.maxBudget / costPerCraft);
    const crafts = Math.max(1, Math.floor(Math.min(byInput, outHourly, byBudget)));
    const profit = Math.round(perCraft * crafts);
    if (profit < cfg.bazaar.minProfitPerFlip) continue;

    out.push({
      kind: 'bazaar-craft', id: outputId, input: recipe.input, qty: recipe.qty,
      costPerCraft: Math.round(costPerCraft),
      revenuePerCraft: Math.round(revenuePerCraft),
      perCraft: Math.round(perCraft),
      marginPct: Number(marginPct.toFixed(1)),
      crafts, profit,
    });
  }
  return out.sort((a, b) => b.profit - a.profit);
}

// Sanity check the bundled table against whatever the bazaar actually lists.
function validateRatios(products) {
  const missing = [];
  for (const [outputId, recipe] of Object.entries(RATIOS)) {
    if (outputId.startsWith('_')) continue;
    if (!products[outputId]) missing.push(`output ${outputId}`);
    else if (!products[recipe.input]) missing.push(`input ${recipe.input} (for ${outputId})`);
  }
  return missing;
}

export { orderFlips, craftFlips, topOfBook, ladder, validateRatios, RATIOS, LADDER_LEVELS };