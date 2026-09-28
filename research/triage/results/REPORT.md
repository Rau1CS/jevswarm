# Disaster-message triage benchmark: results

## A. Fixed taxonomy + commander questions (HumAID, California wildfires 2018)

Balanced head-to-head set: 324 messages (at most 35 per category). Full test set: 1461 messages.
Question wording: *category* (mirrors the category definitions; checked once on the dev split).

### Head-to-head (balanced set)

| Method | Accuracy | Macro-F1 | F1 on key categories | Auto-routable at 90 % acc. | Question AUROC | Question F1@0.5 | Brier ↓ | Latency p50 / p95 | Msgs/s | $ / 1k msgs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Keyword rules | 0.52 | 0.51 | 0.62 | 1 % | 0.77 | 0.60 | 0.109 | 0 / 0 ms | 50000.0 | — |
| Trained classifier (18 other disasters) | 0.65 | 0.65 | 0.70 | 18 % | 0.95 | 0.67 | 0.055 | 4 / 5 ms | 235.4 | — |
| Local zero-shot NLI (DeBERTa-v3-base, CPU) | 0.52 | 0.49 | 0.54 | 0 % | 0.91 | 0.57 | 0.099 | 1445 / 2204 ms | 0.7 | — |
| Jev (jev-1.13.0) | 0.72 | 0.69 | 0.73 | 45 % | 0.94 | 0.63 | 0.097 | 273 / 358 ms | 28.0 | $0.0368 |
| Reference: classifier trained on this fire (not available live) | 0.64 | 0.63 | 0.68 | 34 % | 0.94 | 0.58 | 0.059 | 1 / 2 ms | 696.6 | — |

### Including the local small LLM (mini set: 100 messages, 10 per category)

The 1.5B local LLM needed ~28 s per message on this CPU for the same 7 judgments, so it was scored on a smaller
class-balanced subset; every method is re-scored on exactly those messages.

| Method | Accuracy | Macro-F1 | F1 on key categories | Auto-routable at 90 % acc. | Question AUROC | Question F1@0.5 | Brier ↓ | Latency p50 / p95 | Msgs/s | $ / 1k msgs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Keyword rules | 0.51 | 0.50 | 0.65 | 2 % | 0.77 | 0.60 | 0.108 | 0 / 0 ms | 51813.5 | — |
| Trained classifier (18 other disasters) | 0.59 | 0.60 | 0.71 | 33 % | 0.97 | 0.66 | 0.053 | 4 / 5 ms | 249.4 | — |
| Local zero-shot NLI (DeBERTa-v3-base, CPU) | 0.50 | 0.46 | 0.51 | 0 % | 0.91 | 0.60 | 0.099 | 1610 / 2434 ms | 0.6 | — |
| Local small LLM (Qwen2.5-1.5B, CPU) | 0.53 | 0.50 | 0.64 | 33 % | 0.88 | 0.58 | 0.148 | 34661 / 46361 ms | 0.0 | — |
| Jev (jev-1.13.0) | 0.67 | 0.66 | 0.75 | 41 % | 0.94 | 0.66 | 0.098 | 273 / 440 ms | 28.0 | $0.0368 |
| Reference: classifier trained on this fire (not available live) | 0.63 | 0.62 | 0.66 | 21 % | 0.96 | 0.59 | 0.061 | 1 / 2 ms | 729.1 | — |

### Full test set

| Method | Accuracy | Macro-F1 | F1 on key categories | Auto-routable at 90 % acc. | Question AUROC | Question F1@0.5 | Brier ↓ | Latency p50 / p95 | Msgs/s | $ / 1k msgs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Keyword rules | 0.52 | 0.46 | 0.56 | 0 % | 0.77 | 0.52 | 0.113 | 0 / 0 ms | 47619.0 | — |
| Trained classifier (18 other disasters) | 0.71 | 0.63 | 0.66 | 46 % | 0.96 | 0.69 | 0.042 | 4 / 6 ms | 223.9 | — |
| Jev (jev-1.13.0) | 0.74 | 0.64 | 0.64 | 53 % | 0.94 | 0.57 | 0.087 | 281 / 348 ms | 27.4 | $0.0368 |
| Reference: classifier trained on this fire (not available live) | 0.72 | 0.63 | 0.65 | 41 % | 0.95 | 0.61 | 0.047 | 2 / 2 ms | 641.9 | — |

