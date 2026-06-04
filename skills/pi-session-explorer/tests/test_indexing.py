from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[1]
if str(SKILL_ROOT) not in sys.path:
    sys.path.insert(0, str(SKILL_ROOT))

from pi_session_explorer.cache import derive_cache_paths
from pi_session_explorer.roots import (
    encode_pi_session_dir,
    infer_project_root,
    RootResolutionError,
    resolve_target_root,
)


def test_infer_project_root_prefers_explicit_root(tmp_path: Path) -> None:
    explicit_root = tmp_path / "explicit-project"
    explicit_root.mkdir()

    cwd = tmp_path / "somewhere" / "nested"
    cwd.mkdir(parents=True)

    resolved = infer_project_root(explicit_root=explicit_root, cwd=cwd)

    assert resolved == explicit_root.resolve()


def test_infer_project_root_uses_git_repo_root(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()

    subprocess.run(
        ["git", "init"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )

    nested_cwd = repo_root / "a" / "b"
    nested_cwd.mkdir(parents=True)

    resolved = infer_project_root(cwd=nested_cwd)

    assert resolved == repo_root.resolve()


def test_infer_project_root_falls_back_to_cwd_when_not_git_repo(tmp_path: Path) -> None:
    cwd = tmp_path / "plain-dir"
    cwd.mkdir()

    resolved = infer_project_root(cwd=cwd)

    assert resolved == cwd.resolve()


def test_encode_pi_session_dir_matches_expected_scheme() -> None:
    project_root = Path("/Users/exampleuser/workspace/repos/example-repo")

    encoded = encode_pi_session_dir(project_root)

    assert encoded == "--Users-exampleuser-workspace-repos-example-repo--"


def test_resolve_target_root_encodes_project_root_into_sessions_dir(tmp_path: Path) -> None:
    project_root = tmp_path / "repo"
    project_root.mkdir()

    sessions_root = tmp_path / "sessions"
    encoded_name = encode_pi_session_dir(project_root)
    expected_session_root = sessions_root / encoded_name
    expected_session_root.mkdir(parents=True)

    resolved = resolve_target_root(explicit_root=project_root, sessions_root=sessions_root)

    assert resolved.project_root == project_root.resolve()
    assert resolved.session_root == expected_session_root.resolve()
    assert resolved.encoded_session_dir == encoded_name


def test_resolve_target_root_rejects_empty_encoded_dir_outside_sessions_root(tmp_path: Path) -> None:
    encoded_like_project = tmp_path / "--not-a-session-root--"
    encoded_like_project.mkdir()

    with pytest.raises(RootResolutionError):
        resolve_target_root(explicit_root=encoded_like_project, sessions_root=tmp_path / "sessions")


def test_derive_cache_paths_builds_per_root_duckdb_and_sidecar_paths(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    project_root = Path("/Users/exampleuser/workspace/repos/example-repo")

    cache_paths = derive_cache_paths(project_root=project_root, cache_root=cache_root)

    assert len(cache_paths.root_hash) == 64
    assert cache_paths.duckdb_path == cache_root / f"{cache_paths.root_hash}.duckdb"
    assert cache_paths.metadata_path == cache_root / f"{cache_paths.root_hash}.json"

    same_root_paths = derive_cache_paths(project_root=project_root, cache_root=cache_root)
    assert same_root_paths.root_hash == cache_paths.root_hash

    other_root_paths = derive_cache_paths(
        project_root=Path("/Users/exampleuser/workspace/repos/another"),
        cache_root=cache_root,
    )
    assert other_root_paths.root_hash != cache_paths.root_hash
