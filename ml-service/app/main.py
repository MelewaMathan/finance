"""Advisory credit-scoring API.

This service is deliberately *narrow*: it turns 14 numeric features into a
score and an explanation, and it has no database, no user records and no
credentials. If it disappears, the API keeps working on its documented
fallback heuristic -- a scoring outage must never block a loan decision.

Run (from ml-service/):
    .venv\\Scripts\\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .anomaly import ANOMALY_FEATURES, AnomalyFeatureError, build_vector
from .features import FEATURE_NAMES, FeatureError, to_vector, validate_features

logger = logging.getLogger("smf.scoring")

ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "model" / "model.joblib"
ANOMALY_PATH = ROOT / "model" / "anomaly.joblib"

# Populated at startup.
_state: Dict[str, Any] = {"bundle": None, "loaded_from": None, "anomaly": None}


def _load_bundle() -> Dict[str, Any]:
    """Loads the trained artifact, training the shipped baseline if missing.

    Auto-training keeps a fresh clone demo-able without a manual step, and it
    is honest: /health reports `artifact: "trained-at-startup"` so nobody can
    mistake it for a curated production model.
    """
    if MODEL_PATH.exists():
        bundle = joblib.load(MODEL_PATH)
        _state["loaded_from"] = "artifact"
        return bundle

    from training.train import train  # imported lazily: only needed once

    logger.warning("no model artifact at %s; training the baseline now", MODEL_PATH)
    train()
    bundle = joblib.load(MODEL_PATH)
    _state["loaded_from"] = "trained-at-startup"
    return bundle


def _load_anomaly() -> Dict[str, Any]:
    """Loads (or trains) the Isolation Forest.

    The artifact path is fixed at import time and never derived from a request,
    so joblib only ever deserialises a file this repository produced.
    """
    if ANOMALY_PATH.exists():
        return joblib.load(ANOMALY_PATH)
    from training.train_anomaly import train as train_anomaly

    logger.warning("no anomaly artifact at %s; training the baseline now", ANOMALY_PATH)
    train_anomaly()
    return joblib.load(ANOMALY_PATH)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    bundle = _load_bundle()
    model = bundle["model"]
    expected = tuple(bundle["features"])
    if expected != tuple(FEATURE_NAMES):
        # A silent feature reorder would produce confidently wrong scores.
        raise RuntimeError(
            f"model was trained on {expected} but the code expects {tuple(FEATURE_NAMES)}; retrain"
        )
    anomaly = _load_anomaly()
    if tuple(anomaly["features"]) != tuple(ANOMALY_FEATURES):
        raise RuntimeError("anomaly artifact was trained on a different feature set; retrain")

    _state["bundle"] = bundle
    _state["model"] = model
    _state["anomaly"] = anomaly
    logger.info("scoring model %s ready (%s)", bundle["version"], _state["loaded_from"])
    yield
    _state.clear()


app = FastAPI(
    title="SecureMicrofinance advisory credit scoring",
    version="1.0.0",
    description="Advisory-only risk score. Never decides a loan on its own.",
    lifespan=lifespan,
)


class ScoreRequest(BaseModel):
    features: Dict[str, float] = Field(..., description="Numeric features; see /model for names")
    application_id: Optional[str] = Field(None, description="Loan id, for logging only")


class Factor(BaseModel):
    feature: str
    impact: float = Field(..., description="Change in default probability vs. the median borrower")
    direction: str = Field(..., description="'risk' when it increases default probability")


class ScoreResponse(BaseModel):
    score: int
    risk_level: str
    default_probability: float
    model_version: str
    model_source: str
    latency_ms: int
    explanation: List[Factor]
    features: Dict[str, float]
    thresholds: Dict[str, int]


def _score_to_level(score: int, thresholds: Dict[str, int]) -> str:
    if score >= thresholds["low_min"]:
        return "low"
    if score >= thresholds["medium_min"]:
        return "medium"
    return "high"


def _explain(model, vector: np.ndarray, medians: np.ndarray, baseline: float) -> List[Factor]:
    """Local explanation by median substitution.

    For each feature we replace the value with the training median and measure
    how the predicted probability moves. Positive impact means the borrower's
    actual value increases default risk relative to a typical applicant. This
    is cheap, deterministic, and -- unlike a global importance number -- it
    answers the question a lender actually asks: *why this applicant?*
    """
    factors: List[Factor] = []
    for index, name in enumerate(FEATURE_NAMES):
        if float(vector[0][index]) == float(medians[index]):
            continue
        perturbed = vector.copy()
        perturbed[0][index] = medians[index]
        probability = float(model.predict_proba(perturbed)[0][1])
        impact = baseline - probability
        if abs(impact) < 0.002:
            continue
        factors.append(
            Factor(feature=name, impact=round(impact, 4), direction="risk" if impact > 0 else "protective")
        )
    factors.sort(key=lambda factor: -abs(factor.impact))
    return factors[:6]


@app.get("/health")
def health() -> Dict[str, Any]:
    bundle = _state.get("bundle")
    anomaly = _state.get("anomaly")
    if bundle is None or anomaly is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "status": "ok",
        "model_loaded": True,
        "model_version": bundle["version"],
        "anomaly_version": anomaly["version"],
        "artifact": _state.get("loaded_from"),
        "features": len(FEATURE_NAMES),
        "anomaly_features": len(ANOMALY_FEATURES),
        "trained_at": bundle["metrics"]["trained_at"],
    }


@app.get("/model")
def model_info() -> Dict[str, Any]:
    bundle = _state.get("bundle")
    if bundle is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "version": bundle["version"],
        "features": FEATURE_NAMES,
        "thresholds": bundle["thresholds"],
        "metrics": bundle["metrics"],
        "advisory_only": True,
    }


@app.post("/score", response_model=ScoreResponse)
def score(request: ScoreRequest) -> ScoreResponse:
    bundle = _state.get("bundle")
    if bundle is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    started = time.perf_counter()
    try:
        vector = to_vector(request.features)
        echoed = validate_features(request.features)
    except FeatureError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    model = bundle["model"]
    probability = float(model.predict_proba(vector)[0][1])
    medians = np.asarray(bundle["medians"], dtype=float)
    thresholds = bundle["thresholds"]

    score_value = int(round(max(0.0, min(1.0, 1.0 - probability)) * 100))
    latency_ms = int(round((time.perf_counter() - started) * 1000))

    return ScoreResponse(
        score=score_value,
        risk_level=_score_to_level(score_value, thresholds),
        default_probability=round(probability, 4),
        model_version=bundle["version"],
        model_source="ml_service",
        latency_ms=latency_ms,
        explanation=_explain(model, vector, medians, probability),
        features=echoed,
        thresholds=thresholds,
    )


class AnomalyRequest(BaseModel):
    features: Dict[str, float] = Field(..., description="Seven numeric features; see /model/anomaly")
    application_id: Optional[str] = Field(None, description="Transaction id, for logging only")


class UnusualFeature(BaseModel):
    feature: str
    value: float
    typical: float
    deviation: float = Field(..., description="Robust z-score: how many MADs from the normal population")


class AnomalyResponse(BaseModel):
    is_anomaly: bool
    risk: float = Field(..., description="0 (typical) to 1 (highly unusual)")
    severity: str
    decision_score: float
    threshold: float
    model_version: str
    latency_ms: int
    unusual: List[UnusualFeature]


@app.get("/model/anomaly")
def anomaly_info() -> Dict[str, Any]:
    anomaly = _state.get("anomaly")
    if anomaly is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "version": anomaly["version"],
        "features": ANOMALY_FEATURES,
        "threshold": anomaly["threshold"],
        "metrics": anomaly["metrics"],
    }


@app.post("/anomaly", response_model=AnomalyResponse)
def anomaly(request: AnomalyRequest) -> AnomalyResponse:
    """Scores how unusual a money movement is.

    Isolation Forest returns a raw decision score where *higher means more
    normal*. We expose a 0-1 risk for the API to threshold on, and we report
    which inputs are furthest from the normal population -- that is an
    explanation of the *inputs*, not a claim about the forest's internals.
    """
    bundle = _state.get("anomaly")
    if bundle is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    started = time.perf_counter()
    try:
        vector = build_vector(request.features)
    except AnomalyFeatureError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    model = bundle["model"]
    decision_score = float(model.score_samples(vector)[0])
    threshold = float(bundle["threshold"])
    is_anomaly = bool(model.predict(vector)[0] == -1)

    # Monotone map: at the threshold the risk is exactly 0.5, and it saturates
    # quickly as the sample gets more unusual. No magic numbers in the caller.
    risk = float(1.0 / (1.0 + np.exp(-8.0 * (threshold - decision_score))))
    severity = "high" if risk >= 0.75 else "medium" if risk >= 0.6 else "low"

    medians = np.asarray(bundle["medians"], dtype=float)
    spread = np.asarray(bundle["mad"], dtype=float)
    unusual = []
    for index, name in enumerate(ANOMALY_FEATURES):
        deviation = float((vector[0][index] - medians[index]) / spread[index])
        unusual.append(
            UnusualFeature(
                feature=name,
                value=float(vector[0][index]),
                typical=float(medians[index]),
                deviation=round(deviation, 2),
            )
        )
    unusual.sort(key=lambda item: -abs(item.deviation))

    return AnomalyResponse(
        is_anomaly=is_anomaly,
        risk=round(risk, 4),
        severity=severity,
        decision_score=round(decision_score, 4),
        threshold=round(threshold, 4),
        model_version=bundle["version"],
        latency_ms=int(round((time.perf_counter() - started) * 1000)),
        unusual=unusual[:3],
    )
