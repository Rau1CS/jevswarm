"""A question nobody trained for: "is this written by an eyewitness on the scene?"

Data: CrisisLexT26 (Olteanu et al., 2015) crowd labels for *Information Source*.
Target: the two wildfire events (2012 Colorado wildfires, 2013 Australia bushfire).
Sample: every Eyewitness tweet plus a fixed random sample of other labelled tweets.

Methods
  keywords      first-person / on-scene cues (written before looking at target data)
  nli, llm      local zero-shot models (CPU)
  jev           one Noul per message
  tfidf_ref     reference only: classifier trained on eyewitness labels from the 24 *other*
                CrisisLexT26 disasters — i.e. someone anticipated this exact question and
                paid for labels in advance.

  python eyewitness.py --method jev     (cached, resumable)
  python eyewitness.py --report
"""
import argparse
import glob
import json
import pathlib
import re
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, f1_score, roc_auc_score

DATA = pathlib.Path(__file__).parent / "data"
RESULTS = pathlib.Path(__file__).parent / "results"
TARGETS = ["2012_Colorado_wildfires", "2013_Australia_bushfire"]
QUESTION = ("Was this message written by someone who is personally at the scene of the fire — directly seeing, "
            "hearing or experiencing it, or affected on the ground — rather than by news media, officials, "
            "organisations, businesses, or people following it from elsewhere?")
STATEMENT = "The author of this message is personally at the scene, directly seeing or experiencing the fire."
ON_SCENE = ["i can see", "i see", "we can see", "outside my", "my house", "my home", "our house", "our home", "we were evacuated",
            "we evacuated", "i was evacuated", "i evacuated", "just drove", "driving past", "from my", "here in", "near me",
            "smell smoke", "smell the smoke", "ash falling", "ash is falling", "can see the", "view from", "my backyard", "my street",
            "my neighborhood", "my neighbourhood", "we're", "we are packing", "packing up", "just saw", "look at this", "right now"]


def load_source(event: str) -> pd.DataFrame:
    d = pd.read_csv(DATA / f"crisislex_{event}.csv", encoding="utf-8", encoding_errors="replace")
    d.columns = [c.strip() for c in d.columns]
    d = d[~d["Information Source"].isin(["Not labeled", "Not applicable"])]
    return pd.DataFrame({"id": d["Tweet ID"].astype(str).str.strip("'"), "text": d["Tweet Text"].astype(str),
                         "y": (d["Information Source"] == "Eyewitness").astype(int), "event": event})


def target_sample(n_neg: int = 480, seed: int = 11) -> pd.DataFrame:
    df = pd.concat([load_source(e) for e in TARGETS], ignore_index=True).drop_duplicates("id")
    pos, neg = df[df.y == 1], df[df.y == 0].sample(n_neg, random_state=seed)
    return pd.concat([pos, neg]).sample(frac=1, random_state=seed).reset_index(drop=True)


def reference_train() -> pd.DataFrame:
    events = [pathlib.Path(f).stem.replace("crisislex_", "") for f in glob.glob(str(DATA / "crisislex_*.csv"))]
    return pd.concat([load_source(e) for e in events if e not in TARGETS], ignore_index=True)


