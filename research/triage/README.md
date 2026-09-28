# Disaster-message triage: where is Jev actually useful?

**Question.** During a wildfire, responders are flooded with messages: calls, texts and social posts.
The value is in fast, changing, ad hoc judgments over that stream ("is someone asking for help?",
"is this person actually on the scene?"). Is Jev better suited to this than the alternatives?

- Keyword rules
- A classifier trained on past disasters
- Small models that run locally

**Setup.** All runs are on real, human-labelled disaster data. Nothing here is simulated.

| | |
| --- | --- |
| A. Taxonomy + commander questions | [HumAID](https://crisisnlp.qcri.org/humaid_dataset) (QCRI, CC BY-NC-SA 4.0). Target: California wildfires 2018 test split (1,461 tweets); balanced head-to-head set of 324 tweets. The trained baseline only gets the 18 *other* disasters (48k tweets): the labelled data that exists when a new fire starts. |
| B. A question nobody trained for | [CrisisLexT26](https://github.com/sajao/CrisisLex) crowd labels of *information source*. Target: 2012 Colorado wildfires + 2013 Australia bushfire, 641 tweets (all 161 eyewitness tweets + 480 others). Question: *is the author an eyewitness on the scene?* |

**Methods (same messages, same questions)**

| Method | What it is |
| --- | --- |
| Keyword rules | hand-written cues (written before looking at the target data) |
| Trained classifier | TF-IDF + logistic regression on labels from *other* disasters |
| Local zero-shot NLI | `MoritzLaurer/deberta-v3-base-zeroshot-v2.0`, CPU |
| Local small LLM | `Qwen/Qwen2.5-1.5B-Instruct`, next-token probabilities, CPU |
| Jev | `jev-1.13.0`: one request per message; one Choice over the taxonomy plus one Noul per question, answered together |

**Fairness notes**

- **Commander-question gold.** Answers in A are derived from the single human category label, so
  they are noisy where a tweet fits several categories. The noise hits every method equally.
- **Question wording.** The first wording ("literal") was reworded once to mirror the category
  definitions. The rewording was checked on the *dev* split only and never tuned on test. Both
  runs are reported.
- **Local models ran on a CPU-only laptop.** A GPU would make them much faster, not more accurate.
- **No frontier LLM** (GPT or Claude class) baseline: no API key was available on this machine.

## Reproduce

```bash
cd research/triage
python fetch_data.py                               # HumAID parquet → data/ (gitignored)
# CrisisLexT26 CSVs → data/crisislex_<event>.csv (see eyewitness.py docstring)
QSET=category python run.py --method jev --subset balanced   # also: keywords, tfidf_other, tfidf_oracle, nli, llm; --subset full|dev
python eyewitness.py --method jev                  # also: keywords, tfidf_ref, nli, llm
python report.py                                   # → results/REPORT.md
```

Jev reads `TYPESAFE_API_KEY` from the project's `.env.local`.

- **Cost:** about 830 input tokens per message for 7 questions; at $0.042 per million input
  tokens that is about **$0.04 per 1,000 messages**.
- **Total spend:** ≈ $0.17 for everything here (4,963 requests, 3.9M input tokens).

## Results

Full tables are in [results/REPORT.md](results/REPORT.md).

### Findings

1. **Fixed categories.** Jev is the most accurate method without any training.
   - Full test set: accuracy 0.74, vs 0.71 for a classifier trained on 48k labelled tweets from 18
     other disasters and 0.72 for one trained on this fire's own labels.
   - Its probabilities are the most usable for routing: at 90 % accuracy it can auto-route
     **53 %** of messages (balanced set: 45 % vs 18 %).
2. **Questions derived from the categories.** Jev ties the trained classifier on ranking (AUROC
   0.94 vs 0.95).
   - The classifier is better calibrated for these questions, because their gold is literally its
     training labels.
   - Jev follows wording literally. "Specific people" excluded death tolls (F1 0.23). Wording that
     mirrors the intended definition fixed it (0.87).
3. **A question nobody trained for ("is the author an eyewitness?").** Jev is the clear winner.
   - Average precision 0.72, vs 0.59 for a classifier trained on eyewitness labels from 24 other
     disasters, and 0.36 for keywords.
   - 86 % of its top 50 are real eyewitnesses.
   - This is the use case in one line: a new, subtle question asked mid-incident, with no labelled
     data, answered in about 0.3 s.
4. **Local models on a laptop CPU are neither good enough nor fast enough.**
   - Zero-shot NLI: 0.52 accuracy at 1.4 s per message.
   - Qwen2.5-1.5B: 0.53 accuracy and about 35 s for the same 7 judgments. On eyewitness its
     average precision is 0.47 vs Jev's 0.77.
5. **Operations.**
   - Jev: about 280 ms per message for 7 judgments in one request; 28 messages/s with 8 parallel
     workers.
   - At the documented 1,200 requests/min limit that is ≈ 70k messages/hour, at ≈ $0.04 per
     1,000 messages.

### What this does not show

- **No frontier LLM comparison.** It would probably be accurate but slower and far more expensive
  per message; measure it before claiming.
- **Gold labels:** single human labels (noisy for multi-topic tweets).
- **Data:** English tweets from 2012–2018, not 911 transcripts or radio.
- **Local models** ran on CPU only; a GPU changes speed, not the accuracy gap.

### Verdict

This is a real, Jev-shaped use case: **fast, ad hoc judgments over a high-volume stream of
messy disaster messages, where no labelled data exists for the question being asked.**

- Jev is most clearly better on new questions and on usable confidence.
- On the fixed categories a pre-trained classifier comes close.
