// Prefix-bound stale-result pruning (keeping warm superseded reads for models
// whose signed thinking is bound to the prompt prefix) is not part of the slim
// build: every model now prunes superseded reads. The removed surface's tests
// were deleted; superseded-read pruning itself is covered by the compaction
// tests.
