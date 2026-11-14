---
name: ml-neural-trader
description: Rules for building, validating and wiring the machine-learning models (neural network and boosted trees) in the Trading Desk app. Use when changing anything under trading_desk_cloud/src/ml or how model output reaches trades.
---
# Financial ML rules for this app

The app runs on Cloudflare Workers (TypeScript, D1). There is no Python runtime, so PyTorch, XGBoost and a local
FastAPI service do not apply. The models are written out in `trading_desk_cloud/src/ml/`: a multi-layer perceptron
trained by backpropagation and gradient-boosted trees with a softmax objective. Keep it that way.

1. **No leakage.** Split by time across all symbols: older rows train, newer rows validate. Never shuffle across the
   cut. Drop training rows whose label window reaches past the cut (embargo). Features at bar i use bars 0..i only.
2. **Scaling.** Fit the scaler on the training rows only, store it inside the model JSON, and apply the same one live.
3. **Two models, same rows.** Always train the neural network and the boosted trees on identical data and report
   both, plus their average. Early stopping and probability calibration use a slice held out of the TRAINING period,
   never the validation period.
4. **Confidence gate.** BUY or SELL only when the probability is at or above the threshold (0.70 by default);
   otherwise HOLD.
5. **Earn the right to trade.** A model influences orders only if, on validation data, its confident calls beat
   chance by a margin that is also more than twice its sampling error, on at least 30 signals, with a positive
   average result after costs. Otherwise it is display-only and the screen says so. Never loosen this to make a
   model look useful; random-walk data must fail it (there is a test).
6. **One code path.** The same feature function builds training rows and the live row.
7. **Isolation.** Everything lives in `src/ml/`. Orders still go through the existing paper engine and its risk
   gate. The app never places real orders.
8. **Retrain and re-score.** Weekly retrain; before replacing a model, score it on the bars that arrived after it
   was trained and keep that record.
9. **Report honestly.** If there is no edge, say so in plain words in the UI and in any summary.
