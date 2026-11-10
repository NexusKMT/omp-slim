# @oh-my-pi/snapcompact

Bitmap-frame context compression for vision-capable LLMs.

Instead of asking an LLM to summarize discarded conversation history, snapcompact serializes it and renders the text into dense PNG frames of pixel-font glyphs that vision models read back directly. The whole pass is local and deterministic — no LLM call, no API key, no latency beyond rendering. Rasterization and PNG encoding happen in native code (`@oh-my-pi/pi-natives`).

Built for [omp](https://github.com/can1357/oh-my-pi)'s compaction pipeline, but the rendering API works on arbitrary text.

## How it works

1. Discarded history is serialized to compact text (`serializeConversation`), with per-tool-result and per-argument character caps.
2. Text is normalized for the selected native font (`normalize`): ANSI sequences stripped, whitespace collapsed, newline runs folded into a single full-block glyph, box drawing and compatibility symbols folded to ASCII, semantic emoji folded to ASCII labels, decorative emoji dropped, and non-Latin glyphs preserved when either the selected font or the embedded Silver fallback can render them.
3. Pages of text are rasterized into PNG frames (`render` / `renderMany`). Frame width is fixed per shape; height hugs the rows actually printed, with a 64px minimum so short final frames remain valid for vision processors.
4. Frames persist in the compaction entry's `preserveData` and are re-attached to the summary message on every context rebuild.

Frames use the generic `8on22-bw` grid by default: readable 8×13 glyphs with extra line spacing in a 1568px frame. `resolveShape(variant)` selects a named geometry explicitly. `resolveShapeForText(text, variant)` selects the Silver font for CJK-heavy text unless a variant is forced. No provider name, model id, endpoint URL or catalog rule affects the choice.

Bitmap shapes draw missing glyphs through the embedded Silver TrueType fallback. East Asian glyphs use two cells in the bitmap grids; `silver16-bw` uses Silver for the entire frame.

Token planning reserves `FRAME_TOKEN_ESTIMATE` (5,024) tokens per frame unless an explicit shape carries a verified estimate. This is a generic estimate, not an endpoint-specific billing promise. Callers can supply a complete `Shape` with `frameSize`, `frameTokenEstimate`, `frameTokensVerified` and an optional `imageDetail`. The default request limits are five images and 3 MB of base64 archive payload. Callers apply those limits using `maxFrames`, `maxFramesForDataBudget` and `capFrameDataBytes`; the compaction engine also has an 80-frame ceiling.

## Install

```sh
bun add @oh-my-pi/snapcompact
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.4.4.

## Usage

Render arbitrary text into LLM image blocks:

```ts
import { renderMany, frames, resolveShape } from "@oh-my-pi/snapcompact";

const shape = resolveShape("8on22-bw");
const images = await renderMany(longText, { shape }); // ImageContent[], first page first
const count = frames(longText, { shape }); // frame count without rendering
```

Run a full compaction pass over prepared messages:

```ts
import { compact } from "@oh-my-pi/snapcompact";

const result = await compact(preparation, { shape, maxFrames: 5, includeThinking: false });
// result.summary        — short "resume prior conversation" lead-in, reading guide, and FILES section
// result.preserveData   — bounded archive source + rendered image middle
```

## API surface

- **Compaction**: `compact`, `CompactionPreparation`, `CompactionResult`, `getPreservedArchive`, `images`, `historyBlocks`, `capFrameDataBytes`
- **Rendering**: `render`, `renderMany`, `frames`, `geometry`
- **Shapes**: `SHAPES`, `SHAPE_VARIANTS`, `resolveShape`, `resolveShapeForText`, `isShape`, `isShapeVariantName`
- **Text**: `serializeConversation`, `normalize`, `scanRenderability`, `renderabilityProbeText`, `dimStopwords`, `wrap`
- **Budgets**: `DEFAULT_IMAGE_BUDGET`, `DEFAULT_FRAME_DATA_BYTES_BUDGET`, `MAX_FRAMES_DEFAULT`, `FRAME_TOKEN_ESTIMATE`, `frameBilling`, `frameTokens`, `frameBillingKey`, `plannedFrameTokens`, `HQ_EDGE_FRAMES`
- **File ops**: `createFileOps`, `computeFileLists`, `upsertFileOperations`

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [Compaction architecture](../../docs/compaction.md)
- [CHANGELOG](./CHANGELOG.md)
