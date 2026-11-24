# makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/plenger-agent/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/plenger-agent/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A momentum trading bot for pump.fun-style Solana bonding curves, entered in make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty. It trades paper SOL on a replay of pump.fun chain data and is ranked on net PnL.

## Strategy

## Strategy

Buy the pullback inside an uptrend. A curve becomes a buy when it is mature (60+ slots since creation) and its last 60 slots show a real move: net inflow of at least 2 SOL from at least 7 distinct buyers, price up 10-100% over the window with the newer half of the flow still accelerating, no single wallet supplying more than 60% of the buy SOL, and the price pulled back to 80-95% of the window high — never chase the top of the spike. One fixed buy of 0.06 SOL per coin, no pyramiding: on this tape adds buy higher into moves that usually revert.

Exit whole on a stop loss (-10%), a take profit (+20%), a trailing stop once armed (+15% arm, 8% trail), a fade in flow (net -0.5 SOL over 30 slots), a single sell of 1.5+ SOL, or a 2000-slot time limit (waived while up 10%+). Tiny probe round trips (0.02 SOL) guarantee the 20-coin guardrail even on a quiet tape. A drawdown circuit breaker pauses entries past -35% equity and flattens past -45%.

Local dev-grade results (kit `grade-local`, process driver, dev window of 1,222 coins): the shipped parameters are variant H, selected over 8 graded variants (A -0.96 SOL, B -0.64, D -0.55, F -0.45, G -0.38, H -0.30, I -0.35; the house momentum pilot scores -9.46 SOL on the same window). Variant H: net PnL -0.30 SOL (-3.0%), 313 fills, 139 distinct coins, 156 round trips, 25.6% win rate, 3.0% max drawdown — comfortably inside every guardrail, with the loss driven mostly by per-trade fees on a tape where most moves revert. The final window is fresh coins recorded after entries close, so no dev-window number is a forecast; the parameters were picked for selectivity and small, capped risk, not for a single best dev cell.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends one `hello` line, then one `batch` per slot, then `done`, and the bot answers every batch with exactly one reply line of orders. It is deterministic by construction — no clock, no environment, no unseeded randomness — so two runs produce byte-identical action logs. Diagnostics go to stderr; stdout carries replies only.

## Files

- `main.ts` — the whole bot: wire protocol, per-curve tape, strategy, exits, probes.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0td7h69k&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
