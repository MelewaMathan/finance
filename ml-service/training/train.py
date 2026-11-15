"""Trains the advisory credit-risk model on a synthetic, reproducible dataset.

Why synthetic data: this is a university prototype. Real repayment histories
from a staff-managed lending book are not available (and should not be), so the
trainer generates a population whose *default process* is known. That makes
the evaluation honest -- we can show the model recovers the signal we planted
instead of reporting a number from data nobody can inspect.

The label is generated from a latent logistic function of the same features
the API sends. The weights below are the "ground truth" of the simulation, not
a claim about real borrowers.

Usage (from ml-service/):
    .venv\\Scripts\\python.exe training/train.py [--rows 8000] [--seed 42]
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
from sklearn.ensemble import GradientBoostingClassifier  # noqa: E402
from sklearn.metrics import (  # noqa: E402
    accuracy_score,
    brier_score_loss,
    confusion_matrix,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split  # noqa: E402

from app.features import FEATURE_NAMES, to_vector  # noqa: E402

MODEL_VERSION = "credit-gb-v1.0.0"
ARTIFACT_DIR = ROOT / "training" / "artifacts"
MODEL_PATH = ROOT / "model" / "model.joblib"

# Score bands. Higher score = lower risk.
LOW_RISK_MIN = 70
MEDIUM_RISK_MIN = 45


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-z))


def generate_dataset(rows: int, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (X, y, latent_probability) for `rows` synthetic borrowers."""
    rng = np.random.default_rng(seed)

    income_kes = np.exp(rng.normal(np.log(38_000), 0.55, rows)).clip(6_000, 400_000)
    principal_kes = income_kes * np.exp(rng.normal(np.log(0.55), 0.5, rows))
    principal_kes = principal_kes.clip(2_000, 400_000)

    frequency = rng.choice(["daily", "weekly", "monthly"], size=rows, p=[0.3, 0.5, 0.2])
    term_count = np.where(
        frequency == "daily",
        rng.integers(10, 61, rows),
        np.where(frequency == "weekly", rng.integers(4, 25, rows), rng.integers(3, 13, rows)),
    )
    rate_bps = rng.integers(500, 2_001, rows)

    total_kes = principal_kes * (1 + rate_bps / 10_000 * term_count)
    installment_kes = total_kes / term_count

    prior_loans = rng.poisson(1.4, rows)
    prior_settled = np.minimum(prior_loans, rng.binomial(prior_loans, 0.72))
    remaining = prior_loans - prior_settled
    prior_defaults = np.minimum(remaining, rng.binomial(remaining, 0.28))
    active_loans = np.minimum(remaining - prior_defaults, rng.integers(0, 3, rows))

    arrears = rng.beta(0.7, 4.2, rows)
    # A brand-new borrower has no arrears history to speak of.
    arrears = np.where(prior_loans == 0, 0.0, arrears)

    has_collateral = rng.random(rows) < np.clip(0.18 + 0.28 * np.log1p(principal_kes / 20_000), 0.1, 0.8)
    has_guarantor = rng.random(rows) < 0.55
    guarantor_credit = np.where(
        has_guarantor,
        np.clip(rng.normal(62, 16, rows), 0, 100),
        -1.0,
    )

    account_age_days = np.clip(rng.gamma(2.0, 120.0, rows), 0, 2_400)

    features = {
        "principal_to_income": principal_kes / income_kes,
        "installment_to_income": installment_kes / income_kes,
        "term_count": term_count.astype(float),
        "rate_bps": rate_bps.astype(float),
        "is_daily": (frequency == "daily").astype(float),
        "prior_loans": prior_loans.astype(float),
        "prior_settled": prior_settled.astype(float),
        "prior_defaults": prior_defaults.astype(float),
        "arrears_ratio": arrears,
        "active_loans": active_loans.astype(float),
        "has_collateral": has_collateral.astype(float),
        "has_guarantor": has_guarantor.astype(float),
        "guarantor_credit": guarantor_credit.astype(float),
        "account_age_days": account_age_days.astype(float),
    }

    # Latent default process. Read as: what makes a borrower default in this
    # simulation. Over-indebtedness and arrears history dominate, collateral
    # and a known guarantor pull the other way.
    #
    # SIGNAL_GAIN widens the spread of the true probabilities. Without it the
    # planted signal is weak enough that Bernoulli label noise alone caps the
    # achievable AUC near 0.70, which would make the model look worse than it
    # is -- and hide a genuine regression.
    SIGNAL_GAIN = 1.9
    signal = (
        1.35 * np.clip(features["principal_to_income"], 0, 6) / 2.0
        + 2.30 * np.clip(features["installment_to_income"], 0, 2.0)
        + 0.55 * np.clip(features["term_count"] - 12, 0, 60) / 24.0
        + 0.35 * features["is_daily"]
        + 0.28 * features["rate_bps"] / 10_000 * 10
        - 0.35 * np.clip(features["prior_settled"], 0, 5) / 5.0
        + 0.85 * np.clip(features["prior_defaults"], 0, 3)
        + 2.10 * features["arrears_ratio"]
        + 0.45 * np.clip(features["active_loans"], 0, 3)
        - 0.45 * features["has_collateral"]
        - 0.40 * features["has_guarantor"]
        - 0.30 * np.clip(features["guarantor_credit"], 0, 100) / 100.0
        - 0.35 * np.clip(features["account_age_days"], 0, 730) / 730.0
    )
    # The intercept is set so the simulated population defaults at roughly
    # 20%, which is a representative default rate for small loan books.
    z = -3.45 + SIGNAL_GAIN * signal
    probability = _sigmoid(z)
    labels = (rng.random(rows) < probability).astype(int)

    matrix = np.vstack([to_vector({name: features[name][i] for name in FEATURE_NAMES})[0] for i in range(rows)])
    return matrix, labels, probability


