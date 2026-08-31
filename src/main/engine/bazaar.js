'use strict';
// Bazaar side of the house: order-book spread flips and craft conversions.
// Completely independent of the auction poller - different data, different tempo.

const RATIOS = require('./craft-ratios.json');

// What you pay if you place a buy ORDER (top of the buy book + 0.1) and what you
// receive on a sell ORDER (top of the sell book - 0.1). Instant buy/sell prices
// are the other side of the same book and lose you the whole spread.
function topOfBook(product) {
  const buy = product.buy_summary && product.buy_summary[0];
  const sell = product.sell_summary && product.sell_summary[0];
  return {
    buyOrder: buy ? buy.pricePerUnit + 0.1 : 0,   // what you'd offer to buy at
    sellOrder: sell ? sell.pricePerUnit - 0.1 : 0, // what you'd list to sell at
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

module.exports = { orderFlips, craftFlips, topOfBook, validateRatios, RATIOS };
