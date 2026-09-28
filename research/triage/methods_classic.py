"""Non-model baselines: keyword rules and supervised TF-IDF + logistic regression.

Each method returns, per tweet: label probabilities over LABELS and a probability per
commander question. Supervised models answer questions by summing the probabilities of the
question's gold categories (only possible because the question maps onto the taxonomy).
"""
import re
import time

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from tasks import LABELS, QUESTIONS

LABEL_IDS = list(LABELS)

# Written before looking at the target test set.
KEYWORDS: dict[str, list[str]] = {
    "caution_and_advice": ["warning", "warn", "advis", "stay safe", "be careful", "red flag", "air quality", "mask", "tips", "prepare", "alert"],
    "displaced_people_and_evacuations": ["evacuat", "shelter", "displaced", "fled", "flee", "homeless", "relocat", "evac"],
    "infrastructure_and_utility_damage": ["destroy", "damage", "burned down", "homes lost", "structures", "power out", "outage", "road closed", "closure", "burnt", "leveled"],
    "injured_or_dead_people": ["dead", "death", "killed", "died", "toll", "injur", "bodies", "remains", "fatalit", "victims"],
    "missing_or_found_people": ["missing", "unaccounted", "found safe", "have you seen", "last seen", "located"],
    "requests_or_urgent_needs": ["need", "please help", "urgent", "looking for", "anyone have", "supplies", "water needed", "can someone"],
    "rescue_volunteering_or_donation_effort": ["donat", "volunteer", "gofundme", "fundrais", "raise money", "relief fund", "rescue", "helping"],
    "sympathy_and_support": ["pray", "thoughts", "heartbroken", "condolence", "rip", "sending love", "stay strong", "hearts go out"],
}


def keyword_predict(text: str) -> tuple[dict[str, float], float]:
    t0 = time.perf_counter()
    s = text.lower()
    hits = {k: sum(1 for w in ws if w in s) for k, ws in KEYWORDS.items()}
    best = max(hits, key=hits.get)
    if hits[best] == 0:
        # Mentions of the fire without a specific signal → other_relevant; otherwise not humanitarian.
        best = "other_relevant_information" if re.search(r"fire|blaze|smoke|burn", s) else "not_humanitarian"
    probs = {k: (1.0 if k == best else 0.0) for k in LABEL_IDS}
    return probs, (time.perf_counter() - t0) * 1000


class TfidfModel:
    def __init__(self, train_texts, train_labels):
        self.vec = TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True, max_features=200_000)
        X = self.vec.fit_transform(train_texts)
        self.clf = LogisticRegression(max_iter=2000, C=4.0, class_weight="balanced")
        self.clf.fit(X, train_labels)

    def predict(self, text: str) -> tuple[dict[str, float], float]:
        t0 = time.perf_counter()
        p = self.clf.predict_proba(self.vec.transform([text]))[0]
        probs = {k: 0.0 for k in LABEL_IDS}
        for cls, v in zip(self.clf.classes_, p):
            probs[cls] = float(v)
        return probs, (time.perf_counter() - t0) * 1000


def questions_from_label_probs(probs: dict[str, float]) -> dict[str, float]:
    return {qid: float(np.clip(sum(probs[l] for l in gold), 0, 1)) for qid, (_, gold) in QUESTIONS.items()}
