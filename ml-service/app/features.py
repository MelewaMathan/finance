"""Feature contract shared by the trainer and the API.

The order of FEATURE_NAMES is part of the model artifact: a model trained with
one order must never be scored with another. Everything here is derived from
data the platform already holds -- no names, no national IDs, no phone numbers
ever reach the scoring service.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

import numpy as np


@dataclass(frozen=True)
class FeatureSpec:
    name: str
    minimum: float
    maximum: float
    description: str


# Ranges are deliberately generous; they are a sanity clamp against bugs and
# hostile input, not a business rule. Values outside the range are clipped and
# reported, never silently trusted.
FEATURE_SPECS: List[FeatureSpec] = [
    FeatureSpec("principal_to_income", 0.0, 20.0, "Requested principal / monthly income"),
    FeatureSpec("installment_to_income", 0.0, 5.0, "Per-installment amount / monthly income"),
    FeatureSpec("term_count", 1.0, 365.0, "Number of repayment periods"),
    FeatureSpec("rate_bps", 0.0, 10000.0, "Flat interest per period, basis points"),
    FeatureSpec("is_daily", 0.0, 1.0, "1 when repayments are daily"),
    FeatureSpec("prior_loans", 0.0, 200.0, "Loans taken before this application"),
    FeatureSpec("prior_settled", 0.0, 200.0, "Of those, loans fully repaid"),
    FeatureSpec("prior_defaults", 0.0, 200.0, "Of those, loans that defaulted"),
    FeatureSpec("arrears_ratio", 0.0, 1.0, "Share of past installments that fell into arrears"),
    FeatureSpec("active_loans", 0.0, 50.0, "Loans currently outstanding"),
    FeatureSpec("has_collateral", 0.0, 1.0, "1 when collateral was described"),
    FeatureSpec("has_guarantor", 0.0, 1.0, "1 when a guarantor was supplied"),
    FeatureSpec("guarantor_credit", -1.0, 100.0, "Guarantor credit score, -1 when unknown"),
    FeatureSpec("account_age_days", 0.0, 3650.0, "Days since the account was created"),
]

FEATURE_NAMES: List[str] = [spec.name for spec in FEATURE_SPECS]
SPEC_BY_NAME: Dict[str, FeatureSpec] = {spec.name: spec for spec in FEATURE_SPECS}


class FeatureError(ValueError):
    """Raised when a payload cannot be turned into a feature vector."""


def to_vector(payload: Dict[str, Any]) -> np.ndarray:
    """Converts a feature mapping into a clipped, ordered vector.

    Missing values are rejected rather than defaulted: a missing feature means
    the caller and the model disagree about the contract, and silently scoring
    a made-up value would be worse than returning an error.
    """
    if not isinstance(payload, dict):
        raise FeatureError("features must be an object")

    missing = [name for name in FEATURE_NAMES if name not in payload]
    if missing:
        raise FeatureError(f"missing features: {', '.join(missing)}")

    values: List[float] = []
    for spec in FEATURE_SPECS:
        raw = payload[spec.name]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise FeatureError(f"feature '{spec.name}' must be a number")
        if raw != raw or raw in (float("inf"), float("-inf")):
            raise FeatureError(f"feature '{spec.name}' must be finite")
        values.append(float(min(max(raw, spec.minimum), spec.maximum)))
    return np.asarray([values], dtype=float)


def validate_features(payload: Dict[str, Any]) -> Dict[str, float]:
    """Same contract as to_vector, returning the clipped values for echoing."""
    vector = to_vector(payload)
    return {name: float(vector[0][index]) for index, name in enumerate(FEATURE_NAMES)}
