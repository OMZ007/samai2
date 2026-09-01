"""Flattens the collected survey responses into one CSV.

    python export_csv.py path/to/responses > responses.csv

One row per response. The fixed fields come first, then one column per
question, in the order the survey asks them. A question that appears in some
responses and not others (the wording changed, say) still gets its own column;
rows that never answered it are left empty.

Written with the standard library only, and with a BOM, so the file opens
correctly in Excel with Arabic intact.
"""

import csv
import json
import pathlib
import sys

FIXED = ["module", "moduleTitle", "name", "submittedAt", "receivedAt", "country"]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    root = pathlib.Path(sys.argv[1])
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2

    rows = []
    questions = []  # ordered, de-duplicated

    for path in sorted(root.rglob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as error:
            print(f"skipped {path}: {error}", file=sys.stderr)
            continue

        row = {field: record.get(field, "") for field in FIXED}
        for answer in record.get("answers", []):
            question = answer.get("question", "")
            if not question:
                continue
            if question not in questions:
                questions.append(question)
            row[question] = answer.get("answer", "")
        rows.append(row)

    if not rows:
        print("no responses found", file=sys.stderr)
        return 1

    # utf-8-sig: Excel needs the BOM to read this as UTF-8 rather than as the
    # local codepage, which turns every Arabic column into mojibake.
    out = open(sys.stdout.fileno(), "w", encoding="utf-8-sig", newline="", closefd=False)
    writer = csv.DictWriter(out, fieldnames=FIXED + questions, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    out.flush()

    print(f"{len(rows)} responses, {len(questions)} questions", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
