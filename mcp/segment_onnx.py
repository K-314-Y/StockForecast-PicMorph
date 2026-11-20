"""Optional single-file EfficientSAM ONNX worker for Linux CPU inference."""

import ctypes
import fcntl
import json
import os
from pathlib import Path
import resource
import signal
import stat
import subprocess
import sys


MODEL_ENV = "CREATURE_SEGMENT_ONNX_MODEL"
WIDTH, HEIGHT = 192, 208
ENCODER_SIZE = 1024
MAX_MODEL_BYTES = 64 * 1024 * 1024
MAX_ADDRESS_SPACE = 1536 * 1024 * 1024
MAX_WALL_SECONDS = 8
MAX_CPU_SECONDS = 7
MIN_MASK_PIXELS = 4
MAX_MASK_PIXELS = WIDTH * HEIGHT * 0.84
LOGITS, SCORES = "output_masks", "iou_predictions"
NEURAL_METHOD = "efficientsam-onnx-cpu"
FAILURES = {
    2: "invalid_model_file",
    3: "runtime_unavailable",
    4: "model_inference_failed",
    5: "no_usable_neural_mask",
    6: "inference_busy",
    -signal.SIGXCPU: "inference_timeout",
}


def try_mask(image, points):
    """Return a binary mask or a public fallback code, without loading native code here."""
    model = os.environ.get(MODEL_ENV)
    if not model:
        return None, None
    try:
        worker = subprocess.run(
            [sys.executable, "-B", "-E", "-s", __file__, str(os.getpid()),
             model, json.dumps(points)], input=image.tobytes(),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=MAX_WALL_SECONDS,
            env={"LANG": "C.UTF-8", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
                 "ORT_DISABLE_TELEMETRY": "1"},
        )
    except subprocess.TimeoutExpired:
        return None, "inference_timeout"
    except (OSError, ValueError):
        return None, "worker_unavailable"
    if worker.returncode != 0 or len(worker.stdout) != WIDTH * HEIGHT:
        return None, FAILURES.get(worker.returncode, "model_inference_failed")
    return worker.stdout, None


