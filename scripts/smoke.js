'use strict';
const api = require('../src/main/engine/api');
const { decodeItemBytes, readItem, pricingKeys } = require('../src/main/engine/nbt');

(async () => {
  console.log('--- auctions page 0 ---');
  const t0 = Date.now();
  const { body, meta } = await api.getAuctionPage(0);
  console.log('fetch ms', Date.now() - t0);
  console.log('success', body.success, 'page', body.page, 'totalPages', body.totalPages, 'totalAuctions', body.totalAuctions);
  console.log('lastUpdated', new Date(body.lastUpdated).toISOString());
  console.log('headers', JSON.stringify(meta));
  console.log('secondsUntilNextSnapshot', api.secondsUntilNextSnapshot(meta));
  const a = body.auctions[0];
  console.log('auction fields:', Object.keys(a).join(','));

  console.log('\n--- decode 4 items ---');
  const bins = body.auctions.filter(x => x.bin).slice(0, 400);
  const picks = [bins[0], bins[50], bins[150], bins.find(x => /Pet|✪|Attribute/i.test(x.item_name)) || bins[200]];
  for (const auc of picks) {
    if (!auc) continue;
    const item = readItem(await decodeItemBytes(auc.item_bytes));
    const keys = pricingKeys(item);
    console.log(JSON.stringify({ name: auc.item_name, price: auc.starting_bid, tier: auc.tier, id: item.id, keys }));
  }

  console.log('\n--- auctions_ended ---');
  const ended = await api.getEndedAuctions();
  console.log('count', ended.body.auctions.length, 'fields', Object.keys(ended.body.auctions[0]).join(','));
  console.log('headers', JSON.stringify(ended.meta));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
