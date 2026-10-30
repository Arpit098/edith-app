# Wake word: "Hey Edith"

openWakeWord (Apache-2.0) custom model, trained on Arpit's MacBook from clips recorded in the app (PLAN.md §4.5).

```
wakeword/
├── training/   fetch.py (recordings from edith), data.py (training data), check.py (preflight), train.py; README.md has the steps
├── work/       git-ignored: recordings, training data, generated clips, the venv
└── models/     hey_edith.onnx + hey_edith.json + metrics.md, pushed to main by the trainer
```