def limit_worker(parent_pid):
    # MCP can kill its helper on cancellation. Kill its inference worker too,
    # including when the helper exits between fork and setting the death signal.
    libc = ctypes.CDLL(None, use_errno=True)
    pr_set_pdeathsig = 1
    if libc.prctl(pr_set_pdeathsig, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent_pid:
        raise OSError("Could not bind the worker to its parent")
    for kind, limit in ((resource.RLIMIT_AS, MAX_ADDRESS_SPACE), (resource.RLIMIT_CORE, 0)):
        _, hard = resource.getrlimit(kind)
        bounded = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
        resource.setrlimit(kind, (bounded, bounded))
    _, hard = resource.getrlimit(resource.RLIMIT_CPU)
    hard = MAX_CPU_SECONDS + 1 if hard == resource.RLIM_INFINITY else min(hard, MAX_CPU_SECONDS + 1)
    resource.setrlimit(resource.RLIMIT_CPU, (min(hard, MAX_CPU_SECONDS), hard))


def model_bytes(filename):
    path = Path(filename)
    if not path.is_absolute() or path.suffix != ".onnx":
        raise ValueError("Expected an absolute ONNX file path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_MODEL_BYTES:
            raise ValueError("Invalid ONNX model size or type")
        data = stream.read(MAX_MODEL_BYTES + 1)
        if len(data) != info.st_size:
            raise ValueError("ONNX model changed while reading")
        return data


def shape_matches(node, expected):
    return (node.type == "tensor(float)" and len(node.shape) == len(expected) and
            all(not isinstance(size, int) or size == target
                for size, target in zip(node.shape, expected)))


def infer(ort, np, image_module, model, rgba_bytes, points):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    options.use_deterministic_compute = True
    # Load by value. This backend expects a self-contained export with embedded weights.
    session = ort.InferenceSession(model, sess_options=options, providers=["CPUExecutionProvider"])

    inputs = {node.name: node for node in session.get_inputs()}
    outputs = {node.name: node for node in session.get_outputs()}
    if set(inputs) != {"batched_images", "batched_point_coords", "batched_point_labels"} or not {
            LOGITS, SCORES} <= set(outputs):
        raise ValueError("Unsupported EfficientSAM ONNX interface")
    image_node = inputs["batched_images"]
    if shape_matches(image_node, (1, 3, ENCODER_SIZE, ENCODER_SIZE)):
        width = height = ENCODER_SIZE
    elif shape_matches(image_node, (1, 3, HEIGHT, WIDTH)):
        width, height = WIDTH, HEIGHT
    else:
        raise ValueError("Unsupported EfficientSAM input size")

    # The upstream export was traced with five points. Pad unused slots with
    # ignored prompts. A six-point request needs a compatible export.
    coords_node = inputs["batched_point_coords"]
    labels_node = inputs["batched_point_labels"]
    point_count = next((count for count in range(max(5, len(points)), 7)
                        if shape_matches(coords_node, (1, 1, count, 2)) and
                        shape_matches(labels_node, (1, 1, count))), None)
    if point_count is None:
        raise ValueError("Unsupported EfficientSAM prompt shape")
    rgba = image_module.frombytes("RGBA", (WIDTH, HEIGHT), rgba_bytes)
    neutral = image_module.new("RGBA", rgba.size, (128, 128, 128, 255))
    rgb = image_module.alpha_composite(neutral, rgba).convert("RGB")
    rgb = rgb.resize((width, height), image_module.Resampling.BILINEAR)
    rgb = np.asarray(rgb, dtype=np.float32) / 255.0
    coords = np.full((1, 1, point_count, 2), -1, dtype=np.float32)
    labels = np.full((1, 1, point_count), -1, dtype=np.float32)
    coords[0, 0, :len(points)] = [(x * width / WIDTH, y * height / HEIGHT) for x, y in points]
    labels[0, 0, :len(points)] = 1
    feeds = {
        "batched_images": np.ascontiguousarray(rgb.transpose(2, 0, 1)[None]),
        "batched_point_coords": coords,
        "batched_point_labels": labels,
    }
    if not any(shape_matches(outputs[LOGITS], (1, 1, count, height, width)) and
               shape_matches(outputs[SCORES], (1, 1, count)) for count in range(1, 4)):
        raise ValueError("Unsupported EfficientSAM output shape")
    logits, scores = session.run([LOGITS, SCORES], feeds)
    if (scores.ndim != 3 or scores.shape[:2] != (1, 1) or not 1 <= scores.shape[2] <= 3 or
            logits.shape != (*scores.shape, height, width) or
            not np.isfinite(scores).all() or not np.isfinite(logits).all()):
        raise ValueError("Invalid EfficientSAM outputs")
    opaque = np.asarray(rgba.getchannel("A")) >= 16
    for index in np.argsort(-scores[0, 0], kind="stable"):
        logit_image = image_module.fromarray(logits[0, 0, index])
        logit_image = logit_image.resize(rgba.size, image_module.Resampling.BILINEAR)
        mask = (np.asarray(logit_image) >= 0) & opaque
        if (MIN_MASK_PIXELS <= np.count_nonzero(mask) < MAX_MASK_PIXELS and
                all(mask[y, x] for x, y in points)):
            return mask.astype(np.uint8).tobytes()
    return None


def run_model(filename, seeds):
    try:
        model = model_bytes(filename)
    except (OSError, ValueError):
        return 2
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
        ort.disable_telemetry_events()
        if "CPUExecutionProvider" not in ort.get_available_providers():
            return 3
    except Exception:  # An installed wheel can fail to import its native libraries.
        return 3
    try:
        frame = sys.stdin.buffer.read(WIDTH * HEIGHT * 4 + 1)
        mask = infer(ort, np, Image, model, frame, json.loads(seeds))
    except Exception:  # ORT raises several native exception types. Keep paths private.
        return 4
    if mask is None:
        return 5
    sys.stdout.buffer.write(mask)
    return 0


def worker_main(parent_pid, filename, seeds):
    limit_worker(int(parent_pid))
    os.environ["ORT_DISABLE_TELEMETRY"] = "1"
    # A directory flock limits this checkout to one worker across MCP processes.
    lock = os.open(Path(__file__).parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 6
        return run_model(filename, seeds)
    finally:
        os.close(lock)


if __name__ == "__main__":
    sys.exit(worker_main(*sys.argv[1:]))
