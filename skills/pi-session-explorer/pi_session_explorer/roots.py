from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class RootResolutionError(ValueError):
    """Raised when a project root cannot be mapped to a Pi sessions directory."""


@dataclass(frozen=True)
class ResolvedRoot:
    project_root: Path
    session_root: Path
    encoded_session_dir: str


def _normalize_path(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def default_session_root() -> Path:
    """Return the default Pi sessions base path."""
    return Path.home() / ".pi" / "agent" / "sessions"


def _git_repo_root(cwd: Path) -> Path | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return None

    if result.returncode != 0:
        return None

    output = result.stdout.strip()
    if not output:
        return None

    return Path(output).resolve()


def infer_project_root(
    explicit_root: str | Path | None = None,
    cwd: str | Path | None = None,
) -> Path:
    """Infer the project root via explicit root, git root, then cwd fallback."""
    if explicit_root is not None:
        return _normalize_path(explicit_root)

    current_dir = _normalize_path(cwd if cwd is not None else Path.cwd())
    git_root = _git_repo_root(current_dir)
    if git_root is not None:
        return git_root

    return current_dir


def encode_pi_session_dir(project_root: str | Path) -> str:
    """Encode a project root into Pi's sessions directory naming scheme."""
    normalized = _normalize_path(project_root).as_posix()
    encoded_body = normalized.strip("/").replace("/", "-").replace(":", "-")

    if not encoded_body:
        encoded_body = "root"

    return f"--{encoded_body}--"


def derive_pi_session_root(
    project_root: str | Path,
    sessions_root: str | Path | None = None,
) -> Path:
    """Derive the expected Pi sessions directory for a project root."""
    sessions_base = (
        _normalize_path(sessions_root) if sessions_root is not None else default_session_root()
    )
    return (sessions_base / encode_pi_session_dir(project_root)).resolve()


def _looks_like_explicit_session_root(path: Path, sessions_root: Path) -> bool:
    return (
        path.is_dir()
        and path.parent == sessions_root
        and path.name.startswith("--")
        and path.name.endswith("--")
    )


def resolve_target_root(
    explicit_root: str | Path | None = None,
    cwd: str | Path | None = None,
    sessions_root: str | Path | None = None,
) -> ResolvedRoot:
    """Resolve project and session roots for indexing/query commands."""
    sessions_base = (
        _normalize_path(sessions_root) if sessions_root is not None else default_session_root()
    )

    if explicit_root is not None:
        explicit_path = _normalize_path(explicit_root)
        if _looks_like_explicit_session_root(explicit_path, sessions_base):
            return ResolvedRoot(
                project_root=explicit_path,
                session_root=explicit_path,
                encoded_session_dir=explicit_path.name,
            )

    project_root = infer_project_root(explicit_root=explicit_root, cwd=cwd)
    session_root = derive_pi_session_root(project_root, sessions_root=sessions_base)

    if not session_root.is_dir():
        raise RootResolutionError(
            "No Pi sessions directory matched the resolved project root. "
            f"Resolved project root: {project_root}. "
            f"Expected session root: {session_root}. "
            "Please pass --root <project-root> for a project with recorded Pi sessions."
        )

    return ResolvedRoot(
        project_root=project_root,
        session_root=session_root,
        encoded_session_dir=session_root.name,
    )
