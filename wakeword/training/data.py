#!/usr/bin/env python3
"""Download the training data openWakeWord needs, all pinned (versions, revisions, SHA-256), into
<work>/data. Downloads resume; files already there with the right hash are skipped.

    python3 data.py [--work ../work] [--negative-hours 2000]

| What | Size | From |
|---|---|---|
| piper-sample-generator v2.0.0 source | 1 MB | github.com/rhasspy/piper-sample-generator @ 195e3bd |
| Piper voice model en_US-libritts_r-medium.pt | 204 MB | its v2.0.0 release |
| openWakeWord feature models (melspectrogram, embedding) | 2.4 MB | openWakeWord v0.5.1 release |
| Negative features (ACAV100M, 2000 h) | 17.3 GB (or a slice: --negative-hours) | huggingface.co/datasets/davidscripka/openwakeword_features |
| Negative validation set (11 h) | 185 MB | same dataset |
| Room impulse responses (MIT, 270 files) | 8 MB | huggingface.co/datasets/davidscripka/MIT_environmental_impulse_responses |

--negative-hours N downloads only the first N of the 2000 hours (byte range + a rewritten .npy header);
fewer hours train faster but accept more false wakes. The full file is checked against its SHA-256.
"""
import argparse
import json
import os
import sys
import tarfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import FetchError, download, npy_header, npy_header_bytes, request  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PSG_COMMIT = "195e3bd967d54589c2137c9de2b22ad526ba6b6f"  # piper-sample-generator v2.0.0
PSG_MODEL = ("https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt",
             "e95ee53770bf598c354a6e6dbfc95ccb259aeeb501d35a86be8a767429ab0ff6")
FEATURE_MODELS = {
    "melspectrogram.onnx": "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    "embedding_model.onnx": "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
}
OWW_RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/"
HF = "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/985bf1b47e7f19c07741af82bfe32d5a9dc56096/"
ACAV = ("openwakeword_features_ACAV100M_2000_hrs_16bit.npy",
        "721a66d0682c65a1b5c1da0aa109409cede1d20e28b15235c344b000cbb7654f", 2000)
VALIDATION = ("validation_set_features.npy", "a56a8a0f8e0efb91900acc6de4c0cdf4c564842e8475a7d49b36c039e17a690f")
RIR_REV = "b824a1ef2821f112fda0b9cb26e4278c62b425bb"
RIR_API = f"https://huggingface.co/api/datasets/davidscripka/MIT_environmental_impulse_responses/tree/{RIR_REV}/16khz"
RIR_FILE = f"https://huggingface.co/datasets/davidscripka/MIT_environmental_impulse_responses/resolve/{RIR_REV}/"


def piper_generator(data):
    src = os.path.join(data, "piper-sample-generator")
    if not os.path.exists(os.path.join(src, "generate_samples.py")):
        archive = download(f"https://github.com/rhasspy/piper-sample-generator/archive/{PSG_COMMIT}.tar.gz",
                           os.path.join(data, "piper-sample-generator.tar.gz"))
        with tarfile.open(archive) as t:
            t.extractall(data, filter="data")
        os.replace(os.path.join(data, f"piper-sample-generator-{PSG_COMMIT}"), src)
        os.remove(archive)
    download(PSG_MODEL[0], os.path.join(src, "models", "en_US-libritts_r-medium.pt"), PSG_MODEL[1])
    return src


def feature_models():
    """Into the installed openWakeWord package, where it looks for them."""
    import openwakeword  # noqa: the training venv must be active
    target = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
    for name, sha in FEATURE_MODELS.items():
        download(OWW_RELEASE + name, os.path.join(target, name), sha)
    return target


def negatives(data, hours):
    name, sha, total_hours = ACAV
    if hours >= total_hours:
        return download(HF + name, os.path.join(data, name), sha, timeout=600)
    dest = os.path.join(data, f"ACAV100M_{hours}_hrs_16bit.npy")
    if os.path.exists(dest):
        return dest
    with request(HF + name, {"Range": "bytes=0-1023"}) as r:
        head_len, descr, shape = npy_header(r.read(1024))
    rows = max(1, round(shape[0] * hours / total_hours))
    row_bytes = int(descr[-1]) * shape[1] * shape[2]
    header = npy_header_bytes(descr, (rows,) + shape[1:])
    if len(header) != head_len:
        raise FetchError("unexpected .npy header size; use --negative-hours 2000")
    part = download(HF + name, dest + ".download", start=0, length=head_len + rows * row_bytes, timeout=600)
    with open(part, "r+b") as f:  # the same header length: rewrite it in place, no copy
        f.write(header)
    os.replace(part, dest)
    return dest


def impulse_responses(data):
    folder = os.path.join(data, "rir")
    with request(RIR_API) as r:
        files = [f for f in json.load(r) if f["path"].endswith(".wav")]
    for f in files:
        sha = (f.get("lfs") or {}).get("oid")
        download(RIR_FILE + f["path"], os.path.join(folder, os.path.basename(f["path"])), sha)
    return folder


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--work", default=os.path.join(HERE, "..", "work"))
    p.add_argument("--negative-hours", type=int, default=2000)
    args = p.parse_args(argv)
    data = os.path.join(os.path.abspath(args.work), "data")
    os.makedirs(data, exist_ok=True)
    try:
        print("piper-sample-generator:", piper_generator(data))
        print("feature models:", feature_models())
        print("negative features:", negatives(data, args.negative_hours))
        print("validation set:", download(HF + VALIDATION[0], os.path.join(data, VALIDATION[0]), VALIDATION[1]))
        print("impulse responses:", impulse_responses(data))
    except (FetchError, OSError) as e:
        print(f"data download failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
