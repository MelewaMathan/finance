"""Trains the Isolation Forest used as fraud layer 2.

Layer 1 (rules) catches things we can name: a reused receipt, a malformed
reference, a second disbursement. Layer 2 exists for the patterns nobody wrote
a rule for -- an unusual amount at an unusual hour from a borrower with no
history of either.

The forest is trained on *normal* behaviour only, which is the point: an
unsupervised model cannot inherit a label bias, and it flags departures from
the population rather than departures from a labelled fraud set we do not have.

Usage (from ml-service/):
    .venv\\Scripts\\python.exe training/train_anomaly.py [--rows 6000] [--seed 42]
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import joblib  # noqa: E402
import sklearn  # noqa: E402
from sklearn.ensemble import IsolationForest  # noqa: E402

from app.anomaly import ANOMALY_FEATURES, build_vector  # noqa: E402

ANOMALY_VERSION = "anomaly-if-v1.0.0"
ARTIFACT_DIR = ROOT / "training" / "artifacts"
MODEL_PATH = ROOT / "model" / "anomaly.joblib"

CONTAMINATION = 0.04


def _normal_population(rows: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)

    log_amount = rng.normal(np.log1p(10_000), 0.55, rows)
    amount_ratio = np.clip(rng.lognormal(0.0, 0.35, rows), 0.05, 12)
    hour = np.round(rng.normal(11, 3, rows)).clip(5, 21)
    # A few perfectly normal people transact at night; the model must not
    # treat night-time on its own as fraud, only night-time *with* something else.
    night = rng.random(rows) < 0.08
    hour = np.where(night, rng.integers(0, 24, rows), hour)
    txns_24h = rng.poisson(0.6, rows)
    distinct_codes = np.minimum(txns_24h, rng.poisson(0.5, rows))
    days_since = np.clip(rng.exponential(6.0, rows), 0, 365)
    paid_ratio = rng.beta(1.2, 2.0, rows)

    return np.column_stack([log_amount, amount_ratio, hour, txns_24h, distinct_codes, days_since, paid_ratio])


def _synthetic_anomalies(rows: int, seed: int) -> np.ndarray:
    """Behaviours a moneylender would want flagged, built for evaluation only."""
    rng = np.random.default_rng(seed + 1)
    blocks = []

    # 1. A payment wildly larger than the borrower's own norm.
    blocks.append(
        np.column_stack(
            [
                rng.normal(np.log1p(60_000), 0.3, rows // 4),
                np.clip(rng.normal(9.0, 1.5, rows // 4), 4, 40),
                rng.integers(6, 20, rows // 4),
                rng.poisson(0.8, rows // 4),
                rng.poisson(0.6, rows // 4),
                rng.exponential(6.0, rows // 4),
                rng.beta(1.2, 2.0, rows // 4),
            ]
        )
    )
    # 2. A burst of activity: many transactions, many receipts, within a day.
    blocks.append(
        np.column_stack(
            [
                rng.normal(np.log1p(9_000), 0.4, rows // 4),
                np.clip(rng.lognormal(0, 0.4, rows // 4), 0.1, 12),
                rng.integers(6, 20, rows // 4),
                rng.integers(9, 25, rows // 4),
                rng.integers(7, 20, rows // 4),
                rng.exponential(1.0, rows // 4),
                rng.beta(1.2, 2.0, rows // 4),
            ]
        )
    )
    # 3. Odd hour plus an odd amount, with no prior activity at all.
    blocks.append(
        np.column_stack(
            [
                rng.normal(np.log1p(45_000), 0.3, rows // 4),
                np.clip(rng.normal(6.0, 1.2, rows // 4), 3, 30),
                rng.integers(0, 5, rows // 4),
                rng.poisson(0.7, rows // 4),
                rng.poisson(0.6, rows // 4),
                np.full(rows // 4, 365.0),
                rng.beta(0.5, 4.0, rows // 4),
            ]
        )
    )
    # 4. Tiny "testing" payments, repeatedly, one day apart.
    blocks.append(
        np.column_stack(
            [
                rng.normal(np.log1p(50), 0.2, rows // 4),
                np.clip(rng.normal(0.02, 0.01, rows // 4), 0.005, 0.2),
                rng.integers(0, 24, rows // 4),
                rng.integers(5, 15, rows // 4),
                rng.integers(4, 12, rows // 4),
                rng.integers(0, 2, rows // 4).astype(float),
                rng.beta(0.6, 0.6, rows // 4),
            ]
        )
    )
    return np.vstack(blocks)


def train(rows: int = 6_000, seed: int = 42) -> dict:
    normal = _normal_population(rows, seed)
    model = IsolationForest(
        n_estimators=220,
        max_samples="auto",
        contamination=CONTAMINATION,
        random_state=seed,
        n_jobs=1,
    )
    model.fit(normal)

    holdout = _normal_population(rows // 2, seed + 7)
    anomalies = _synthetic_anomalies(rows, seed)

    holdout_flags = model.predict(holdout)
    anomaly_flags = model.predict(anomalies)

    threshold = float(np.quantile(model.score_samples(normal), CONTAMINATION))
    medians = np.median(normal, axis=0)
    # Robust spread: MAD is not fooled by the outliers we are trying to find.
    mad = np.median(np.abs(normal - medians), axis=0)
    mad[mad == 0] = 1.0

    metrics = {
        "model_version": ANOMALY_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "rows": int(rows),
        "contamination": CONTAMINATION,
        "false_positive_rate": float((holdout_flags == -1).mean()),
        "synthetic_detection_rate": float((anomaly_flags == -1).mean()),
        "threshold": threshold,
        "features": ANOMALY_FEATURES,
        "python": platform.python_version(),
        "sklearn": sklearn.__version__,
    }

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "model": model,
            "features": ANOMALY_FEATURES,
            "version": ANOMALY_VERSION,
            "metrics": metrics,
            "medians": medians.tolist(),
            "mad": mad.tolist(),
            "threshold": threshold,
        },
        MODEL_PATH,
        compress=3,
    )

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    (ARTIFACT_DIR / "anomaly_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    # Sanity check: the vector builder must accept a hand-written payload.
    build_vector(
        {
            "log_amount": 9.2,
            "amount_ratio": 1.0,
            "hour_of_day": 11,
            "txns_24h": 0,
            "distinct_codes_24h": 0,
            "days_since_previous": 5,
            "loan_paid_ratio": 0.25,
        }
    )

    print(f"rows                    {metrics['rows']}")
    print(f"false positive rate     {metrics['false_positive_rate']:.3f}")
    print(f"synthetic detection     {metrics['synthetic_detection_rate']:.3f}")
    print(f"threshold (score)       {metrics['threshold']:.4f}")
    print(f"artifact                {MODEL_PATH}")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the Isolation Forest anomaly model")
    parser.add_argument("--rows", type=int, default=6_000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    train(rows=args.rows, seed=args.seed)


if __name__ == "__main__":
    main()
