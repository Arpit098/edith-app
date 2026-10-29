#!/usr/bin/env python3
"""Train the "Hey Edith" model with openWakeWord 0.6.0 and export it with its metrics.

    python3 train.py [--session latest|<id>] [--work ../work] [--device auto|mps|cuda|cpu] [--steps 25000]

Run fetch.py (the recordings) and data.py (the training data) first. Steps, as in openWakeWord's own
train.py (its __main__ block, which hardcodes CUDA, is re-created here so the device can be MPS):
1. Synthetic clips with Piper: "hey edith" in many voices (positives) and similar-sounding phrases
   (adversarial negatives). Skipped when they already exist.
2. Arpit's recordings: 4 of every 5 positive clips go into the training positives (repeated
   --real-repeat times, augmented like the synthetic ones); 2 of every 3 noise clips become background
   audio for augmentation and negative training windows. The rest are held out for the metrics only.
3. Augmentation (noise, room reverb) and openWakeWord features for all clips.
4. Training (auto_train) against the precomputed negative features, on the chosen device.
5. Export: wakeword/models/hey_edith.onnx, hey_edith.json and metrics.md (false-reject rate on the
   held-out recordings, false accepts per hour on the negative validation set and the held-out noise).

Everything else (generated clips, features, checkpoints) stays in <work>/train/<session>.
"""
import argparse
import glob
import json
import logging
import os
import random
import shutil
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # the few ops MPS lacks run on the CPU instead
import lib  # noqa: E402

MODELS = os.path.join(HERE, "..", "models")
NAME = "hey_edith"
PHRASE = "hey edith"
NEAR_MISSES = ["hey eddie", "hey edit", "hey ed", "edith", "hey ella", "hey anita", "hey eden", "a tooth",
               "hey alexa", "okay google", "hey keith", "they did"]
log = logging.getLogger("hey_edith")


def latest_session(work):
    found = []
    for path in glob.glob(os.path.join(work, "recordings", "*", "manifest.json")):
        with open(path) as f:
            m = json.load(f)
        found.append((m["created_at"], m["session"]))
    if not found:
        raise SystemExit("no recordings in the work dir: run fetch.py first")
    return max(found)[1]


def wav_count(folder):
    return len(glob.glob(os.path.join(folder, "*.wav")))


def write_wav(path, frames: bytes):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(frames)


