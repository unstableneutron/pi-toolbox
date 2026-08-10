# pi-fff-search

`pi-fff-search` provides the `fff_grep` and `fff_find_files` tools, compact FFF-backed search rendering, and an optional robust replacement for Pi's built-in `read` tool. The replacement keeps the existing FFF missing-path recovery, directory-to-`ls` flow, compact resource-file rendering, and native image attachments while adding bounded streaming text reads and local structured-document conversion.

## Installation

Install the toolbox package from GitHub or from a local checkout as described in the [repository README](../../README.md#using-this-with-pi). Enable the read replacement with:

```sh
export PI_FFF_OVERRIDE_READ=1
```

The structured converters are exact optional dependencies of this extension:

- `@firecrawl/pdf-inspector@1.12.0`
- `@firecrawl/anydoc@0.1.7`

They are imported only when their formats are read. An installation made with optional dependencies disabled can still start the extension and read ordinary text and images; reading the affected structured format returns a missing-dependency or unsupported-platform error. Reinstall with optional dependencies enabled to restore conversion.

## Supported formats and routing

| Input                                                      | Reader                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Plain text and source files                                | Incremental UTF-8 reader                         |
| JPEG, PNG, GIF, WebP, BMP                                  | Pi's native image pipeline after path validation |
| `.ipynb`                                                   | Native TypeScript notebook renderer              |
| `.pdf`                                                     | `@firecrawl/pdf-inspector` directly              |
| `.doc`, `.docx`, `.docm`                                   | Anydoc Word conversion                           |
| `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm` | Anydoc PowerPoint conversion                     |
| `.xls`, `.xlsx`, `.xlsm`, `.xlsb`                          | Anydoc Excel conversion                          |
| `.odt`, `.ods`, `.odp`                                     | Anydoc OpenDocument conversion                   |
| `.rtf`, `.epub`, `.csv`                                    | Anydoc conversion                                |

PDFs never use Anydoc's PDF path. Notebook Markdown and code cells are rendered with language-aware fences when metadata permits. Textual outputs and compact errors are retained after terminal escape and progress-line cleanup. Images, widgets, active HTML/JavaScript, binary data, and oversized outputs are omitted with an explicit summary.

Every converted result goes through the same line, response-byte, per-line, and continuation limits as ordinary text. Conversion reads are therefore bounded on output even though the source must fit in memory before the native converter is called.

## Limits and continuation

Defaults are compatible with Pi's native read response size:

| Setting                               | Environment variable                   | Default |
| ------------------------------------- | -------------------------------------- | ------- |
| Response lines                        | `PI_ROBUST_READ_MAX_LINES`             | 2,000   |
| Response data                         | `PI_ROBUST_READ_MAX_BYTES`             | 50 KiB  |
| Characters per line                   | `PI_ROBUST_READ_MAX_LINE_CHARS`        | 2,000   |
| Structured source size                | `PI_ROBUST_READ_STRUCTURED_MAX_BYTES`  | 50 MiB  |
| Streaming chunk size                  | `PI_ROBUST_READ_CHUNK_BYTES`           | 64 KiB  |
| Notebook output text                  | `PI_ROBUST_READ_NOTEBOOK_OUTPUT_CHARS` | 16 KiB  |
| Siblings considered for path recovery | `PI_ROBUST_READ_SIBLING_LIMIT`         | 1,024   |
| Ambiguous path suggestions            | `PI_ROBUST_READ_MAX_SUGGESTIONS`       | 5       |

`offset` is a one-based source-line offset and `limit` is a requested line count. A bounded response reports the exact next offset; continue with that value rather than rereading the file. Empty files and offsets exactly at or beyond EOF return explicit results. A single huge line is clamped while streaming instead of being fully accumulated. UTF-8 sequences split across chunks are preserved, while malformed UTF-8 is replaced with U+FFFD and reported in result details.

## Path and resource safety

The local reader resolves the requested path before opening it, follows symlink chains to their final target, and accepts only regular files or directories. FIFOs, sockets, character and block devices, broken or looping links, and other non-regular targets are rejected before sizing, parsing, or conversion. The opened file descriptor is checked again against the validated target to close the validation/open race.

Missing paths are recovered in this order:

1. Exact path.
2. Unicode NFC and known quote, dash, and spacing equivalents among a bounded sibling set.
3. Automatic recovery only when exactly one safe candidate exists.
4. At most five suggestions for ambiguous equivalent names.
5. The existing FFF recovery for broader repository matching.

An ambiguous candidate is never selected silently. Directories remain routed to the existing `ls` adapter, and known images remain attached through Pi's native image processing. The injectable custom `createBuiltInReadTool` test/remote-filesystem hook bypasses the local robust reader by design and remains responsible for an equivalent safety contract.

## PDFs and OCR

PDF output identifies the inspector classification and confidence, page count, encoding diagnostics, and pages with tables or columns when available. Extracted text is emitted per page. Scanned or mixed pages that lack a usable local text layer are listed by exact page number with the inspector's reason.

No hosted or local OCR is invoked. Content shown as extracted came from the local PDF text layer; pages listed as requiring OCR were not claimed as extracted. Use a vision/OCR-capable workflow on only those pages, then keep reading from the returned offset if the bounded response has more extracted content.

## Session read ledger

The extension keeps a session-local in-memory ledger keyed by canonical path, file identity and metadata, and read region. Repeating an unchanged region returns a compact unchanged notice by default (`PI_ROBUST_READ_DEDUP=1`). The ledger is cleared when a Pi session starts.

Two mutation controls are available and are intentionally off by default:

- `PI_ROBUST_READ_ENFORCE_READ_BEFORE_WRITE=1` blocks Pi's standard `write` and `edit` tools for an existing file not read in the current session. New files are allowed.
- `PI_ROBUST_READ_REJECT_STALE_WRITES=1` blocks those tools when the file identity or metadata changed after the last successful read.

Successful standard `write` and `edit` results refresh the ledger. Pi's current extension hooks do not provide a sound, universal wrapper for every third-party mutation tool, so custom tools and shell writes are not intercepted. The implementation does not monkey-patch filesystem APIs and does not persist ledger state across sessions.

## Error categories and limitations

Errors distinguish unsupported format/platform, malformed and encrypted documents, missing native dependencies, resource limits, and likely decompression-risk limits where the converter reports enough information. Native converter availability still depends on the platform artifacts shipped by the exact package versions. Conversion is local and never sends document contents to a hosted service.

The structured source ceiling prevents oversized inputs from reaching a converter, and converted output is bounded. Native converters may still allocate temporary memory proportional to a permitted structured source while parsing it. The incremental text reader, by contrast, stops after it can determine the bounded page and does not allocate in proportion to total file size.

## Provenance

The safe-path, continuation, unchanged-read, and structured-reader guidance was independently adapted for Pi after reviewing [Hermes Agent](https://github.com/NousResearch/hermes-agent) at commit `03da1606bcee38acddaf77028108122170ecfdea`. The native notebook rendering approach and omission model acknowledge [LobeHub PR #17855](https://github.com/lobehub/lobehub/pull/17855), merged as `bedee6b33203ee31b598e8b045e748ca45b88a4e`. Pi integration follows the current [pi-mono read tool and extension APIs](https://github.com/badlogic/pi-mono) reviewed at commit `3dd4623eee136edb2a7a470aa8d4744519a84246`.

PDF conversion uses the MIT-licensed [Firecrawl PDF Inspector](https://github.com/firecrawl/pdf-inspector) package at version 1.12.0; office and other document conversion uses the MIT-licensed [Firecrawl Anydoc](https://github.com/firecrawl/anydoc) package at version 0.1.7. Tests use synthetic fixtures created in this repository and do not copy upstream fixture data.
