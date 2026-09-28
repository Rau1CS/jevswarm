"""Download HumAID (CC BY-NC-SA 4.0, QCRI) per-event splits from Hugging Face into data/ (gitignored)."""
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).parent / "data"
API = "https://huggingface.co/api/datasets/QCRI/HumAID-events/parquet"
TARGET = "california_wildfires_2018"


def main() -> None:
    ROOT.mkdir(exist_ok=True)
    index = json.load(urllib.request.urlopen(API))
    for event, splits in index.items():
        wanted = ["train", "dev", "test"] if event == TARGET else ["train"]
        for split in wanted:
            for i, url in enumerate(splits[split]):
                out = ROOT / f"{event}__{split}__{i}.parquet"
                if not out.exists():
                    urllib.request.urlretrieve(url, out)
                    print("fetched", out.name)


if __name__ == "__main__":
    main()