def run(method: str, limit: int | None = None) -> None:
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"eyewitness_{method}.jsonl"
    done = {json.loads(l)["id"] for l in out.read_text(encoding="utf-8").splitlines()} if out.exists() else set()
    df = target_sample()
    if limit:
        df = df.head(limit)  # target_sample is shuffled, so head() is a random subset
    todo = [r for r in df.itertuples() if r.id not in done]
    print(f"eyewitness/{method}: {len(done)} cached, {len(todo)} to run")

    def write(rec):
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    if method == "keywords":
        for r in todo:
            t0 = time.perf_counter()
            s = r.text.lower()
            hits = sum(1 for w in ON_SCENE if w in s) + len(re.findall(r"\b(i|my|we|our|me)\b", s)) * 0.2
            write({"id": r.id, "p": min(1.0, hits / 2), "ms": (time.perf_counter() - t0) * 1000})
    elif method == "tfidf_ref":
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression
        tr = reference_train()
        vec = TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True)
        clf = LogisticRegression(max_iter=2000, C=4.0, class_weight="balanced").fit(vec.fit_transform(tr.text), tr.y)
        for r in todo:
            t0 = time.perf_counter()
            p = float(clf.predict_proba(vec.transform([r.text]))[0, 1])
            write({"id": r.id, "p": p, "ms": (time.perf_counter() - t0) * 1000})
    elif method in ("nli", "llm"):
        import torch
        from methods_local import NliModel, SmallLlm
        if method == "nli":
            m = NliModel()
            f = lambda text: m._entail(text, [STATEMENT])[0]
        else:
            m = SmallLlm()
            def f(text):
                with torch.no_grad():
                    lg = m._next_logits([m._prompt(f"Message: \"{text}\"\n\nQuestion: {QUESTION}\nAnswer Yes or No.")])
                return torch.softmax(lg[0, [m.yes, m.no]], -1)[0].item()
        for i, r in enumerate(todo):
            t0 = time.perf_counter()
            p = f(r.text)
            write({"id": r.id, "p": float(p), "ms": (time.perf_counter() - t0) * 1000})
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}")
    elif method == "jev":
        from methods_jev import api_key, call
        key = api_key()

        def one(r):
            body = {"model": "jev-latest", "state": {"message": r.text}, "questions": {"eyewitness": {"type": "noul", "instructions": QUESTION}}}
            resp, ms = call(key, body)
            return {"id": r.id, "p": float(resp["answers"]["eyewitness"]["noul"]), "ms": ms, "tokens": int(resp.get("usage", {}).get("input_tokens", 0))}

        with ThreadPoolExecutor(8) as ex:
            for rec in ex.map(one, todo):
                write(rec)
    else:
        raise SystemExit(method)


NAMES = {"keywords": "Keyword rules", "nli": "Local zero-shot NLI (CPU)", "llm": "Local small LLM Qwen2.5-1.5B (CPU)",
         "jev": "Jev (jev-1.13.0)", "tfidf_ref": "Reference: classifier trained on eyewitness labels from 24 other disasters"}


def report(limit: int | None = None) -> str:
    df = target_sample()
    if limit:
        df = df.head(limit)
    lines = ["| Method | AUROC | Average precision | F1@0.5 | Precision in top 50 | p50 latency |", "| --- | --- | --- | --- | --- | --- |"]
    scores = {}
    for m, name in NAMES.items():
        f = RESULTS / f"eyewitness_{m}.jsonl"
        if not f.exists():
            continue
        P = {r["id"]: r for r in map(json.loads, f.read_text(encoding="utf-8").splitlines())}
        if any(i not in P for i in df.id):
            continue
        y = df.y.to_numpy()
        p = np.array([P[i]["p"] for i in df.id])
        top = np.argsort(-p)[:50]
        s = {"auc": roc_auc_score(y, p), "ap": average_precision_score(y, p), "f1": f1_score(y, p >= 0.5),
             "p50": float(np.mean(y[top])), "ms": float(np.median([P[i]["ms"] for i in df.id]))}
        scores[m] = s
        lines.append(f"| {name} | {s['auc']:.2f} | {s['ap']:.2f} | {s['f1']:.2f} | {s['p50'] * 100:.0f} % | {s['ms']:.0f} ms |")
    (RESULTS / f"eyewitness_scores{'_' + str(limit) if limit else ''}.json").write_text(json.dumps(scores, indent=1), encoding="utf-8")
    base = df.y.mean()
    return (f"Sample: {len(df)} wildfire tweets ({int(df.y.sum())} eyewitness, base rate {base:.0%}; random ranking would give "
            f"average precision ≈ {base:.2f}).\n\n" + "\n".join(lines))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--method")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    if a.method:
        run(a.method, a.limit)
    if a.report:
        print(report(a.limit))
