"""Context inference (``/context/infer``) + context check (``/context/check``).

V2a implementation of the Context Builder bridge side (V2_CONTEXT_BUILDER_DESIGN
§1). Turns a context-poor ``.c`` (missing external declarations) into a *draft*
``ContextAugmentationSet`` of provisional declarations the reviewer can confirm,
and offers a probe (``/context/check``) that composes the Augmented C and reports
whether it compiles with the current context.

Infer pipeline (design §1):

1. **Missing-symbol detection (deterministic)**: compile-probe the prelude-less
   Original (Preprocessor-processed, line-structure-preserving) and extract the
   missing external symbols with ``_extract_missing_symbols`` (shared with the
   repair path). No compiler present (or the gate is disabled) -> an empty draft
   (current behaviour degrade; documented limitation). Request include paths
   (D-020) are merged before probing, so only symbols still unresolved after the
   project headers are considered. A **two-stage probe** handles missing LOCAL
   headers: when the first probe stops at ``fatal error: "x.h": No such file``
   (a quoted include absent in this single-file context), an empty stub is
   created for each missing local header and the probe re-runs so the include
   passes and the real type/declaration errors surface — otherwise a header-less
   file yields 0 symbols and infer would wrongly degrade to an empty draft
   (``probe_with_stub_fallback``, shared with the repair baseline + check paths).
2. **Usage evidence (deterministic)**: for each symbol, up to 3 occurrence lines
   in the Original (``line`` + ``snippet``), in first-seen order.
3. **Iterative LLM completion (injected backend, up to 5 rounds)**: each round
   sends the whole file + the CURRENT still-missing symbols + usage lines (and,
   from the 2nd round, the prelude generated so far) to the fix-role backend's
   ``generate`` at temperature 0 with a 4096-token budget (see
   ``build_infer_prompt``). Parse is block-unit — one fenced block may resolve
   several symbols (e.g. an ``enum`` of related constants). The new items are
   accumulated and the Augmented C is re-probed (stub-included) to compute the
   next still-missing set. Progress is SET-based: resolving one layer often
   surfaces the NEXT layer's errors (a cascade may GROW the count while
   genuinely progressing), so the loop continues while new items appear and the
   missing set keeps changing, and stops when (a) missing is empty, (b) the set
   is unchanged from the previous round, (c) no item was produced even after
   the retry, or (d) the 5-round cap is reached. A single 1024-token pass under-
   generated on symbol-rich files (zlib-inflate.c: 7+ still-missing); the loop
   converges instead. Provider robustness: when the strict ``### symbol:`` parse
   finds 0 blocks (auto-routed providers vary in format), a lenient fallback
   extracts every declaration-like fenced block (think-tag regions removed), and
   a wholly-empty parse triggers ONE same-prompt retry (provider re-draw) before
   the no-progress guard ends the loop. A backend EXCEPTION (e.g. a provider
   error body without ``choices`` surfacing as ``KeyError``) is mapped to an
   empty response by ``_safe_generate`` and rides that same retry/degrade path:
   run_infer never propagates an LLM failure — the items accumulated so far are
   returned as a normal draft instead of a 500.
4. **Item synthesis**: for each parsed block, classify the declaration's ``kind``
   from its text and build an ``AugmentationItem`` with
   ``provenance=llm_inferred``, ``confirmed=false``, ``generated_text ==
   current_text``, a usage-derived rationale, and usage evidence attributed to
   the first known missing symbol the block declares (empty when it resolves only
   symbols not enumerated). Blocks the model did not produce get NO item, and a
   re-emitted duplicate declaration yields no second item (never fabricated).
5. **Response**: a ``status=draft`` / ``context_revision_id=null`` set of all
   accumulated items. ``prelude_line_count`` is computed by the shared compose
   rule; the residual-missing / compiles state is observable via /context/check.

Check pipeline (design §1): compose Augmented C from the supplied set + Original
and compile-probe it (include paths merged). Returns ``{compiles, missing_symbols}``.

Dependency injection: the LLM ``backend`` (``generate``) and the compilers
(availability probe + whole-file compile runner) are injectable, so unit tests
run with a fake backend + fake compile and never call an LLM or real gcc.

Security: source content is never logged; only the content hash (short) and
counts / line numbers appear in diagnostics.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from typing import List, Optional, Sequence

from repair_api import compose, usage_tracker
from repair_api.adapter.repair import (
    BaselineCompileRunner,
    CompileProbe,
    CompileRunner,
    _is_expected_backend_failure,
    _merge_compile_config,
    default_baseline_compile_runner,
    default_compile_runner,
    probe_with_stub_fallback,
)

logger = logging.getLogger("repair_api.infer")

# Cap on usage-evidence occurrences collected per symbol (design §1-2).
_MAX_USAGE_EVIDENCE = 3

# Cap on distinct missing symbols an infer pass will complete. Bounds the prompt
# size / token cost for pathological inputs; extra symbols surface via
# ``/context/check`` (still-missing) after a first confirm.
_MAX_SYMBOLS = 24

# Iterative-convergence bounds (task §1). A single 1024-token LLM pass produced
# too few declarations for a symbol-rich file (zlib-inflate.c: 7+ still-missing
# after one round). Instead we run up to ``_MAX_INFER_ROUNDS`` rounds, each
# re-probing (stub-included) to compute the NEW missing symbols and asking the
# model to complete only those, with a wider ``_INFER_MAX_TOKENS`` budget so a
# single round is not truncated. Progress is judged SET-based, not count-based:
# resolving one layer often CASCADES — gcc reports the next layer's errors only
# once the current layer compiles, so zlib-inflate.c goes 2 missing -> 7+
# missing while genuinely progressing, and a "count did not shrink" test would
# misread that as a stall. The loop ends when missing goes empty, the missing
# set is unchanged from the previous round, or no item was produced (even after
# the retry). 5 rounds covers the observed cascade depth; with at most 2 LLM
# calls per round (one same-prompt retry on an empty parse) the hard ceiling is
# 10 calls per infer.
_MAX_INFER_ROUNDS = 5

# Per-round completion budget. 1024 truncated symbol-rich completions (only ~2
# items emitted); 4096 gives room for the full missing-symbol set plus the
# enum/typedef declarations that resolve several symbols at once.
_INFER_MAX_TOKENS = 4096


# --- backend protocol (structural) ------------------------------------------


class _BackendLike:  # pragma: no cover - structural doc only
    """What infer needs from a backend: ``generate(prompt, max_tokens, temperature)``."""

    def generate(self, prompt: str, *, max_tokens: int = ..., temperature: float = ...) -> str: ...


def _short_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]


# --- usage evidence ---------------------------------------------------------


def _identifier_occurrences(original_content: str, symbol: str) -> List[dict]:
    """Up to ``_MAX_USAGE_EVIDENCE`` word-boundary occurrences of ``symbol``.

    Returns ``[{"line": n, "snippet": s}]`` for the first lines (1-indexed) in
    which ``symbol`` appears as a whole identifier, deterministic (source order).
    The snippet is the raw source line, trimmed of trailing whitespace so the
    contract value is stable regardless of line endings inside the file.
    """
    pattern = re.compile(r"\b" + re.escape(symbol) + r"\b")
    out: List[dict] = []
    for idx, line in enumerate(original_content.split("\n"), start=1):
        if pattern.search(line):
            out.append({"line": idx, "snippet": line.rstrip()})
            if len(out) >= _MAX_USAGE_EVIDENCE:
                break
    return out


# --- kind classification ----------------------------------------------------

# A leading ``typedef``/``struct``/``union``/``enum`` keyword => an inferred type.
_TYPE_KEYWORDS = ("typedef", "struct", "union", "enum")


def classify_kind(declaration_text: str) -> str:
    """Classify a declaration's contract ``kind`` (design §1-4).

    Rules, in order:
    - starts with ``#define`` (a macro line) -> ``inferred_macro``
    - the first token is ``typedef``/``struct``/``union``/``enum`` -> ``inferred_type``
    - otherwise contains ``(`` (a prototype's parameter list) ->
      ``external_function_declaration``
    - otherwise -> ``external_global``

    The macro and type checks come first so a ``#define`` that contains ``(`` (a
    function-like macro) is still classified as a macro, and a
    ``typedef ... (*fp)(...)`` still classifies as a type.
    """
    text = declaration_text.strip()
    # A macro may be preceded by whitespace only; check the first non-blank line.
    first_code_line = next((ln.strip() for ln in text.split("\n") if ln.strip()), "")
    if first_code_line.startswith("#define") or first_code_line.startswith("# define"):
        return "inferred_macro"

    first_token_match = re.match(r"[A-Za-z_]\w*", first_code_line)
    first_token = first_token_match.group(0) if first_token_match else ""
    if first_token in _TYPE_KEYWORDS:
        return "inferred_type"

    if "(" in text:
        return "external_function_declaration"
    return "external_global"


# --- LLM prompt / parse -----------------------------------------------------

# The model is asked to emit one labelled fenced block per DECLARATION:
#
#   ### symbol: <name>
#   ```c
#   <one minimal C declaration>
#   ```
#
# The label line names the primary symbol the block addresses; the fence
# delimits the exact declaration text. Parse is **block-unit**, not name-keyed
# 1:1 (task §1): one block may resolve several requested symbols (e.g. an
# ``enum { HEAD, SYNC, ... };`` declaration or a ``typedef`` naming multiple
# members), so the label is used only for usage-evidence attribution — a block
# is NOT dropped merely because its label symbol was not in the requested set.
_INFER_BLOCK_RE = re.compile(
    r"^[ \t]*#{1,6}[ \t]*symbol[ \t]*:[ \t]*(?P<name>[A-Za-z_]\w*)[ \t]*$"
    r".*?```[a-zA-Z]*\n(?P<body>.*?)\n?```",
    re.DOTALL | re.MULTILINE,
)


def build_infer_prompt(
    filename: str,
    original_content: str,
    symbols: Sequence[str],
    evidence_by_symbol: dict,
    prior_prelude: str = "",
) -> str:
    """Build the infer prompt (design §1-3, iterative task §1).

    Requests fenced ``c`` blocks that together declare the still-missing
    external symbols, each preceded by a ``### symbol: <name>`` label line.
    Parse is block-unit (a block may resolve several symbols at once), so the
    prompt permits grouping — an ``enum``/``typedef`` for a family of related
    constants, a ``#define`` for a macro. When ``prior_prelude`` is non-empty
    (a later convergence round) it is shown so the model completes ONLY the
    remaining symbols and stays consistent with what it already generated.
    """
    lines: List[str] = []
    lines.append(
        "You are completing the missing EXTERNAL declarations for a single C "
        "translation unit so that it can compile in isolation. You are NOT "
        "fixing bugs and you MUST NOT modify the source."
    )
    lines.append("")
    lines.append(f"Source file: {filename}")
    lines.append("```c")
    lines.append(original_content.rstrip("\n"))
    lines.append("```")
    lines.append("")
    if prior_prelude.strip():
        lines.append(
            "You have ALREADY generated the declarations below in a previous "
            "round. Do NOT repeat them; complete only the STILL-MISSING symbols "
            "listed after, and keep your new declarations consistent with these "
            "(same type names, no conflicting redefinition):"
        )
        lines.append("```c")
        lines.append(prior_prelude.rstrip("\n"))
        lines.append("```")
        lines.append("")
        intro = "The following symbols are STILL used but not declared"
    else:
        intro = "The following symbols are used but not declared"
    lines.append(
        f"{intro} in this file. Provide minimal C declarations that make them "
        "resolve, consistent with how each is used below:"
    )
    lines.append(
        "- a typedef/struct/union for a type, an `extern` declaration for a "
        "global, a function prototype for a function, a `#define` for a macro."
    )
    lines.append(
        "- symbols that look like enum constants (ALL-CAPS names, used as "
        "`case` labels or compared with `==`) may be declared TOGETHER in one "
        "`enum { ... };` (or `typedef enum { ... } Name;`) block rather than as "
        "separate globals — group related constants into a single declaration."
    )
    lines.append("")
    for sym in symbols:
        lines.append(f"- {sym}")
        for ev in evidence_by_symbol.get(sym, []):
            lines.append(f"    used at line {ev['line']}: {ev['snippet'].strip()}")
    lines.append("")
    lines.append(
        "Respond with one fenced block per declaration, in exactly this format "
        "(no prose outside the blocks). One block may declare several of the "
        "symbols above (e.g. an enum); label it with any one of them:"
    )
    lines.append("")
    lines.append("### symbol: <name>")
    lines.append("```c")
    lines.append("<one minimal C declaration>")
    lines.append("```")
    lines.append("")
    lines.append(
        "Only include a block for declarations you are confident about. Do not "
        "restate the source. Do not add commentary."
    )
    return "\n".join(lines)


def _strict_parse_blocks(output: str) -> List[dict]:
    """Strict parse: ``### symbol: <name>`` + fenced blocks, in order.

    Block-unit (task §1): each labelled fenced block becomes one entry
    ``{"label": <name>, "declaration": <text>}`` in first-seen order — the parse
    does NOT require a 1:1 label↔requested-symbol correspondence, so a single
    ``enum { ... };`` block that resolves several requested symbols is one item.
    The label is retained only for usage-evidence attribution (it names the
    primary symbol the block addresses); a block is not dropped merely because
    its label was not in the requested set. Wholly-blank fence bodies are
    dropped (no item is fabricated), and exact-duplicate declaration texts are
    de-duplicated (first wins) so a repeated block never yields two items.
    """
    out: List[dict] = []
    seen_declarations: set = set()
    for match in _INFER_BLOCK_RE.finditer(output or ""):
        body = match.group("body").strip("\n")
        if not body.strip():
            continue
        if body in seen_declarations:
            continue
        seen_declarations.add(body)
        out.append({"label": match.group("name"), "declaration": body})
    return out


# --- fallback parse (provider format variance) -------------------------------
#
# Free-model auto-routing serves the same prompt to different providers, and not
# all of them honour the ``### symbol:`` label format: some prepend prose, some
# emit ``<think>...</think>`` reasoning, some return bare fenced blocks. The
# strict parse then finds 0 blocks and infer looks like "the model produced
# nothing" even though usable declarations are present (observed live: items
# oscillating 0 <-> 2 on identical input). When the strict parse is empty, the
# fallback extracts EVERY fenced code block (after removing think regions; prose
# outside fences is ignored by construction) and keeps the declaration-like ones.

_THINK_TAG_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)

# Any fenced block, with or without a language tag. The strict format's fences
# match too — which is the point: a response whose label lines are malformed but
# whose fences are fine still yields its declarations.
_ANY_FENCED_BLOCK_RE = re.compile(r"```[a-zA-Z]*[ \t]*\n(?P<body>.*?)\n?```", re.DOTALL)

_IDENTIFIER_RE = re.compile(r"[A-Za-z_]\w*")


def _looks_like_declaration(body: str) -> bool:
    """Whether a fenced body plausibly contains C declarations.

    A declaration carries a ``;`` (typedef / extern / prototype / enum) or is a
    ``#define`` line; a fenced block with neither is prose / pseudo-code and is
    discarded (an item is never fabricated from it).
    """
    return ";" in body or "#define" in body or "# define" in body


def _fallback_parse_blocks(output: str) -> List[dict]:
    """Lenient parse: every declaration-like fenced block, labels optional.

    Applied only when the strict parse found 0 blocks (provider format
    variance). ``<think>...</think>`` regions are removed first so a reasoning
    trace's draft fences are not mistaken for the answer; leading / interleaved
    prose is ignored because only fenced bodies are extracted. Each surviving
    block's ``label`` is the first identifier in its body (evidence attribution
    prefers the known missing symbols found in the text anyway, see
    ``_block_attribution``). Blank / non-declaration bodies are dropped and
    duplicate declaration texts are de-duplicated, as in the strict parse.
    """
    cleaned = _THINK_TAG_RE.sub("", output or "")
    out: List[dict] = []
    seen_declarations: set = set()
    for match in _ANY_FENCED_BLOCK_RE.finditer(cleaned):
        body = match.group("body").strip("\n")
        if not body.strip() or not _looks_like_declaration(body):
            continue
        if body in seen_declarations:
            continue
        seen_declarations.add(body)
        ident = _IDENTIFIER_RE.search(body)
        out.append({"label": ident.group(0) if ident else None, "declaration": body})
    return out


def _parse_with_fallback(output: str) -> tuple[List[dict], int, int]:
    """Strict parse, falling back to lenient fence extraction when it finds 0.

    Returns ``(blocks, strict_count, fallback_count)`` so the caller can log
    which path produced the blocks (counts only; response text is never logged).
    ``fallback_count`` is 0 when the strict parse succeeded (fallback not run).
    """
    strict = _strict_parse_blocks(output)
    if strict:
        return strict, len(strict), 0
    fallback = _fallback_parse_blocks(output)
    return fallback, 0, len(fallback)


def _finish_marker() -> str:
    """This thread's most recent LLM ``finish_reason``, or ``"unknown"``.

    Read from the usage_tracker's thread-local recorder (populated by the httpx
    send-wrap for real OpenRouter calls). Test fakes never touch the recorder —
    ``_safe_generate`` resets it before each call, so a fake (or a failed call)
    reads back ``None`` -> ``"unknown"``, never a stale value. Defensive: any
    recorder failure also yields ``"unknown"`` (diagnostics must never break a
    request).
    """
    try:
        reason = usage_tracker.last_finish_reason()
    except Exception:  # noqa: BLE001 — diagnostics only
        return "unknown"
    return reason if isinstance(reason, str) and reason else "unknown"


# NOTE: the provider/transport failure classifier (`_is_expected_backend_failure`)
# is shared with the repair path and lives in ``repair_api.adapter.repair``
# (imported above) — that module cannot import this one (it is our dependency),
# so the shared definition sits on the adapter side.


def _safe_generate(backend: _BackendLike, prompt: str) -> tuple[str, Optional[str], str]:
    """Call ``backend.generate``, mapping any ``Exception`` to an empty response.

    Free-pool providers sometimes return an error body without ``choices``,
    which certfix's backend surfaces as an exception (observed live on
    zlib-deflate.c: ``KeyError('choices')`` -> an uncaught 500 from
    ``/context/infer``). The infer loop already degrades gracefully on an EMPTY
    response — same-prompt retry, then the no-progress guard ends the round —
    so a backend/provider exception is folded onto that exact path instead of
    propagating: the caller keeps every item accumulated in earlier rounds and
    the endpoint returns a normal draft, never a 500 (a mid-loop 500 would
    discard the accumulated rounds, the worse trade for an interactive flow).

    Exception classification (Codex review): KNOWN provider/transport failures
    (``_is_expected_backend_failure``) log the exception TYPE at INFO with the
    message/traceback at DEBUG only — a provider error body can echo request
    content, which must never reach INFO logs. Any OTHER exception is likely an
    internal bug: it still degrades (same return), but logs at WARNING WITH the
    traceback so it cannot pass silently as an ordinary empty generation.
    ``BaseException``s — notably ``cancellation.RequestCancelled`` — are NOT
    caught and propagate (client-disconnect abort must win).

    Returns ``(output, error_kind, finish)``: ``error_kind`` is the exception
    class name (``None`` on success); ``finish`` is the completion's
    ``finish_reason`` (``stop`` / ``length`` / ... / ``unknown``) read from the
    usage_tracker's thread-local recorder, reset before the call — ``length``
    makes a truncated CoT-in-content response (0 parsed blocks despite a long
    body) visible in the round diagnostics.
    """
    try:
        usage_tracker.reset_finish_reason()
    except Exception:  # noqa: BLE001 — diagnostics only, never break the call
        pass
    try:
        output = backend.generate(prompt, max_tokens=_INFER_MAX_TOKENS, temperature=0.0)
        return output, None, _finish_marker()
    except Exception as exc:  # noqa: BLE001 — degrade either way; loudness differs
        if _is_expected_backend_failure(exc):
            logger.info("infer: backend generate failed kind=%s", type(exc).__name__)
            logger.debug("infer: backend generate failure detail", exc_info=True)
        else:
            logger.warning(
                "infer: backend generate failed UNEXPECTEDLY kind=%s (possible bug)",
                type(exc).__name__,
                exc_info=True,
            )
        return "", type(exc).__name__, _finish_marker()


def parse_infer_response(output: str) -> List[dict]:
    """Parse an infer response into an ordered block list (strict, then fallback).

    Primary: the strict ``### symbol: <name>`` labelled-fence format
    (``_strict_parse_blocks``). When that yields 0 blocks — auto-routed
    providers do not all honour the label format — the lenient fallback
    (``_fallback_parse_blocks``) extracts every declaration-like fenced block
    instead. Each entry is ``{"label": <name-or-None>, "declaration": <text>}``.
    """
    return _parse_with_fallback(output)[0]


# --- item synthesis ---------------------------------------------------------


@dataclass(frozen=True)
class InferResult:
    """The pieces the endpoint needs to build a ContextAugmentationSet dict.

    ``missing_symbols`` is the accumulated UNION of every missing symbol
    observed across ALL convergence rounds (the first probe plus each
    re-probe), in first-seen order — NOT the final residual set. The residual
    (what the context still fails to declare) is observable via
    ``/context/check``. The endpoint does not currently serialize this field;
    it exists for tests and diagnostics.
    """

    items: List[dict]
    prelude_line_count: int
    missing_symbols: List[str]


def _rationale(symbol: Optional[str], evidence: Sequence[dict]) -> str:
    """Usage-derived rationale (design §1-4: "inferred from usage at line N").

    ``symbol`` is the block's attribution symbol (the first missing symbol the
    declaration resolves, or ``None`` when the block resolves no *known* missing
    symbol by name — e.g. an enum whose members were themselves the missing
    symbols but whose evidence collection found nothing). The rationale names it
    when available, else states a provisional declaration was inferred.
    """
    subject = f"'{symbol}'" if symbol else "This symbol"
    if evidence:
        lines_txt = ", ".join(str(ev["line"]) for ev in evidence)
        plural = "s" if len(evidence) > 1 else ""
        return (
            f"{subject} is used but not declared in this file; a provisional "
            f"declaration was inferred from usage at line{plural} {lines_txt}."
        )
    return (
        f"{subject} is used but not declared in this file; a provisional "
        "declaration was inferred from its usage."
    )


def _block_attribution(
    declaration: str,
    label: Optional[str],
    known_symbols: Sequence[str],
    evidence_by_symbol: dict,
) -> tuple[Optional[str], List[dict]]:
    """Pick the (symbol, usage_evidence) a block is attributed to (task §1).

    A block may resolve several symbols; usage evidence is attributed to the
    FIRST known missing symbol (in ``known_symbols`` detection order) that
    appears as a whole identifier in the declaration text — this keeps the
    evidence deterministic and tied to a symbol the block actually declares. If
    none of the known missing symbols appears in the text, fall back to the
    block's ``label`` (when it is itself a known missing symbol). When neither
    yields a match, evidence is the empty list (parse-relaxation §1: a block
    resolving only names we did not enumerate is still a valid item).
    """
    for sym in known_symbols:
        if re.search(r"\b" + re.escape(sym) + r"\b", declaration):
            return sym, list(evidence_by_symbol.get(sym, []))
    if label in evidence_by_symbol:
        return label, list(evidence_by_symbol.get(label, []))
    return None, []


def _build_items(
    blocks: Sequence[dict],
    known_symbols: Sequence[str],
    evidence_by_symbol: dict,
    existing_ids: Optional[set] = None,
) -> List[dict]:
    """Build contract AugmentationItem dicts, one per parsed block (task §1).

    Parse is block-unit, so each entry of ``blocks`` (``{"label", "declaration"}``)
    yields one item; a single block that resolves several symbols is one item.
    Item ids are derived from the declaration text so the same declaration yields
    the same id across rounds, and ``existing_ids`` (the ids already accumulated)
    suppresses a re-emitted duplicate declaration from producing a second item.
    ``generated_text == current_text`` and ``confirmed == False`` at draft time
    (design §1-4). usage_evidence is attributed per ``_block_attribution``.
    """
    seen = set(existing_ids or set())
    items: List[dict] = []
    for block in blocks:
        declaration = block["declaration"]
        item_id = "aug-" + hashlib.sha256(declaration.encode("utf-8")).hexdigest()[:10]
        if item_id in seen:
            continue
        seen.add(item_id)
        symbol, evidence = _block_attribution(
            declaration, block.get("label"), known_symbols, evidence_by_symbol
        )
        items.append(
            {
                "item_id": item_id,
                "kind": classify_kind(declaration),
                "generated_text": declaration,
                "current_text": declaration,
                "provenance": "llm_inferred",
                "user_edited": False,
                "confirmed": False,
                "rationale": _rationale(symbol, evidence),
                "usage_evidence": [
                    {"line": ev["line"], "snippet": ev["snippet"]} for ev in evidence
                ],
            }
        )
    return items


# --- public entry points ----------------------------------------------------


def run_infer(
    *,
    backend: Optional[_BackendLike],
    compile_config: object,
    original_content: str,
    filename: str,
    compile_enabled: bool,
    compile_include_paths: Optional[Sequence[str]] = None,
    compile_runner: Optional[CompileRunner] = None,
    baseline_compile_runner: Optional[BaselineCompileRunner] = None,
) -> InferResult:
    """Run the infer pipeline and return the pieces for a draft set.

    Args:
        backend: Injected fix-role backend (``generate``). May be ``None`` in the
            degrade paths (no compiler / no missing symbols) where the LLM is
            never consulted; a non-None backend is required only when there are
            symbols to complete.
        compile_config: The effective certfix ``CompileValidationConfig`` (its
            ``command`` is probed; ``include_paths`` is merged with the request's).
        original_content / filename: The Original C source + its display name.
        compile_enabled: Whether the compile gate is enabled in config. When
            False, no probe runs and an empty draft is returned (degrade).
        compile_include_paths: Optional extra ``-I`` paths (D-020), merged before
            probing so project-header symbols are resolved and excluded.
        compile_runner: Injectable compiler-availability probe (defaults to PATH
            probe). Unavailable -> empty draft (degrade to current behaviour).
        baseline_compile_runner: Injectable whole-file compiler (defaults to
            certfix's compile gate) used to compile the prelude-less Original and
            read its stderr for missing symbols.

    Returns:
        An ``InferResult`` (items, prelude_line_count, missing_symbols).
    """
    from certfix.core.preprocessor import Preprocessor

    compile_runner = compile_runner or default_compile_runner
    baseline_compile_runner = baseline_compile_runner or default_baseline_compile_runner
    src_hash_short = _short_hash(original_content)

    empty = InferResult(
        items=[], prelude_line_count=compose.synthesized_prelude_line_count([]), missing_symbols=[]
    )

    # 1. Missing-symbol detection. No compiler / gate disabled -> empty draft
    #    (degrade to the current placeholder behaviour; documented limitation).
    if not compile_enabled:
        logger.info("infer: compile gate disabled -> empty draft src=%s", src_hash_short)
        return empty
    probe: CompileProbe = compile_runner(getattr(compile_config, "command", "gcc"))
    if not probe.available:
        logger.info("infer: no compiler -> empty draft src=%s", src_hash_short)
        return empty

    merged_config = _merge_compile_config(compile_config, list(compile_include_paths or []))

    # Compile the prelude-less Original, preprocessed (line-structure-preserving),
    # matching the repair path's baseline probe input. Two-stage probe: when the
    # first probe stops at a missing LOCAL header (``#include "x.h"`` absent in a
    # single-file context), an empty stub is created for each and the probe re-runs
    # so the include passes and the real type/declaration errors surface — without
    # this, a header-less file yields 0 symbols and infer degrades to an empty
    # draft even though the body clearly uses external declarations.
    processed, _mapping, _ignored = Preprocessor(keep_comments=False).process(original_content)
    probe_result = probe_with_stub_fallback(
        processed=processed,
        source=original_content,
        compile_config=merged_config,
        baseline_compile_runner=baseline_compile_runner,
    )
    if probe_result.outcome.ok:
        # Already self-contained (or resolved by include paths / stubs) -> nothing
        # to infer.
        logger.info("infer: original compiles as-is -> empty draft src=%s", src_hash_short)
        return empty

    missing = probe_result.missing_symbols
    if not missing:
        logger.info(
            "infer: baseline failed but no symbols extracted -> empty draft src=%s stubbed=%d",
            src_hash_short,
            len(probe_result.stubbed_headers),
        )
        return empty
    missing = missing[:_MAX_SYMBOLS]
    all_missing = list(missing)  # every symbol ever detected, for the response

    # 2. No backend -> degrade to an item-less draft but still report the
    #    (first-round) missing symbols so the caller can surface them.
    if backend is None:
        logger.info(
            "infer: %d missing symbols but no backend -> empty draft src=%s",
            len(missing),
            src_hash_short,
        )
        return InferResult(
            items=[],
            prelude_line_count=compose.synthesized_prelude_line_count([]),
            missing_symbols=missing,
        )

    def _reprobe_missing(items_so_far: Sequence[dict]) -> List[str]:
        """Compose the Augmented C from the items so far, probe (stub-included),
        and return the still-missing external symbols (capped)."""
        augmented = compose.compose_augmented_c(items_so_far, original_content)
        aug_processed, _m, _i = Preprocessor(keep_comments=False).process(augmented)
        aug_probe = probe_with_stub_fallback(
            processed=aug_processed,
            source=augmented,
            compile_config=merged_config,
            baseline_compile_runner=baseline_compile_runner,
        )
        if aug_probe.outcome.ok:
            return []
        return aug_probe.missing_symbols[:_MAX_SYMBOLS]

    # 3. Iterative convergence (task §1). Each round completes the CURRENT
    #    still-missing symbols (wider max_tokens), accumulates items, re-probes
    #    the Augmented C to compute the next missing set, and stops when missing
    #    is empty, stops shrinking, or the round cap is reached.
    items: List[dict] = []
    item_ids: set = set()
    round_no = 0
    while missing and round_no < _MAX_INFER_ROUNDS:
        round_no += 1
        # Usage evidence for the symbols still missing this round (source order).
        evidence_by_symbol = {
            sym: _identifier_occurrences(original_content, sym) for sym in missing
        }
        prior_prelude = compose.synthesize_prelude(items) if items else ""
        prompt = build_infer_prompt(
            filename, original_content, missing, evidence_by_symbol, prior_prelude
        )
        output, gen_error, finish = _safe_generate(backend, prompt)
        blocks, strict_n, fallback_n = _parse_with_fallback(output)
        logger.info(
            "infer: src=%s round=%d retry=False response_chars=%d "
            "strict_blocks=%d fallback_blocks=%d error=%d finish=%s",
            src_hash_short,
            round_no,
            len(output or ""),
            strict_n,
            fallback_n,
            1 if gen_error else 0,
            finish,
        )
        if not blocks:
            # Empty parse (or a backend/provider exception mapped to an empty
            # response by _safe_generate) with work still to do: one same-prompt
            # retry. Under free-model auto-routing the retry may be served by a
            # different provider whose response format parses (or that does not
            # error); if it is empty/raises again the round yields no items and
            # the no-progress guard below ends the loop — the items accumulated
            # in earlier rounds are still returned normally (never a 500).
            output, gen_error, finish = _safe_generate(backend, prompt)
            blocks, strict_n, fallback_n = _parse_with_fallback(output)
            logger.info(
                "infer: src=%s round=%d retry=True response_chars=%d "
                "strict_blocks=%d fallback_blocks=%d error=%d finish=%s",
                src_hash_short,
                round_no,
                len(output or ""),
                strict_n,
                fallback_n,
                1 if gen_error else 0,
                finish,
            )
        new_items = _build_items(blocks, missing, evidence_by_symbol, existing_ids=item_ids)
        items.extend(new_items)
        item_ids.update(it["item_id"] for it in new_items)

        next_missing = _reprobe_missing(items)
        logger.info(
            "infer: src=%s round=%d in_missing=%d new_items=%d out_missing=%d",
            src_hash_short,
            round_no,
            len(missing),
            len(new_items),
            len(next_missing),
        )
        for sym in next_missing:
            if sym not in all_missing:
                all_missing.append(sym)

        # Stop when nothing is left, when the round produced no item (even
        # after the retry), or when the missing SET is unchanged — another
        # round would repeat the same request. Progress is deliberately
        # set-based, NOT count-based: resolving the current layer often
        # surfaces the next layer's errors (gcc reports them only once the
        # first layer compiles), so next_missing may be LARGER than missing
        # while the loop is genuinely progressing (zlib-inflate.c: 2 -> 7+).
        if not next_missing:
            missing = []
            break
        if not new_items or set(next_missing) == set(missing):
            missing = next_missing
            break
        missing = next_missing

    logger.info(
        "infer: src=%s rounds=%d total_items=%d residual_missing=%d",
        src_hash_short,
        round_no,
        len(items),
        len(missing),
    )

    # 4. prelude_line_count from the compose rule (marker/note + item text).
    prelude_line_count = compose.synthesized_prelude_line_count(items)
    return InferResult(
        items=items, prelude_line_count=prelude_line_count, missing_symbols=all_missing
    )


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a ``/context/check`` probe."""

    compiles: bool
    missing_symbols: List[str]
    # Local headers a stub was created for during the two-stage probe (empty when
    # the Augmented C got past its includes without stubbing). Surfaced so the
    # Review UI can say "these project headers were stubbed to make the check
    # meaningful" — the still-missing symbols are then the ones the prelude must
    # still declare.
    stubbed_headers: List[str] = field(default_factory=list)


def run_check(
    *,
    compile_config: object,
    original_content: str,
    items: Sequence[object],
    compile_enabled: bool,
    compile_include_paths: Optional[Sequence[str]] = None,
    compile_runner: Optional[CompileRunner] = None,
    baseline_compile_runner: Optional[BaselineCompileRunner] = None,
) -> CheckResult:
    """Compile-probe the Augmented C and report ``compiles`` + ``missing_symbols``.

    Composes ``Augmented C = prelude(items) + Original`` (byte-unchanged) and
    compiles the preprocessed whole text (line-structure-preserving strip). When
    no compiler is present or the gate is disabled, ``compiles`` is ``False`` and
    ``missing_symbols`` is empty (the caller surfaces "compile skipped" in the UI).

    Two-stage probe (same as ``run_infer``): a missing LOCAL header would stop the
    Augmented-C compile at the include stage before the prelude's declarations
    could be checked, so any such header is stubbed and the probe re-runs. The
    stubbed header names are reported in ``stubbed_headers`` so the UI can explain
    that the still-missing symbols are what the context must additionally declare.

    Args mirror ``run_infer``'s compile arguments.
    """
    from certfix.core.preprocessor import Preprocessor

    compile_runner = compile_runner or default_compile_runner
    baseline_compile_runner = baseline_compile_runner or default_baseline_compile_runner
    src_hash_short = _short_hash(original_content)

    if not compile_enabled:
        logger.info("check: compile gate disabled src=%s", src_hash_short)
        return CheckResult(compiles=False, missing_symbols=[])
    probe: CompileProbe = compile_runner(getattr(compile_config, "command", "gcc"))
    if not probe.available:
        logger.info("check: no compiler src=%s", src_hash_short)
        return CheckResult(compiles=False, missing_symbols=[])

    merged_config = _merge_compile_config(compile_config, list(compile_include_paths or []))
    augmented = compose.compose_augmented_c(items, original_content)
    processed, _mapping, _ignored = Preprocessor(keep_comments=False).process(augmented)
    probe_result = probe_with_stub_fallback(
        processed=processed,
        source=augmented,
        compile_config=merged_config,
        baseline_compile_runner=baseline_compile_runner,
    )
    if probe_result.outcome.ok:
        return CheckResult(
            compiles=True, missing_symbols=[], stubbed_headers=probe_result.stubbed_headers
        )
    missing = probe_result.missing_symbols
    logger.info(
        "check: src=%s compiles=False missing=%d stubbed=%d",
        src_hash_short,
        len(missing),
        len(probe_result.stubbed_headers),
    )
    return CheckResult(
        compiles=False,
        missing_symbols=missing,
        stubbed_headers=probe_result.stubbed_headers,
    )
