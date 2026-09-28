"""Score cached predictions and write results/REPORT.md."""
import json
import pathlib

import numpy as np
from sklearn.metrics import accuracy_score, brier_score_loss, f1_score, roc_auc_score

from tasks import LABELS, QUESTION_SETS, balanced_subset, load_target_test, mini_subset

RESULTS = pathlib.Path(__file__).parent / "results"
PRICE_PER_M = 0.042  # $ per million input tokens, jev-1.13.0 (docs.typesafe.ai/models)
NAMES = {
    "keywords": "Keyword rules",
    "tfidf_other": "Trained classifier (18 other disasters)",
    "nli": "Local zero-shot NLI (DeBERTa-v3-base, CPU)",
    "llm": "Local small LLM (Qwen2.5-1.5B, CPU)",
    "jev": "Jev (jev-1.13.0)",
    "tfidf_oracle": "Reference: classifier trained on this fire (not available live)",
}
KEY_CLASSES = ["requests_or_urgent_needs", "missing_or_found_people", "injured_or_dead_people", "infrastructure_and_utility_damage", "displaced_people_and_evacuations"]


def load(method: str, subset: str, qset: str) -> dict[str, dict] | None:
    f = RESULTS / f"preds_{method}_{'balanced' if subset == 'mini' else subset}_{qset}.jsonl"
    if not f.exists():
        return None
    return {r["id"]: r for r in map(json.loads, f.read_text(encoding="utf-8").splitlines())}


def coverage_at(acc_target: float, conf: np.ndarray, correct: np.ndarray) -> float:
    """Largest share of messages that can be auto-routed (highest confidence first) at ≥ target accuracy."""
    order = np.argsort(-conf)
    hits = np.cumsum(correct[order]) / np.arange(1, len(order) + 1)
    ok = np.where(hits >= acc_target)[0]
    return float((ok.max() + 1) / len(order)) if len(ok) else 0.0


def score(method: str, subset: str, df, qset: str) -> dict | None:
    questions = QUESTION_SETS[qset]
    preds = load(method, subset, qset)
    if not preds or any(i not in preds for i in df.tweet_id):
        return None
    rows = [preds[i] for i in df.tweet_id]
    gold = df.class_label.tolist()
    labs = list(LABELS)
    P = np.array([[r["probs"].get(l, 0.0) for l in labs] for r in rows])
    pred = [labs[i] for i in P.argmax(1)]
    conf = P.max(1)
    correct = np.array([p == g for p, g in zip(pred, gold)], dtype=float)
    per_class = f1_score(gold, pred, labels=labs, average=None, zero_division=0)
    out = {
        "acc": accuracy_score(gold, pred),
        "macro_f1": f1_score(gold, pred, labels=labs, average="macro", zero_division=0),
        "key_f1": float(np.mean([per_class[labs.index(c)] for c in KEY_CLASSES])),
        "cov90": coverage_at(0.9, conf, correct),
        "per_class": dict(zip(labs, per_class.round(3).tolist())),
    }
    q_auc, q_f1, q_brier, per_q = [], [], [], {}
    for qid, (_, pos) in questions.items():
        y = np.array([int(g in pos) for g in gold])
        p = np.array([r["q"][qid] for r in rows])
        auc = roc_auc_score(y, p) if 0 < y.sum() < len(y) else float("nan")
        f1 = f1_score(y, (p >= 0.5).astype(int), zero_division=0)
        br = brier_score_loss(y, np.clip(p, 0, 1))
        q_auc.append(auc); q_f1.append(f1); q_brier.append(br)
        per_q[qid] = {"auc": round(auc, 3), "f1": round(f1, 3), "brier": round(br, 3), "positives": int(y.sum())}
    out.update({"q_auc": float(np.nanmean(q_auc)), "q_f1": float(np.mean(q_f1)), "q_brier": float(np.mean(q_brier)), "per_q": per_q})
    ms = np.array([r["ms"] for r in rows])
    out["ms_p50"], out["ms_p95"] = float(np.percentile(ms, 50)), float(np.percentile(ms, 95))
    tok = [r.get("tokens", 0) for r in rows]
    out["cost_per_1k"] = float(np.mean(tok) * 1000 * PRICE_PER_M / 1e6) if any(tok) else 0.0
    thr = RESULTS / f"throughput_{method}_{'balanced' if subset == 'mini' else subset}_{qset}.json"
    if thr.exists():
        t = json.loads(thr.read_text(encoding="utf-8"))
        out["throughput"] = t["messages"] / t["wall_s"]
    else:
        out["throughput"] = 1000.0 / out["ms_p50"] if out["ms_p50"] > 0 else float("inf")
    return out


