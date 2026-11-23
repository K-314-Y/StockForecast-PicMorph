"""One bounded, local-only process for deterministic 2024 JPX replay."""
import json
import sys

if __package__:
    from . import market_bridge
else:
    import market_bridge


MAX_INPUT = 16 * 1024
MAX_OUTPUT = 256 * 1024
MAX_WINDOWS = 40


def select_windows(windows):
    """Take the earliest available full window for each code, then advance past its end."""
    if not windows:
        raise ValueError("no eligible windows")
    ids = set()
    for ident, code, rows in windows:
        days = [row[0] for row in rows]
        # candidate_windows receives validated calendar dates from load_local.
        if (not market_bridge.ID_RE.fullmatch(ident) or ident in ids or code not in market_bridge.CODES or
                len(days) != market_bridge.LOOKBACK + market_bridge.HORIZON or
                not all(day.startswith("2024-") for day in days) or
                any(a >= b for a, b in zip(days, days[1:]))):
            raise ValueError("invalid eligible window")
        ids.add(ident)

    selected, previous_ends = [], {}
    for window in sorted(windows, key=lambda item: (item[1], item[2][0][0], item[0])):
        _, code, rows = window
        if rows[0][0] <= previous_ends.get(code, ""):
            continue
        selected.append(window)
        if len(selected) > MAX_WINDOWS:
            raise ValueError("too many disjoint windows")
        previous_ends[code] = rows[-1][0]
    return selected


def evaluate(data):
    if not isinstance(data, dict) or set(data) != {"base_model", "models"}:
        raise ValueError("invalid batch input")
    base, models = market_bridge.parse_models(data["base_model"], data["models"])
    source = market_bridge.load_local()
    if source["origin"] != "LOCAL_JPX_REPORT_CACHE_2024" or source["adjusted"] is not False:
        raise ValueError("invalid local source")
    windows = market_bridge.candidate_windows(source)
    selected = select_windows(windows)
    return {"schema": 1, "eligible_windows": len(windows), "selected_windows": len(selected),
            "windows": [market_bridge.replay_window(source, len(windows), window, base, models) for window in selected]}


def main(stdin, stdout):
    data = stdin.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError("batch input too large")
    output = json.dumps(evaluate(json.loads(data)), ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(output) > MAX_OUTPUT:
        raise ValueError("batch output too large")
    stdout.write(output)


if __name__ == "__main__":
    try:
        main(sys.stdin.buffer, sys.stdout.buffer)
    except (ValueError, KeyError, TypeError, OSError):
        print("local historical batch unavailable", file=sys.stderr)
        sys.exit(1)
