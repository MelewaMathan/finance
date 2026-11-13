"""Feature contract for the anomaly layer (Isolation Forest).

These seven numbers describe *how* a money movement was made, not who made it.
They stay inside the platform's trust boundary in the same way the credit
features do: no names, no identifiers, no free text.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

import numpy as np


@dataclass(frozen=True)
class AnomalyFeatureSpec:
    name: str
    minimum: float
    maximum: float
    description: str


ANOMALY_SPECS: List[AnomalyFeatureSpec] = [
    AnomalyFeatureSpec("log_amount", 0.0, 20.0, "log1p(amount in KES)"),
    AnomalyFeatureSpec("amount_ratio", 0.0, 50.0, "Amount / the borrower's own median amount"),
    AnomalyFeatureSpec("hour_of_day", 0.0, 23.0, "Local hour the money moved"),
    AnomalyFeatureSpec("txns_24h", 0.0, 100.0, "Borrower transactions in the previous 24 hours"),
    AnomalyFeatureSpec("distinct_codes_24h", 0.0, 100.0, "Distinct receipts used in that window"),
    AnomalyFeatureSpec("days_since_previous", 0.0, 365.0, "Days since the borrower's previous transaction"),
    AnomalyFeatureSpec("loan_paid_ratio", 0.0, 1.0, "Share of this loan already repaid"),
]

ANOMALY_FEATURES: List[str] = [spec.name for spec in ANOMALY_SPECS]


class AnomalyFeatureError(ValueError):
    """Raised when an anomaly payload cannot be turned into a vector."""


def build_vector(payload: Dict[str, Any]) -> np.ndarray:
    if not isinstance(payload, dict):
        raise AnomalyFeatureError("features must be an object")

    missing = [spec.name for spec in ANOMALY_SPECS if spec.name not in payload]
    if missing:
        raise AnomalyFeatureError(f"missing features: {', '.join(missing)}")

    values: List[float] = []
    for spec in ANOMALY_SPECS:
        raw = payload[spec.name]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise AnomalyFeatureError(f"feature '{spec.name}' must be a number")
        if raw != raw or raw in (float("inf"), float("-inf")):
            raise AnomalyFeatureError(f"feature '{spec.name}' must be finite")
        values.append(float(min(max(raw, spec.minimum), spec.maximum)))
    return np.asarray([values], dtype=float)
