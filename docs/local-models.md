# Local auxiliary models in OMP Slim

OMP Slim uses the selected primary chat model. It does not start local title, judgment, composer-prediction, or word-completion models. The `tiny-models` and `predict` commands, ONNX and MLX worker launchers, Python runtime installers, and model download entry points have been removed.

Old model caches and settings files are not deleted. They are no longer read to enable auxiliary inference. Ordinary terminal editing, spelling, LSP completion, shell operations, and explicit model requests continue to work.

The shared `pi-predict` native crate and generic provider/catalog protocols remain for compatibility in this pass. OMP's application layer no longer invokes their local-model prediction APIs. Removing those native APIs and their dependencies is a separate lower-level cleanup.

Explicit `completion()` and `judge()` calls use the current primary chat model, including its image capability when applicable. They never select a local model or fall back to another model. Automatic auxiliary judgment is disabled.
