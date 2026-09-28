"""Benchmark tasks: the HumAID taxonomy (fixed categories) and commander questions (ad hoc).

Commander questions are phrased the way an operations centre would ask them mid-incident.
Their gold answers are derived from the single human HumAID label (a union of categories),
so they are noisy where a tweet fits several categories — the same noise hits every method.
"""
import glob
import os
import pathlib

import pandas as pd

DATA = pathlib.Path(__file__).parent / "data"
TARGET = "california_wildfires_2018"

# HumAID label -> description (paraphrased from the HumAID annotation guidelines).
LABELS: dict[str, str] = {
    "caution_and_advice": "Warnings, safety advice, advisories or instructions about the disaster",
    "displaced_people_and_evacuations": "People evacuated, displaced, relocated, or in shelters; evacuation orders",
    "infrastructure_and_utility_damage": "Damage to buildings, homes, roads, bridges, power lines, water or other utilities",
    "injured_or_dead_people": "Reports of people injured or killed, casualty counts",
    "missing_or_found_people": "People reported missing, or missing people who were found",
    "not_humanitarian": "Not about the disaster's humanitarian impact, or unrelated/irrelevant",
    "other_relevant_information": "Other useful information about the disaster not covered by the other categories",
    "requests_or_urgent_needs": "Requests for help or urgent needs: food, water, shelter, medical help, rescue, supplies",
    "rescue_volunteering_or_donation_effort": "Rescue operations, volunteering, fundraising or donations of money or goods",
    "sympathy_and_support": "Prayers, thoughts, condolences, emotional support",
}

# Commander questions: id -> (question text, set of HumAID labels counted as "yes").
# Two wordings of the same six questions (gold answers identical):
#   literal  - how an operations centre might phrase it off the cuff (first run)
#   category - rewritten to mirror the HumAID category definitions the gold is derived from
#              (checked once on the California *dev* split, never tuned on test)
QUESTION_SETS: dict[str, dict[str, tuple[str, set[str]]]] = {
    "literal": {
        "needs_help": ("Does this message ask for help, supplies or rescue for someone, or report an urgent unmet need?", {"requests_or_urgent_needs"}),
        "people_status": ("Does this message report specific people who are injured, dead, missing, or who were missing and have been found?", {"injured_or_dead_people", "missing_or_found_people"}),
        "actionable": ("Is this message operationally actionable for emergency responders — reporting damage, evacuations or displaced people, casualties, missing people, or urgent needs — rather than sympathy, fundraising, general commentary or unrelated content?",
                       {"infrastructure_and_utility_damage", "displaced_people_and_evacuations", "injured_or_dead_people", "missing_or_found_people", "requests_or_urgent_needs"}),
        "damage": ("Does this message report damage to homes, buildings, roads, power lines, water supply or other infrastructure?", {"infrastructure_and_utility_damage"}),
        "evacuation": ("Is this message about evacuations, evacuation orders, or people who have been displaced or are staying in shelters?", {"displaced_people_and_evacuations"}),
        "ignorable": ("Can an emergency operations centre safely ignore this message because it contains nothing about the disaster's impact on people or places?", {"not_humanitarian"}),
    },
    "category": {
        "needs_help": ("Does this message request help or supplies for people affected by the disaster, or describe their urgent needs such as food, water, shelter, medical care or rescue?", {"requests_or_urgent_needs"}),
        "people_status": ("Does this message report on people injured, killed, missing or found in the disaster, including casualty counts, death tolls, or news about the search for missing people?", {"injured_or_dead_people", "missing_or_found_people"}),
        "actionable": ("Does this message report concrete impact of the disaster — damage to property or infrastructure, evacuations or displaced people, injuries or deaths, missing people, or urgent needs — including news reports and official figures?",
                       {"infrastructure_and_utility_damage", "displaced_people_and_evacuations", "injured_or_dead_people", "missing_or_found_people", "requests_or_urgent_needs"}),
        "damage": ("Does this message report damage to or destruction of homes, buildings, structures, roads, power lines, water supply or other infrastructure, including counts of structures destroyed?", {"infrastructure_and_utility_damage"}),
        "evacuation": ("Is this message about evacuations, evacuation orders, evacuees, or people who were displaced, lost their homes, or are staying in shelters?", {"displaced_people_and_evacuations"}),
        "ignorable": ("Is this message unrelated to the disaster's humanitarian impact — for example politics, jokes, opinions, advertising, or topics other than the disaster's effects on people and places?", {"not_humanitarian"}),
    },
}
QSET = os.environ.get("QSET", "category")
QUESTIONS = QUESTION_SETS[QSET]


def _read(pattern: str) -> pd.DataFrame:
    files = sorted(glob.glob(str(DATA / pattern)))
    if not files:
        raise SystemExit("Run fetch_data.py first.")
    return pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)


def load_target_test() -> pd.DataFrame:
    df = _read(f"{TARGET}__test__*.parquet")
    df = df[df.class_label.isin(LABELS)].reset_index(drop=True)
    df["tweet_id"] = df.tweet_id.astype(str)
    return df


def load_other_events_train() -> pd.DataFrame:
    """Labelled data from the 18 *other* disasters: what exists before a new fire starts."""
    files = [f for f in glob.glob(str(DATA / "*__train__*.parquet")) if TARGET not in f]
    df = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    return df[df.class_label.isin(LABELS)].reset_index(drop=True)


def load_target_dev() -> pd.DataFrame:
    df = _read(f"{TARGET}__dev__*.parquet")
    df = df[df.class_label.isin(LABELS)].reset_index(drop=True)
    df["tweet_id"] = df.tweet_id.astype(str)
    return df


def load_target_train() -> pd.DataFrame:
    """In-event labels — NOT available during a real incident; an upper-bound reference only."""
    df = _read(f"{TARGET}__train__*.parquet")
    return df[df.class_label.isin(LABELS)].reset_index(drop=True)


def balanced_subset(df: pd.DataFrame, per_class: int = 35, seed: int = 7) -> pd.DataFrame:
    """Class-balanced head-to-head sample (rare classes kept whole)."""
    parts = [g.sample(min(len(g), per_class), random_state=seed) for _, g in df.groupby("class_label")]
    return pd.concat(parts).sort_index().reset_index(drop=True)


def mini_subset(balanced: pd.DataFrame, per_class: int = 10) -> pd.DataFrame:
    """Smaller class-balanced set, a strict subset of the balanced set (for the slow local LLM)."""
    return balanced.groupby("class_label", group_keys=False).head(per_class).reset_index(drop=True)


def gold_question(label: str, qid: str) -> int:
    return int(label in QUESTIONS[qid][1])
