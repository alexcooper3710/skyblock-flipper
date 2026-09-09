'use strict';
// Bazaar side of the house: order-book spread flips and craft conversions.
// Completely independent of the auction poller - different data, different tempo.

const RATIOS = require('./craft-ratios.json');

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
// Hypixel returns up to 30 ask levels and 15 bid levels. Keep all of them -
// truncating the book is exactly the "only four orders" problem.
const LADDER_LEVELS = 30;
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
    // How many orders actually exist, which is NOT what the ladder says.
    // Hypixel truncates the summaries - 30 ask levels, 15 bid - so summing
    // their `orders` undercounts badly. Checked against live COAL: the ask
    // ladder's levels add up to 333 orders while quick_status says 648, and
    // the bid side 138 against 180. quick_status is the real count; the
    // ladder is a window onto the top of the book.
    // quick_status.buyX pairs with buy_summary, which is the ASK side (the
    // same inversion as the prices), so in the words the game uses:
    //   sell offers = asks = quick_status.buyOrders
    //   buy orders  = bids = quick_status.sellOrders
    sellOffers: product.quick_status ? (product.quick_status.buyOrders || 0) : 0,
    buyOrders: product.quick_status ? (product.quick_status.sellOrders || 0) : 0,
    // Units resting on each side, again from quick_status rather than the
    // truncated ladder.
    askUnits: product.quick_status ? (product.quick_status.buyVolume || 0) : 0,
    bidUnits: product.quick_status ? (product.quick_status.sellVolume || 0) : 0,
    // True when the ladder is a truncated view of a deeper book.
    askTruncated: (product.buy_summary || []).length >= LADDER_LEVELS,
    bidTruncated: (product.sell_summary || []).length >= 15,
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

// Every conversion, priced, whether or not it makes money.
//
// craftFlips answers "what should I do right now" and so drops everything that
// does not clear a threshold. That is the wrong shape for a panel you sit and
// look at: a conversion that is 2% underwater today is worth watching, and one
// that is wildly negative tells you the input is the thing in demand, not the
// output. So this returns the whole table with the economics attached and lets
// the reader decide.
//
// Both legs are priced the way you would actually trade them: buy the input by
// placing an order a tick above the best bid, sell the output a tick under the
// best ask, with tax on the sale. Pricing the input at the instant-buy price
// instead would make almost every craft look dead, which is a different lie.
function craftBoard(products, cfg) {
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
    const marginPct = costPerCraft > 0 ? (perCraft / costPerCraft) * 100 : 0;

    // What you could actually do in an hour: limited by how fast the input is
    // supplied, how fast the output is absorbed, and what you can afford.
    const inHourly = inT.buyVolWeek / (7 * 24);
    const outHourly = outT.sellVolWeek / (7 * 24);
    const byInput = recipe.qty > 0 ? inHourly / recipe.qty : 0;
    const byBudget = costPerCraft > 0 ? cfg.maxBudget / costPerCraft : 0;
    const crafts = Math.max(0, Math.floor(Math.min(byInput, outHourly, byBudget)));

    out.push({
      id: outputId, input: recipe.input, qty: recipe.qty,
      inputPrice: Number(inT.buyOrder.toFixed(1)),
      outputPrice: Number(outT.sellOrder.toFixed(1)),
      costPerCraft: Math.round(costPerCraft),
      revenuePerCraft: Math.round(revenuePerCraft),
      perCraft: Math.round(perCraft),
      tax: Math.round(outT.sellOrder * taxRate),
      marginPct: Number(marginPct.toFixed(2)),
      crafts,
      hourly: Math.round(perCraft * crafts),
      inputVolWeek: inT.buyVolWeek,
      outputVolWeek: outT.sellVolWeek,
      // The bottleneck is worth naming: "you cannot get the input" and "nobody
      // is buying the output" are different problems with different answers.
      limitedBy: byInput <= outHourly && byInput <= byBudget ? 'input supply'
        : outHourly <= byBudget ? 'output demand' : 'budget',
      profitable: perCraft > 0,
    });
  }
  return out.sort((a, b) => b.hourly - a.hourly || b.marginPct - a.marginPct);
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

module.exports = { orderFlips, craftFlips, craftBoard, topOfBook, ladder, validateRatios, RATIOS, LADDER_LEVELS };