def noise_windows(clips, folder, out_dir, samples):
    """Cut each noise clip into windows of the training clip length (negative training clips)."""
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    for c in clips:
        with wave.open(os.path.join(folder, f"{c['sha256']}.wav")) as w:
            while len(chunk := w.readframes(samples)) == samples * 2:
                write_wav(os.path.join(out_dir, f"noise_{c['sha256'][:12]}_{n}.wav"), chunk)
                n += 1
    return n


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--session", default="latest")
    p.add_argument("--work", default=os.path.join(HERE, "..", "work"))
    p.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    p.add_argument("--n-samples", type=int, default=20000, help="synthetic training clips per class")
    p.add_argument("--n-samples-val", type=int, default=2000)
    p.add_argument("--steps", type=int, default=25000)
    p.add_argument("--real-repeat", type=int, default=20, help="copies of each real training recording")
    p.add_argument("--tts-batch-size", type=int, default=25)
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--background", action="append", default=[], help="extra folders of background audio")
    p.add_argument("--overwrite", action="store_true", help="recompute features")
    p.add_argument("--seed", type=int, default=7)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    random.seed(args.seed)

    import numpy as np
    import torch
    import openwakeword
    from openwakeword.data import augment_clips, generate_adversarial_texts, mmap_batch_generator
    from openwakeword.train import Model
    from openwakeword.utils import AudioFeatures, compute_features_from_generator
    import scipy.io.wavfile

    torch.manual_seed(args.seed)
    device = lib.pick_device(torch, args.device)
    log.info("device: %s (openWakeWord %s, torch %s)", device, openwakeword.__version__ if hasattr(openwakeword, "__version__") else "0.6.0", torch.__version__)

    work = os.path.abspath(args.work)
    data = os.path.join(work, "data")
    session = latest_session(work) if args.session == "latest" else args.session
    rec = os.path.join(work, "recordings", session)
    with open(os.path.join(rec, "manifest.json")) as f:
        manifest = json.load(f)
    clips_dir = os.path.join(rec, "clips")
    positives = [c for c in manifest["clips"] if c["kind"].startswith("positive_")]
    noise = [c for c in manifest["clips"] if c["kind"] == "noise"]
    if len(positives) < 10:
        raise SystemExit(f"only {len(positives)} \"Hey Edith\" clips in session {session}: record at least 10 (30-50 is better)")
    pos_train, pos_held = lib.split(positives, 5)
    noise_train, noise_held = lib.split(noise, 3) if len(noise) >= 3 else (noise, [])
    log.info("session %s: %d positives (%d held out), %d noise clips (%d held out)",
             session, len(positives), len(pos_held), len(noise), len(noise_held))

    out = os.path.join(work, "train", session)
    model_dir = os.path.join(out, NAME)
    dirs = {k: os.path.join(model_dir, k) for k in ("positive_train", "positive_test", "negative_train", "negative_test")}
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)

    # 1. Synthetic clips (Piper), skipped when ~enough exist (as openWakeWord does)
    psg = os.path.join(data, "piper-sample-generator")
    sys.path.insert(0, psg)
    from generate_samples import generate_samples
    model_pt = os.path.join(psg, "models", "en_US-libritts_r-medium.pt")
    adversarial = NEAR_MISSES + generate_adversarial_texts(input_text=PHRASE, N=args.n_samples // 2,
                                                           include_partial_phrase=1.0, include_input_words=0.2)
    for key, texts, n, batch in (("positive_train", [PHRASE], args.n_samples, args.tts_batch_size),
                                 ("positive_test", [PHRASE], args.n_samples_val, args.tts_batch_size),
                                 ("negative_train", adversarial, args.n_samples, max(1, args.tts_batch_size // 7)),
                                 ("negative_test", adversarial, args.n_samples_val, max(1, args.tts_batch_size // 7))):
        have = len([f for f in os.listdir(dirs[key]) if not f.startswith(("real_", "noise_"))])
        if have < 0.95 * n:
            log.info("generating %d %s clips with Piper", n - have, key)
            generate_samples(text=texts, max_samples=n - have, batch_size=batch, noise_scales=[0.98],
                             noise_scale_ws=[0.98], length_scales=[0.75, 1.0, 1.25], output_dir=dirs[key],
                             auto_reduce_batch_size=True, model=model_pt,
                             file_names=[f"{os.urandom(8).hex()}.wav" for _ in range(n - have)])

    # Clip length, from the synthetic test positives (as openWakeWord computes it)
    lengths = [len(scipy.io.wavfile.read(f)[1]) for f in random.sample(glob.glob(os.path.join(dirs["positive_test"], "*.wav")), 50)]
    total_length = int(round(np.median(lengths) / 1000) * 1000) + 12000
    total_length = 32000 if total_length < 32000 or abs(total_length - 32000) <= 4000 else total_length

    # 2. Arpit's recordings
    for c in pos_train:
        for i in range(args.real_repeat):
            dest = os.path.join(dirs["positive_train"], f"real_{c['sha256'][:12]}_{i}.wav")
            if not os.path.exists(dest):
                shutil.copyfile(os.path.join(clips_dir, f"{c['sha256']}.wav"), dest)
    background = os.path.join(out, "background")
    os.makedirs(background, exist_ok=True)
    for c in noise_train:
        shutil.copyfile(os.path.join(clips_dir, f"{c['sha256']}.wav"), os.path.join(background, f"{c['sha256']}.wav"))
    windows = noise_windows(noise_train, clips_dir, dirs["negative_train"], total_length)
    background_paths = [os.path.join(background, f) for f in os.listdir(background)]
    for extra in args.background:
        background_paths += [e.path for e in os.scandir(extra) if e.name.lower().endswith(".wav")]
    if not background_paths:
        raise SystemExit("no background audio: record some noise clips in the app, or pass --background <folder of wavs>")
    rir_paths = [e.path for e in os.scandir(os.path.join(data, "rir"))]
    log.info("real positives: %d x %d; noise: %d background clips, %d negative windows", len(pos_train),
             args.real_repeat, len(background_paths), windows)

    # 3. Augmentation and features
    on_cuda = device == "cuda"
    ncpu = max(1, (os.cpu_count() or 2) // 2)
    for key in dirs:
        target = os.path.join(model_dir, f"{key.split('_')[0]}_features_{key.split('_')[1]}.npy")
        if os.path.exists(target) and not args.overwrite:
            continue
        clips = glob.glob(os.path.join(dirs[key], "*.wav"))
        log.info("augmenting and computing features: %s (%d clips)", key, len(clips))
        gen = augment_clips(clips, total_length=total_length, batch_size=16, background_clip_paths=background_paths,
                            RIR_paths=rir_paths)
        compute_features_from_generator(gen, n_total=len(clips), clip_duration=total_length, output_file=target,
                                        device="gpu" if on_cuda else "cpu", ncpu=1 if on_cuda else ncpu)

    # 4. Training
    F = AudioFeatures(device="cpu")
    input_shape = F.get_embedding_shape(total_length // 16000)
    oww = Model(n_classes=1, input_shape=input_shape, model_type="dnn", layer_dim=32,
                seconds_per_example=1280 * input_shape[0] / 16000)
    oww.device = torch.device(device)  # openWakeWord picks CUDA or CPU only; MPS is set here

    def reshape(x, n=16):
        if n != x.shape[1]:
            x = np.vstack(x)
            return np.array([x[i:i + n, :] for i in range(0, x.shape[0] - n, n)])
        return x

    negatives = sorted(glob.glob(os.path.join(data, "*ACAV100M*.npy")))
    if not negatives:
        raise SystemExit("negative features missing: run data.py first")
    files = {"ACAV100M_sample": negatives[-1], "positive": os.path.join(model_dir, "positive_features_train.npy"),
             "adversarial_negative": os.path.join(model_dir, "negative_features_train.npy")}
    batches = mmap_batch_generator(files, n_per_class={"ACAV100M_sample": 1024, "adversarial_negative": 50, "positive": 50},
                                   data_transform_funcs={"ACAV100M_sample": reshape},
                                   label_transform_funcs={"positive": lambda x: [1 for _ in x],
                                                          "ACAV100M_sample": lambda x: [0 for _ in x],
                                                          "adversarial_negative": lambda x: [0 for _ in x]})

    class Batches(torch.utils.data.IterableDataset):
        def __iter__(self):
            return batches

    # macOS starts DataLoader workers with spawn, which can't pickle a generator: load in-process there
    workers = 0 if sys.platform == "darwin" else ncpu
    X_train = torch.utils.data.DataLoader(Batches(), batch_size=None, num_workers=workers,
                                          prefetch_factor=16 if workers else None)
    val_neg = np.load(os.path.join(data, "validation_set_features.npy"))
    windows_fp = np.lib.stride_tricks.sliding_window_view(val_neg, (input_shape[0], val_neg.shape[1]))[:, 0]
    X_val_fp = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(
        torch.from_numpy(np.ascontiguousarray(windows_fp)), torch.zeros(len(windows_fp))), batch_size=len(windows_fp))
    pos_test = np.load(os.path.join(model_dir, "positive_features_test.npy"))
    neg_test = np.load(os.path.join(model_dir, "negative_features_test.npy"))
    labels = np.hstack((np.ones(len(pos_test)), np.zeros(len(neg_test)))).astype(np.float32)
    X_val = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(
        torch.from_numpy(np.vstack((pos_test, neg_test))), torch.from_numpy(labels)), batch_size=len(labels))
    log.info("training on %s for %d steps", device, args.steps)
    best = oww.auto_train(X_train=X_train, X_val=X_val, false_positive_val_data=X_val_fp, steps=args.steps,
                          max_negative_weight=1500, target_fp_per_hour=0.5)
    oww.export_model(model=best, model_name=NAME, output_dir=out)
    onnx_path = os.path.join(out, f"{NAME}.onnx")

    # 5. Metrics on data the model never saw, with the exported ONNX model (what the phone runs)
    import onnxruntime as ort
    from openwakeword.model import Model as Detector
    detector = Detector(wakeword_models=[onnx_path], inference_framework="onnx")

    def max_score(path, padding):
        detector.reset()
        return [frame[NAME] for frame in detector.predict_clip(path, padding=padding)]

    rejected = sum(max(max_score(os.path.join(clips_dir, f"{c['sha256']}.wav"), 1)) < args.threshold for c in pos_held)
    noise_hits = sum(lib.activations(max_score(os.path.join(clips_dir, f"{c['sha256']}.wav"), 0), args.threshold)
                     for c in noise_held)
    noise_hours = sum(c["seconds"] for c in noise_held) / 3600
    session_ort = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    input_name = session_ort.get_inputs()[0].name
    val_scores = (float(session_ort.run(None, {input_name: w[None].astype(np.float32)})[0].ravel()[0]) for w in windows_fp)
    val_hits = lib.activations(val_scores, args.threshold)
    val_hours = len(val_neg) * lib.FRAME_SECONDS / 3600
    metrics = {"false_reject_rate": round(rejected / len(pos_held), 4), "held_out_positives": len(pos_held),
               "false_accepts_per_hour": round(val_hits / val_hours, 3), "negative_hours": round(val_hours, 2),
               "noise_false_accepts_per_hour": round(noise_hits / noise_hours, 3) if noise_hours else 0.0,
               "noise_hours": round(noise_hours, 3)}

    os.makedirs(MODELS, exist_ok=True)
    final = os.path.join(MODELS, f"{NAME}.onnx")
    shutil.copyfile(onnx_path, final)
    params = {"n_samples": args.n_samples, "steps": args.steps, "real_repeat": args.real_repeat, "seed": args.seed,
              "negative_features": os.path.basename(negatives[-1]), "total_length": total_length}
    info = lib.model_info(final, session, args.threshold, metrics, device, "0.6.0", params)
    lib.write_json(os.path.join(MODELS, f"{NAME}.json"), info)
    with open(os.path.join(MODELS, "metrics.md"), "w") as f:
        f.write(lib.metrics_md(info))
    print(lib.metrics_md(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
