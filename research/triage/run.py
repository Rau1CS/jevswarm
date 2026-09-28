"""Run one method over a subset and cache per-message predictions (JSONL, resumable).

  python run.py --method jev --subset balanced
Methods: keywords, tfidf_other, tfidf_oracle, nli, llm, jev.  Subsets: balanced (~320), full (1,461).
"""
import argparse
import json
import pathlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from methods_classic import TfidfModel, keyword_predict, questions_from_label_probs
from tasks import QSET, balanced_subset, mini_subset, load_other_events_train, load_target_dev, load_target_test, load_target_train

RESULTS = pathlib.Path(__file__).parent / "results"


def subset(name: str):
    if name == "dev":
        return load_target_dev()
    df = load_target_test()
    if name == "mini":
        return mini_subset(balanced_subset(df))
    return balanced_subset(df) if name == "balanced" else df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--method", required=True)
    ap.add_argument("--subset", default="balanced", choices=["balanced", "mini", "full", "dev"])
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    RESULTS.mkdir(exist_ok=True)
    # "mini" is a subset of "balanced" and shares its cache file.
    out = RESULTS / f"preds_{args.method}_{'balanced' if args.subset == 'mini' else args.subset}_{QSET}.jsonl"
    done = {json.loads(l)["id"] for l in out.read_text(encoding="utf-8").splitlines()} if out.exists() else set()
    df = subset(args.subset)
    todo = [r for r in df.itertuples() if r.tweet_id not in done]
    print(f"{args.method}/{args.subset}/{QSET}: {len(done)} cached, {len(todo)} to run")

    def write(rec: dict) -> None:
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    m = args.method
    if m in ("keywords", "tfidf_other", "tfidf_oracle"):
        if m == "keywords":
            pred = keyword_predict
        else:
            tr = load_other_events_train() if m == "tfidf_other" else load_target_train()
            model = TfidfModel(tr.tweet_text.tolist(), tr.class_label.tolist())
            pred = model.predict
        for r in todo:
            probs, ms = pred(r.tweet_text)
            write({"id": r.tweet_id, "probs": probs, "q": questions_from_label_probs(probs), "ms": ms})
    elif m in ("nli", "llm"):
        from methods_local import NliModel, SmallLlm
        model = NliModel() if m == "nli" else SmallLlm()
        for i, r in enumerate(todo):
            probs, q, ms = model.predict(r.tweet_text)
            write({"id": r.tweet_id, "probs": probs, "q": q, "ms": ms})
            if i % 25 == 0:
                print(f"  {i}/{len(todo)} · {ms:.0f} ms")
    elif m == "jev":
        from methods_jev import api_key, build_request, call, parse
        key = api_key()
        t0 = time.perf_counter()

        def one(r):
            resp, ms = call(key, build_request(r.tweet_text))
            probs, q, tokens = parse(resp)
            return {"id": r.tweet_id, "probs": probs, "q": q, "ms": ms, "tokens": tokens, "model": resp.get("model")}

        with ThreadPoolExecutor(args.workers) as ex:
            futs = [ex.submit(one, r) for r in todo]
            for i, f in enumerate(as_completed(futs)):
                write(f.result())
                if i % 50 == 0:
                    print(f"  {i}/{len(todo)}")
        wall = time.perf_counter() - t0
        (RESULTS / f"throughput_jev_{args.subset}_{QSET}.json").write_text(json.dumps({"messages": len(todo), "workers": args.workers, "wall_s": wall}), encoding="utf-8")
    else:
        raise SystemExit(f"unknown method {m}")
    print("done:", out.name)


if __name__ == "__main__":
    main()
