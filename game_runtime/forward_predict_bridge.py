"""One-shot computation for prices already verified by the server."""
import json
import math
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import prediction
from game_runtime.predict_bridge import model_from_record

MAX_INPUT_BYTES = 16 * 1024
MAX_HISTORY = 200


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON field")
    return result


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Prediction input too large")
    data = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    if type(data) is not dict or set(data) != {"model", "prices"}:
        raise ValueError("Invalid prediction input")
    model = model_from_record(data["model"])
    prices = data["prices"]
    if (type(prices) is not list or not model.slow_window <= len(prices) <= MAX_HISTORY
            or any(type(price) not in (int, float) or not math.isfinite(price) or price <= 0
                   for price in prices)):
        raise ValueError("Invalid price history")
    probabilities = prediction(model, tuple(prices))
    sys.stdout.write(json.dumps({"probabilities": probabilities}, allow_nan=False) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, ArithmeticError, RuntimeError):
        sys.exit("Forward prediction failed")
