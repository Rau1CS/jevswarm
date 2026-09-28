"""Jev (TypeSafe System One) method: one request per message with speculative fan-out —
one Choice over the taxonomy plus one Noul per commander question, answered in parallel.

The API key is read from the project's .env.local (never printed or written to results).
"""
import json
import pathlib
import time
import urllib.error
import urllib.request

from tasks import LABELS, QUESTIONS

URL = "https://api.typesafe.ai/v1/systemone"
ENV = pathlib.Path(__file__).resolve().parents[2] / ".env.local"


def api_key() -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if line.startswith("TYPESAFE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("TYPESAFE_API_KEY missing from .env.local")


def build_request(text: str, include_choice: bool = True, include_questions: bool = True) -> dict:
    questions: dict = {}
    if include_choice:
        questions["category"] = {
            "type": "choice",
            "instructions": "Which humanitarian category best describes this social-media message posted during a wildfire disaster?",
            "criteria": LABELS,
        }
    if include_questions:
        for qid, (q, _) in QUESTIONS.items():
            questions[f"q.{qid}"] = {"type": "noul", "instructions": q}
    return {"model": "jev-latest", "state": {"message": text}, "questions": questions}


def call(key: str, body: dict, retries: int = 5) -> tuple[dict, float]:
    data = json.dumps(body).encode()
    for attempt in range(retries):
        req = urllib.request.Request(URL, data=data, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                out = json.load(r)
            return out, (time.perf_counter() - t0) * 1000
        except urllib.error.HTTPError as e:
            if e.code in (429, 529, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
    raise RuntimeError("unreachable")


def parse(out: dict) -> tuple[dict[str, float] | None, dict[str, float], int]:
    a = out["answers"]
    probs = None
    if "category" in a:
        probs = {k: float(a["category"].get("probabilities", {}).get(k, 0.0)) for k in LABELS}
        if not any(probs.values()):
            probs = {k: float(k == a["category"]["choice"]) for k in LABELS}
    q = {qid: float(a[f"q.{qid}"]["noul"]) for qid in QUESTIONS if f"q.{qid}" in a}
    return probs, q, int(out.get("usage", {}).get("input_tokens", 0))
