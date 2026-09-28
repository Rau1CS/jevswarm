"""Local zero-shot baselines (CPU, no GPU on the benchmark machine):
  nli  — MoritzLaurer/deberta-v3-base-zeroshot-v2.0 entailment scoring (a standard local zero-shot classifier)
  llm  — Qwen/Qwen2.5-1.5B-Instruct, next-token probabilities for option letters / Yes-No
Both answer the taxonomy and the commander questions without task-specific training.
"""
import time

import torch
from transformers import AutoModelForCausalLM, AutoModelForSequenceClassification, AutoTokenizer

from tasks import LABELS, QSET, QUESTIONS

LABEL_IDS = list(LABELS)

# NLI needs statements rather than questions (one set per question wording).
Q_STATEMENT_SETS = {
    "literal": {
        "needs_help": "This message asks for help, supplies or rescue, or reports an urgent unmet need.",
        "people_status": "This message reports specific people who are injured, dead, missing or found.",
        "actionable": "This message reports damage, evacuations, casualties, missing people or urgent needs.",
        "damage": "This message reports damage to homes, buildings, roads, power lines or other infrastructure.",
        "evacuation": "This message is about evacuations or displaced people in shelters.",
        "ignorable": "This message says nothing about the disaster's impact on people or places.",
    },
    "category": {
        "needs_help": "This message requests help or supplies for affected people or describes their urgent needs.",
        "people_status": "This message reports people injured, killed, missing or found, including death tolls or searches for the missing.",
        "actionable": "This message reports concrete disaster impact: damage, evacuations, injuries or deaths, missing people or urgent needs.",
        "damage": "This message reports damage to or destruction of homes, buildings, roads, power lines or other infrastructure.",
        "evacuation": "This message is about evacuations, evacuees, displaced people or shelters.",
        "ignorable": "This message is unrelated to the disaster's effects on people and places.",
    },
}
Q_STATEMENTS = Q_STATEMENT_SETS[QSET]


class NliModel:
    NAME = "MoritzLaurer/deberta-v3-base-zeroshot-v2.0"

    def __init__(self):
        self.tok = AutoTokenizer.from_pretrained(self.NAME)
        self.model = AutoModelForSequenceClassification.from_pretrained(self.NAME).eval()
        self.ent = self.model.config.label2id.get("entailment", 0)

    @torch.no_grad()
    def _entail(self, text: str, hyps: list[str]) -> list[float]:
        enc = self.tok([text] * len(hyps), hyps, return_tensors="pt", padding=True, truncation=True, max_length=256)
        return torch.softmax(self.model(**enc).logits, -1)[:, self.ent].tolist()

    def predict(self, text: str) -> tuple[dict[str, float], dict[str, float], float]:
        t0 = time.perf_counter()
        hyps = [f"This message is about: {d}." for d in LABELS.values()] + list(Q_STATEMENTS.values())
        e = self._entail(text, hyps)
        lab = e[: len(LABELS)]
        z = sum(lab) or 1.0
        probs = {k: v / z for k, v in zip(LABEL_IDS, lab)}
        q = dict(zip(Q_STATEMENTS, e[len(LABELS):]))
        return probs, q, (time.perf_counter() - t0) * 1000


class SmallLlm:
    NAME = "Qwen/Qwen2.5-1.5B-Instruct"
    LETTERS = "ABCDEFGHIJ"

    def __init__(self):
        self.tok = AutoTokenizer.from_pretrained(self.NAME)
        self.model = AutoModelForCausalLM.from_pretrained(self.NAME, torch_dtype=torch.float32).eval()
        self.letter_ids = [self.tok.encode(c, add_special_tokens=False)[0] for c in self.LETTERS]
        self.yes = self.tok.encode("Yes", add_special_tokens=False)[0]
        self.no = self.tok.encode("No", add_special_tokens=False)[0]

    def _prompt(self, user: str) -> str:
        msgs = [{"role": "system", "content": "You classify social-media messages posted during a wildfire disaster. Answer with a single token."},
                {"role": "user", "content": user}]
        return self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)

    @torch.no_grad()
    def _next_logits(self, prompts: list[str]) -> torch.Tensor:
        self.tok.padding_side = "left"
        enc = self.tok(prompts, return_tensors="pt", padding=True)
        return self.model(**enc).logits[:, -1, :]

    def predict(self, text: str) -> tuple[dict[str, float], dict[str, float], float]:
        t0 = time.perf_counter()
        opts = "\n".join(f"{self.LETTERS[i]}. {d}" for i, d in enumerate(LABELS.values()))
        p_cat = self._prompt(f"Message: \"{text}\"\n\nWhich category fits best?\n{opts}\n\nAnswer with the letter only.")
        p_q = [self._prompt(f"Message: \"{text}\"\n\nQuestion: {q}\nAnswer Yes or No.") for q, _ in QUESTIONS.values()]
        logits = self._next_logits([p_cat] + p_q)
        lp = torch.softmax(logits[0, self.letter_ids], -1).tolist()
        probs = dict(zip(LABEL_IDS, lp))
        yn = torch.softmax(logits[1:, [self.yes, self.no]], -1)[:, 0].tolist()
        q = dict(zip(QUESTIONS, yn))
        return probs, q, (time.perf_counter() - t0) * 1000