def table(subset: str, df, qset: str = "category") -> tuple[str, dict]:
    res = {m: score(m, subset, df, qset) for m in NAMES}
    res = {m: r for m, r in res.items() if r}
    lines = [
        "| Method | Accuracy | Macro-F1 | F1 on key categories | Auto-routable at 90 % acc. | Question AUROC | Question F1@0.5 | Brier ↓ | Latency p50 / p95 | Msgs/s | $ / 1k msgs |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for m, r in res.items():
        lines.append(
            f"| {NAMES[m]} | {r['acc']:.2f} | {r['macro_f1']:.2f} | {r['key_f1']:.2f} | {r['cov90'] * 100:.0f} % | "
            f"{r['q_auc']:.2f} | {r['q_f1']:.2f} | {r['q_brier']:.3f} | {r['ms_p50']:.0f} / {r['ms_p95']:.0f} ms | "
            f"{r['throughput']:.1f} | {'$%.4f' % r['cost_per_1k'] if r['cost_per_1k'] else '—'} |"
        )
    return "\n".join(lines), res


def per_question(res: dict, qset: str) -> str:
    qs = list(QUESTION_SETS[qset])
    head = f"| Method | {' | '.join(qs)} |\n| --- | {' | '.join('---' for _ in qs)} |\n"
    return head + "\n".join(f"| {NAMES[m]} | " + " | ".join(f"{r['per_q'][q]['auc']:.2f} / {r['per_q'][q]['f1']:.2f}" for q in qs) + " |" for m, r in res.items())


def main() -> None:
    from eyewitness import report as eyewitness_report
    full = load_target_test()
    bal = balanced_subset(full)
    t_bal, r_bal = table("balanced", bal)
    t_full, r_full = table("full", full)
    _, r_lit = table("balanced", bal, "literal")
    mini = mini_subset(bal)
    t_mini, _ = table("mini", mini)
    md = f"""# Disaster-message triage benchmark: results

## A. Fixed taxonomy + commander questions (HumAID, California wildfires 2018)

Balanced head-to-head set: {len(bal)} messages (at most 35 per category). Full test set: {len(full)} messages.
Question wording: *category* (mirrors the category definitions; checked once on the dev split).

### Head-to-head (balanced set)

{t_bal}

### Including the local small LLM (mini set: {len(mini)} messages, 10 per category)

The 1.5B local LLM needed ~28 s per message on this CPU for the same 7 judgments, so it was scored on a smaller
class-balanced subset; every method is re-scored on exactly those messages.

{t_mini}

### Full test set

{t_full}

### Commander questions, balanced set (AUROC / F1@0.5)

{per_question(r_bal, "category")}

### Same questions with the first, *literal* wording (AUROC / F1@0.5)

{per_question(r_lit, "literal")}

## B. A question nobody trained for: "is the author an eyewitness on the scene?"

CrisisLexT26 crowd labels, 2012 Colorado wildfires + 2013 Australia bushfire.

{eyewitness_report()}

Including the local small LLM (random 200-message subset of the same sample, every method re-scored on it):

{eyewitness_report(200)}
"""
    (RESULTS / "REPORT.md").write_text(md, encoding="utf-8")
    (RESULTS / "scores.json").write_text(json.dumps({"balanced": r_bal, "full": r_full, "balanced_literal": r_lit}, indent=1), encoding="utf-8")
    print(md)


if __name__ == "__main__":
    main()
