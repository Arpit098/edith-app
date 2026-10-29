# Wake word: "Hey Edith"

openWakeWord (Apache-2.0) custom model, trained on free Google Colab (PLAN.md §4.5).

```
wakeword/
├── training/   notebook + config (phrase, augmentation, thresholds)
├── recordings/ manifest only; the audio is kept out of git (see .gitignore)
└── models/     exported hey_edith.onnx / .tflite + metrics.md
```
