from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from .roots import ResolvedRoot


@dataclass(frozen=True)
class CachePaths:
    cache_root: Path
    root_hash: str
    duckdb_path: Path
    metadata_path: Path


def _normalize_path(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def default_cache_root() -> Path:
    """Return the default cache directory for pi-session-explorer."""
    return Path.home() / ".cache" / "pi-session-explorer"


def derive_root_hash(project_root: str | Path) -> str:
    """Return a stable hash for a project root path."""
    normalized = _normalize_path(project_root).as_posix()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def derive_cache_paths(
    project_root: str | Path,
    cache_root: str | Path | None = None,
) -> CachePaths:
    """Derive per-root DuckDB and metadata cache paths."""
    resolved_cache_root = (
        _normalize_path(cache_root) if cache_root is not None else default_cache_root()
    )
    root_hash = derive_root_hash(project_root)

    return CachePaths(
        cache_root=resolved_cache_root,
        root_hash=root_hash,
        duckdb_path=resolved_cache_root / f"{root_hash}.duckdb",
        metadata_path=resolved_cache_root / f"{root_hash}.json",
    )


def cache_status(resolved_root: ResolvedRoot) -> str:
    """Return bootstrap cache status text for the resolved root."""
    cache_paths = derive_cache_paths(project_root=resolved_root.project_root)

    return "\n".join(
        [
            "index status: bootstrap skeleton (not indexed yet)",
            f"project root: {resolved_root.project_root}",
            f"session root: {resolved_root.session_root}",
            f"cache db: {cache_paths.duckdb_path}",
            f"cache metadata: {cache_paths.metadata_path}",
        ]
    )