def score_from_probability(probability: float) -> int:
    """Maps a default probability to a 0-100 score, higher is better."""
    return int(round(max(0.0, min(1.0, 1.0 - probability)) * 100))


def risk_level(score: int) -> str:
    if score >= LOW_RISK_MIN:
        return "low"
    if score >= MEDIUM_RISK_MIN:
        return "medium"
    return "high"


def train(rows: int = 8_000, seed: int = 42) -> dict:
    matrix, labels, _latent = generate_dataset(rows, seed)
    x_train, x_test, y_train, y_test = train_test_split(
        matrix, labels, test_size=0.25, random_state=seed, stratify=labels
    )

    model = GradientBoostingClassifier(
        n_estimators=220,
        learning_rate=0.06,
        max_depth=3,
        subsample=0.9,
        random_state=seed,
    )
    model.fit(x_train, y_train)

    probabilities = model.predict_proba(x_test)[:, 1]
    predictions = (probabilities >= 0.5).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_test, predictions, labels=[0, 1]).ravel()

    scores = [score_from_probability(p) for p in probabilities]
    metrics = {
        "model_version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "rows": int(rows),
        "default_rate": float(labels.mean()),
        "roc_auc": float(roc_auc_score(y_test, probabilities)),
        "accuracy": float(accuracy_score(y_test, predictions)),
        "brier": float(brier_score_loss(y_test, probabilities)),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "score_mean": float(np.mean(scores)),
        "score_buckets": {
            "high_risk": sum(1 for s in scores if s < MEDIUM_RISK_MIN),
            "medium_risk": sum(1 for s in scores if MEDIUM_RISK_MIN <= s < LOW_RISK_MIN),
            "low_risk": sum(1 for s in scores if s >= LOW_RISK_MIN),
        },
        "thresholds": {"low_min": LOW_RISK_MIN, "medium_min": MEDIUM_RISK_MIN},
        "feature_importance": {
            name: float(value) for name, value in zip(FEATURE_NAMES, model.feature_importances_)
        },
        "python": platform.python_version(),
        "sklearn": sklearn.__version__,
    }

    bundle = {
        "model": model,
        "features": FEATURE_NAMES,
        "version": MODEL_VERSION,
        "metrics": metrics,
        "medians": matrix.mean(axis=0).tolist(),
        "thresholds": {"low_min": LOW_RISK_MIN, "medium_min": MEDIUM_RISK_MIN},
    }

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, MODEL_PATH, compress=3)

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    (ARTIFACT_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    header = "feature".ljust(24) + "importance"
    print(header)
    print("-" * len(header))
    for name, value in sorted(metrics["feature_importance"].items(), key=lambda item: -item[1]):
        print(name.ljust(24) + f"{value:.4f}")

    print()
    print(f"rows              {metrics['rows']}")
    print(f"default rate      {metrics['default_rate']:.3f}")
    print(f"roc auc           {metrics['roc_auc']:.4f}")
    print(f"accuracy @0.50    {metrics['accuracy']:.4f}")
    print(f"brier score       {metrics['brier']:.4f}")
    print(f"score buckets     {metrics['score_buckets']}")
    print(f"artifact          {MODEL_PATH}")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the advisory credit-risk model")
    parser.add_argument("--rows", type=int, default=8_000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    train(rows=args.rows, seed=args.seed)


if __name__ == "__main__":
    main()