### Commander questions, balanced set (AUROC / F1@0.5)

| Method | needs_help | people_status | actionable | damage | evacuation | ignorable |
| --- | --- | --- | --- | --- | --- | --- |
| Keyword rules | 0.74 / 0.59 | 0.87 / 0.73 | 0.79 / 0.80 | 0.81 / 0.65 | 0.90 / 0.74 | 0.52 / 0.10 |
| Trained classifier (18 other disasters) | 0.97 / 0.55 | 0.98 / 0.86 | 0.93 / 0.85 | 0.95 / 0.56 | 0.99 / 0.77 | 0.89 / 0.45 |
| Local zero-shot NLI (DeBERTa-v3-base, CPU) | 0.91 / 0.47 | 0.98 / 0.77 | 0.87 / 0.77 | 0.92 / 0.68 | 0.98 / 0.76 | 0.81 / 0.00 |
| Jev (jev-1.13.0) | 0.91 / 0.37 | 0.98 / 0.87 | 0.92 / 0.81 | 0.95 / 0.70 | 0.98 / 0.53 | 0.90 / 0.48 |
| Reference: classifier trained on this fire (not available live) | 0.90 / 0.19 | 0.98 / 0.86 | 0.92 / 0.82 | 0.93 / 0.66 | 0.98 / 0.61 | 0.92 / 0.36 |

### Same questions with the first, *literal* wording (AUROC / F1@0.5)

| Method | needs_help | people_status | actionable | damage | evacuation | ignorable |
| --- | --- | --- | --- | --- | --- | --- |
| Keyword rules | 0.74 / 0.59 | 0.87 / 0.73 | 0.79 / 0.80 | 0.81 / 0.65 | 0.90 / 0.74 | 0.52 / 0.10 |
| Trained classifier (18 other disasters) | 0.97 / 0.55 | 0.98 / 0.86 | 0.93 / 0.85 | 0.95 / 0.56 | 0.99 / 0.77 | 0.89 / 0.45 |
| Jev (jev-1.13.0) | 0.88 / 0.39 | 0.97 / 0.23 | 0.88 / 0.59 | 0.95 / 0.68 | 0.99 / 0.71 | 0.82 / 0.05 |
| Reference: classifier trained on this fire (not available live) | 0.90 / 0.19 | 0.98 / 0.86 | 0.92 / 0.82 | 0.93 / 0.66 | 0.98 / 0.61 | 0.92 / 0.36 |

## B. A question nobody trained for: "is the author an eyewitness on the scene?"

CrisisLexT26 crowd labels, 2012 Colorado wildfires + 2013 Australia bushfire.

Sample: 641 wildfire tweets (161 eyewitness, base rate 25%; random ranking would give average precision ≈ 0.25).

| Method | AUROC | Average precision | F1@0.5 | Precision in top 50 | p50 latency |
| --- | --- | --- | --- | --- | --- |
| Keyword rules | 0.62 | 0.36 | 0.22 | 54 % | 0 ms |
| Local zero-shot NLI (CPU) | 0.70 | 0.48 | 0.00 | 72 % | 235 ms |
| Jev (jev-1.13.0) | 0.87 | 0.72 | 0.58 | 86 % | 279 ms |
| Reference: classifier trained on eyewitness labels from 24 other disasters | 0.83 | 0.59 | 0.41 | 66 % | 2 ms |

Including the local small LLM (random 200-message subset of the same sample, every method re-scored on it):

Sample: 200 wildfire tweets (54 eyewitness, base rate 27%; random ranking would give average precision ≈ 0.27).

| Method | AUROC | Average precision | F1@0.5 | Precision in top 50 | p50 latency |
| --- | --- | --- | --- | --- | --- |
| Keyword rules | 0.56 | 0.34 | 0.18 | 38 % | 0 ms |
| Local zero-shot NLI (CPU) | 0.71 | 0.51 | 0.00 | 44 % | 236 ms |
| Local small LLM Qwen2.5-1.5B (CPU) | 0.72 | 0.47 | 0.40 | 42 % | 2760 ms |
| Jev (jev-1.13.0) | 0.89 | 0.77 | 0.60 | 74 % | 293 ms |
| Reference: classifier trained on eyewitness labels from 24 other disasters | 0.76 | 0.54 | 0.36 | 52 % | 2 ms |
