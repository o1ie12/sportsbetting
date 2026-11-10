# Courtside 🏀

A fake-money NBA betting app for you and your friends. Real schedules, real scores and **real DraftKings lines**
(via ESPN's free public API, no API key needed), but everyone plays with play money.

## Run it

```bash
npm start          # needs Node 22.13+ (uses the built-in node:sqlite, zero dependencies)
```

It prints a local URL, a Wi-Fi URL and an **invite code**. The first account created becomes the commissioner.
Set your own code with `LEAGUE_CODE=SPLASH npm start`. Data lives in `data/courtside.db`.

### Getting your friends in
- **Same Wi-Fi:** share the `Network:` URL it prints.
- **Anywhere, quickly:** `npx cloudflared tunnel --url http://localhost:3000` (or ngrok) gives a public https link while your laptop is running.
- **Always on:** deploy to any host with a persistent disk (Fly.io, Railway, Render). Set `PORT`, `LEAGUE_CODE` and `DB_FILE` (point it at the disk).

## What's in it

| Feature | Notes |
|---|---|
| Spread / Total / Moneyline | Live lines from DraftKings via ESPN, refreshed continuously |
| Alt spreads and totals | Priced by a margin/total model with a built-in house edge |
| Winning-margin bands | "LAL by 6-10" style markets |
| Player props | Points / rebounds / assists lines from each team's season leaders, graded from the box score (DNP = refund) |
| Parlays + SGP | Up to 10 legs, **profit boost** from 3 legs (+10% up to +30%) |
| Live in-play betting | Lines re-priced from the score and clock until about 7 minutes remain in Q4 |
| Cash out | Offered on any open bet, valued from live win probability (7% house cut) |
| Duels | Challenge a friend (or anyone) head-to-head against the spread, winner takes the pot |
| Social | Activity feed with reactions, one-tap **Tail** to copy a friend's slip, trash-talk chat |
| Progression | Daily bonus with streak (up to 2,750), bailouts for the broke (with a 🤡 badge), badges, weekly + all-time leaderboard |
| Auto-settlement | Bets, parlays, props and duels settle themselves when games go final; postponed games refund |

Everything is priced and graded server-side. Odds shown on your slip are re-checked at placement, so stale prices are rejected.

## Layout

```
server.js        HTTP API, accounts, betting, settlement, duels, sync loop
lib/odds.js      odds math, pricing model, market builder, grading, win probability
lib/espn.js      ESPN scoreboard + box score client
lib/db.js        SQLite schema
public/          single-page frontend (no build step)
test/smoke.js    end-to-end logic test on a throwaway DB (npm test)
```

## Ideas for next
- Push/browser notifications when your bets hit, or a game you're in goes live
- Commissioner tools: gift or reset bucks, season resets, void a bet
- Pick'em contests, a "bet of the day" with a bonus payout, and season-long futures (MVP, champion)
- More props (3PM, PRA combos, double-doubles) once there's a lines source for them

## Prediction-market features

- **Prices in cents.** Every price can show as cents (default), American or Decimal odds. Change it from the username menu. A price in cents is the implied chance, including the house margin, so Yes and No add to a little over 100.
- **Markets tab.** Anyone can ask a yes or no question ("Will Oliver be late Friday?"). Prices come from an LMSR market maker (`lib/market.js`, liquidity 300), start at 50 cents and move as friends buy. A winning share pays $1. You can sell shares back before trading closes. The creator or the commissioner settles it as Yes, No or Void (void refunds net spend). Each person can have 3 open markets.
- **Price charts.** Each game has a win-probability chart built from stored price history (`price_hist` table); each market charts its own trades. Hover or drag across a chart to read a price.
- **Portfolio.** Cash, value in positions and profit, with open tickets and market positions together. Leaderboard net worth includes market positions at their current price.
- **Volume.** Games show the money bet on them.
- **Analytics.** Portfolio shows net worth over time (1D, 1W, All) and profit by day with win rate and ROI. Leaders shows everyone's net worth on one chart and profit bars. Net worth is snapshotted every 5 minutes into `net_hist`.
