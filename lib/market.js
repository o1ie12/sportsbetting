'use strict';
// Binary prediction market priced by an LMSR automated market maker.
// State is (qy, qn): shares outstanding on each side. A winning share pays 1.
const B = 300; // liquidity: bigger = prices move less per dollar. Max house subsidy is B * ln 2 (about 208).

const cost = (qy, qn, b = B) => {
  const m = Math.max(qy, qn);
  return m + b * Math.log(Math.exp((qy - m) / b) + Math.exp((qn - m) / b));
};
const priceYes = (qy, qn, b = B) => 1 / (1 + Math.exp((qn - qy) / b));

// shares received for spending `spend` on `side`
function buyShares(qy, qn, b, side, spend) {
  const mine = side === 'yes' ? qy : qn, other = side === 'yes' ? qn : qy;
  const T = cost(qy, qn, b) + spend;
  return (T - mine) + b * Math.log(1 - Math.exp((other - T) / b));
}
// cash received for selling `shares` of `side`
function sellProceeds(qy, qn, b, side, shares) {
  const nyes = side === 'yes' ? qy - shares : qy, nno = side === 'no' ? qn - shares : qn;
  return cost(qy, qn, b) - cost(nyes, nno, b);
}
module.exports = { B, cost, priceYes, buyShares, sellProceeds };
