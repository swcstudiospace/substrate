"""Hermes pending-skill bridge: staged skill_manage writes become library PRs (D-10).

With ``skills.write_approval`` on, Hermes stages every skill_manage call as
``~/.hermes/pending/skills/<8hex>.json`` (tools/write_approval.py) instead of writing it. Each tick
this module:

1. loads the skills records (never ``pending/memory``: memory writes stay the owner's),
2. groups them by skill name and waits until the newest record of a group is QUIET_S old
   (Hermes stages create + several write_file calls for one skill, Pitfall 3),
3. proposes only (a) a library skill, replayed in created_at order onto its library copy, and
   (b) a brand-new name whose first record is a foreground create (the miner's and /learn's
   output); every other group is held for the owner's ``/skills pending`` with one logged reason
   per record (Hermes' own local skills, deletes, background-review creates, replays that do not
   apply) — never deleted, never proposed (checker W3),
4. sends only the files that differ from the library copy plus SKILL.md, and a ``remove`` list
   (checker W2), to POST /skills/propose with the host propose key (checker W4),
5. unlinks the group's records only on a final reply (200 opened/existing/unchanged/declined, or
   400) and logs {ts, name, ids, status, pr_url}; 413 or an over-cap body is held as oversize;
   401, 5xx and transport errors keep everything for the next tick.

A held library-skill record is resolved by a propose PR or a rejection, never by ``/skills
approve``: approve replays the write past the gate into external_dirs, i.e. the live checkout
/root/agent-skills (D-04, checker W11). Every held line says so.

The same client also drains the Omp and Grok queued-proposal directories (04-03's contract: a
file holding exactly the propose body, written when the substrate was unreachable).
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

PENDING_SKILLS = Path("/root/.hermes/pending/skills")
HERMES_SKILLS = Path("/root/.hermes/skills")
LIBRARY = Path("/root/agent-skills")
BRIDGE_LOG = Path("/var/lib/substrate/miner/bridge-log.jsonl")
HELD_STATE = Path("/var/lib/substrate/miner/bridge-held.json")
PROPOSE_KEY_FILE = Path(os.environ.get("SUBSTRATE_PROPOSE_KEY_FILE") or "/var/lib/substrate/skills/propose.key")
PROPOSE_KEY_HEADER = "x-substrate-propose-key"
SUBSTRATE_URL = os.environ.get("SUBSTRATE_URL") or "http://127.0.0.1:7410"
ROUTE_MAX_BYTES = 1_000_000
QUIET_S = 120
ALLOWED_PREFIXES = ("references/", "templates/", "scripts/", "assets/")
OMP_QUEUE = Path("/root/.omp/agent/substrate-pending")
GROK_QUEUE = Path("/root/.grok/plugin-data/skill-autonomy/pending")

SURFACE = "hermes"
# Same literal as SKILL_NAME_RE in packages/mcp-server/src/skills/propose.ts.
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
FINAL_STATUSES = frozenset({"opened", "existing", "unchanged", "declined"})
OVERSIZE = "oversize"
HERMES_LOCAL = "hermes-local"


class Skip(Exception):
    """A group that cannot be proposed as staged; its records are held with this reason."""


class BridgeError(RuntimeError):
    """The propose request did not produce a reply (transport error)."""


class KeyUnreadable(BridgeError):
    """The host propose key file is missing, unreadable or empty."""


@dataclass(frozen=True)
class Record:
    id: str
    action: str
    origin: str
    created_at: float
    summary: str
    payload: dict[str, Any]
    path: Path


@dataclass
class RunResult:
    ok: bool = True
    proposed: int = 0
    rejected: int = 0
    held: int = 0
    kept: int = 0
    waiting: int = 0


# --- records ----------------------------------------------------------------------------------


def _under_pending_memory(directory: Path) -> bool:
    parts = directory.absolute().parts
    return any(a == "pending" and b == "memory" for a, b in zip(parts, parts[1:]))


def load_pending(directory: Path | str = PENDING_SKILLS) -> list[Record]:
    """Every readable ``subsystem: skills`` record in ``directory``; never reads pending/memory."""
    root = Path(directory)
    if _under_pending_memory(root) or not root.is_dir():
        return []
    records: list[Record] = []
    for path in sorted(root.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or data.get("subsystem") != "skills":
            continue
        payload = data.get("payload")
        if not isinstance(payload, dict):
            continue
        created = data.get("created_at")
        records.append(Record(
            id=str(data.get("id") or path.stem),
            action=str(data.get("action") or payload.get("action") or ""),
            origin=str(data.get("origin") or "foreground"),
            created_at=float(created) if isinstance(created, (int, float)) else 0.0,
            summary=str(data.get("summary") or ""),
            payload=payload,
            path=path,
        ))
    return records


def _norm(name: Any) -> str:
    """skill_manage accepts ``category/name`` for every action but create; the skill is the last part."""
    return name.rsplit("/", 1)[-1] if isinstance(name, str) else ""


def _operations(record: Record) -> list[Any]:
    p = record.payload
    if p.get("action") == "batch":
        ops = p.get("operations")
        return ops if isinstance(ops, list) else []
    return [p]


def record_names(record: Record) -> list[str]:
    names = [_norm(op.get("name")) if isinstance(op, dict) else "" for op in _operations(record)]
    return names or [""]


def _chronological(group: list[Record]) -> list[Record]:
    return sorted(group, key=lambda r: (r.created_at, r.id))


def group_by_name(records: list[Record]) -> dict[str, list[Record]]:
    """Records keyed by skill name (a batch under each operation's name), oldest first."""
    groups: dict[str, list[Record]] = {}
    for record in records:
        for name in dict.fromkeys(record_names(record)):
            groups.setdefault(name, []).append(record)
    return {name: _chronological(group) for name, group in groups.items()}


def ready(group: list[Record], now: float, quiet: float = QUIET_S) -> bool:
    """True once the newest record of the group is at least ``quiet`` seconds old."""
    return max(r.created_at for r in group) <= now - quiet


# --- replay -----------------------------------------------------------------------------------


def _target(file_path: Any) -> str:
    """A skill-relative path Hermes itself would accept (skill_manager_tool._validate_file_path)."""
    if not isinstance(file_path, str) or not file_path:
        raise Skip("file_path missing")
    parts = file_path.split("/")
    if file_path.startswith("/") or "\\" in file_path or any(part in ("", ".", "..") for part in parts):
        raise Skip(f"path outside references/ templates/ scripts/ assets/: {file_path[:120]}")
    if parts[-1] == "SKILL.md" and len(parts) in (1, 2):
        return "SKILL.md"
    if not file_path.startswith(ALLOWED_PREFIXES) or len(parts) < 2:
        raise Skip(f"path outside references/ templates/ scripts/ assets/: {file_path[:120]}")
    if "__pycache__" in parts or file_path.endswith(".pyc"):
        raise Skip(f"compiled file not proposed: {file_path[:120]}")
    return file_path


def _apply(tree: dict[str, str], op: dict[str, Any]) -> None:
    action = op.get("action")
    if action == "delete":
        raise Skip("deletes are not proposed")
    if action in ("create", "edit"):
        content = op.get("content")
        if not isinstance(content, str) or not content:
            raise Skip(f"{action} without content")
        tree["SKILL.md"] = content
    elif action == "write_file":
        path = _target(op.get("file_path"))
        content = op.get("file_content")
        if not isinstance(content, str):
            raise Skip("write_file without file_content")
        tree[path] = content
    elif action == "remove_file":
        path = _target(op.get("file_path"))
        if path == "SKILL.md":
            raise Skip("SKILL.md cannot be removed")
        if path not in tree:
            raise Skip("remove_file target is not in the library copy")
        del tree[path]
    elif action == "patch":
        path = _target(op["file_path"]) if op.get("file_path") else "SKILL.md"
        old, new = op.get("old_string"), op.get("new_string")
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise Skip("patch without old_string/new_string")
        current = tree.get(path)
        # Exact matching only: Hermes' own patch is fuzzy (Pitfall 6); a miss is held, not guessed.
        if current is None or old not in current:
            raise Skip("patch did not apply")
        tree[path] = current.replace(old, new) if op.get("replace_all") else current.replace(old, new, 1)
    else:
        raise Skip(f"unknown action {str(action)[:40]!r}")


def replay(base: dict[str, str], group: list[Record], name: str) -> dict[str, str]:
    """The skill tree after applying the group's operations for ``name`` in created_at order."""
    tree = dict(base)
    for record in _chronological(group):
        for op in _operations(record):
            if not isinstance(op, dict):
                raise Skip("invalid batch operation")
            if _norm(op.get("name")) == name:
                _apply(tree, op)
    return tree


# --- scope ------------------------------------------------------------------------------------


def hermes_local_names(root: Path | str = HERMES_SKILLS) -> set[str]:
    """Names of real dirs holding SKILL.md at ``<name>/`` or ``<category>/<name>/`` (no dot dirs, no links)."""
    names: set[str] = set()

    def scan(directory: str, depth: int) -> None:
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if entry.name.startswith(".") or not entry.is_dir(follow_symlinks=False):
                continue
            if os.path.isfile(os.path.join(entry.path, "SKILL.md")):
                names.add(entry.name)
            if depth < 2:
                scan(entry.path, depth + 1)

    scan(str(root), 1)
    return names


def library_names(library: Path | str = LIBRARY) -> set[str]:
    root = Path(library)
    if not root.is_dir():
        return set()
    return {p.name for p in root.iterdir() if not p.name.startswith(".") and (p / "SKILL.md").is_file()}


def classify(group: list[Record], library: set[str], local: set[str]) -> tuple[str, str | None]:
    """("library", None) | ("new", None) | ("hold", reason)."""
    names = {n for r in group for n in record_names(r)}
    if len(names) > 1:
        return ("hold", "multi-skill-batch")
    name = next(iter(names), "")
    if not SKILL_NAME_RE.fullmatch(name):
        return ("hold", "invalid-name")
    if name in library:
        return ("library", None)
    if name in local:
        return ("hold", HERMES_LOCAL)
    first = _operations(_chronological(group)[0])
    if first and isinstance(first[0], dict) and first[0].get("action") == "create":
        return ("new", None) if _chronological(group)[0].origin == "foreground" else ("hold", "new-skill-not-foreground")
    return ("hold", "no-base")


def base_tree(library: Path | str, name: str) -> dict[str, str]:
    """The library copy of ``name`` as {relative path: UTF-8 text}; binaries and .pyc skipped; {} if absent."""
    root = Path(library) / name
    if root.is_symlink() or not root.is_dir():
        return {}
    tree: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in ("__pycache__", ".git"))
        for filename in sorted(filenames):
            path = Path(dirpath) / filename
            if filename.endswith(".pyc") or path.is_symlink() or not path.is_file():
                continue
            try:
                text = path.read_bytes().decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if "\x00" not in text:
                tree[path.relative_to(root).as_posix()] = text
    return tree


def proposal_for(base: dict[str, str], replayed: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """(files that differ from the library copy plus SKILL.md, sorted base paths the replay removed)."""
    if "SKILL.md" not in replayed:
        raise Skip("no SKILL.md")
    files = {path: text for path, text in sorted(replayed.items()) if base.get(path) != text}
    files["SKILL.md"] = replayed["SKILL.md"]
    remove = sorted(path for path in base if path not in replayed)
    return files, remove


# --- propose client ---------------------------------------------------------------------------


class ProposeClient:
    """POST /skills/propose as a host caller: the key is read per request, sent only as a header."""

    def __init__(
        self,
        url: str = SUBSTRATE_URL,
        *,
        key_file: Path | str = PROPOSE_KEY_FILE,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.url = url.rstrip("/") + "/skills/propose"
        self.key_file = Path(key_file)
        kwargs: dict[str, Any] = {"timeout": timeout}
        if transport is not None:
            kwargs["transport"] = transport
        self._client = httpx.Client(**kwargs)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ProposeClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def key(self) -> str:
        try:
            key = self.key_file.read_text(encoding="utf-8").strip()
        except OSError:
            raise KeyUnreadable("propose key unreadable") from None
        if not key:
            raise KeyUnreadable("propose key empty")
        return key

    def post(self, body: bytes) -> tuple[int, dict[str, Any]]:
        headers = {"content-type": "application/json", PROPOSE_KEY_HEADER: self.key()}
        try:
            response = self._client.post(self.url, content=body, headers=headers)
        except httpx.HTTPError as error:
            raise BridgeError(f"transport error: {type(error).__name__}") from None
        try:
            data = response.json()
        except ValueError:
            data = {}
        return response.status_code, data if isinstance(data, dict) else {}


# --- state and log ----------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log(log_path: Path, entry: dict[str, Any]) -> None:
    log_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"ts": _now_iso(), **entry}, ensure_ascii=False, sort_keys=True) + "\n")


def _load_held(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def _save_held(path: Path, held: dict[str, str]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(dict(sorted(held.items())), handle, indent=1)
        handle.write("\n")
    os.replace(tmp, path)


def resolve_hint(record_id: str, *, library_skill: bool, local_skill: bool) -> str:
    """How the owner settles a held record. A library skill is never approved (W11)."""
    publish = ("publish it with `substrate skills propose --dir <a copy outside /root/agent-skills> "
               f"--surface hermes`, then `/skills reject {record_id}`; or just `/skills reject {record_id}`")
    if library_skill:
        return (f"library skill: {publish}. Never `/skills approve {record_id}`: approve replays the write "
                "past the gate into external_dirs, i.e. the live checkout /root/agent-skills (D-04).")
    if local_skill:
        return (f"Hermes-local skill (not in the library): the owner may `/skills approve {record_id}` "
                f"or `/skills reject {record_id}`.")
    return (f"not in the library: {publish}. `/skills approve {record_id}` would write a Hermes-local "
            "skill instead of a library PR.")


def _rationale(name: str, group: list[Record]) -> str:
    records = "; ".join(f"{r.id} ({r.action}): {r.summary[:200]}" for r in group)
    return (f"Hermes staged skill_manage writes for {name} (skills.write_approval); proposed by the "
            f"substrate bridge (D-10). Records: {records}")


# --- ticks ------------------------------------------------------------------------------------


def run_once(
    client: ProposeClient,
    *,
    pending_dir: Path | str = PENDING_SKILLS,
    library: Path | str = LIBRARY,
    hermes_skills: Path | str = HERMES_SKILLS,
    log_path: Path | str = BRIDGE_LOG,
    held_path: Path | str = HELD_STATE,
    now: float | None = None,
) -> RunResult:
    """One bridge tick over Hermes' pending skills records."""
    now = time.time() if now is None else now
    log_path, held_path = Path(log_path), Path(held_path)
    result = RunResult()
    records = load_pending(pending_dir)
    if not records:
        if held_path.exists():
            _save_held(held_path, {})
        return result
    try:
        client.key()
    except KeyUnreadable:
        result.ok = False
        result.kept = len(records)
        return result

    live = {r.id for r in records}
    held = {rid: reason for rid, reason in _load_held(held_path).items() if rid in live}
    lib, local = library_names(library), hermes_local_names(hermes_skills)

    def hold(name: str, group: list[Record], reason: str) -> None:
        library_skill = name in lib or any(n in lib for r in group for n in record_names(r))
        for record in group:
            result.held += 1
            if held.get(record.id) == reason:
                continue
            held[record.id] = reason
            _log(log_path, {"name": name, "id": record.id, "status": "held", "reason": reason,
                            "resolve": resolve_hint(record.id, library_skill=library_skill,
                                                    local_skill=reason == HERMES_LOCAL)})

    def finish(group: list[Record], entry: dict[str, Any]) -> None:
        for record in group:
            record.path.unlink(missing_ok=True)
            held.pop(record.id, None)
        _log(log_path, entry)

    groups = sorted(group_by_name(records).items())
    for index, (name, group) in enumerate(groups):
        if not ready(group, now):
            result.waiting += len(group)
            continue
        kind, reason = classify(group, lib, local)
        if kind == "hold":
            hold(name, group, reason or "held")
            continue
        base = base_tree(library, name) if kind == "library" else {}
        try:
            files, remove = proposal_for(base, replay(base, group, name))
        except Skip as skip:
            hold(name, group, str(skip))
            continue
        ids = [r.id for r in group]
        if all(held.get(rid) == OVERSIZE for rid in ids):
            result.held += len(group)
            continue
        body: dict[str, Any] = {"name": name, "files": files}
        if remove:
            body["remove"] = remove
        body.update(rationale=_rationale(name, group), surface=SURFACE)
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if len(data) > ROUTE_MAX_BYTES:
            hold(name, group, OVERSIZE)
            continue
        try:
            status, reply = client.post(data)
        except KeyUnreadable:
            result.ok = False
            result.kept += sum(len(g) for _, g in groups[index:])
            break
        except BridgeError:
            result.kept += len(group)
            continue
        if status == 200 and reply.get("status") in FINAL_STATUSES:
            finish(group, {"name": name, "ids": ids, "status": reply["status"], "pr_url": reply.get("pr_url")})
            result.proposed += 1
        elif status == 400:
            rules = sorted({str(f.get("rule")) for f in reply.get("findings") or [] if isinstance(f, dict)})
            finish(group, {"name": name, "ids": ids, "status": "rejected", "pr_url": None,
                           "error": str(reply.get("error", ""))[:400], "rules": rules})
            result.rejected += 1
        elif status == 413:
            hold(name, group, OVERSIZE)
        elif status == 401:
            result.ok = False
            result.kept += sum(len(g) for _, g in groups[index:])
            break
        else:
            result.kept += len(group)
    _save_held(held_path, held)
    return result


def _reject_queued(path: Path) -> None:
    rejected = path.parent / "rejected"
    rejected.mkdir(mode=0o700, exist_ok=True)
    os.replace(path, rejected / path.name)


def drain_queue(
    directory: Path | str,
    expected_surface: str,
    client: ProposeClient,
    *,
    log_path: Path | str = BRIDGE_LOG,
) -> RunResult:
    """Post each queued propose body as-is; remove on success, move to rejected/ on 400/413."""
    root, log_path = Path(directory), Path(log_path)
    result = RunResult()
    files = sorted(p for p in root.glob("*.json") if p.is_file()) if root.is_dir() else []
    if not files:
        return result
    try:
        client.key()
    except KeyUnreadable:
        result.ok = False
        result.kept = len(files)
        return result
    for index, path in enumerate(files):
        base = {"queue": expected_surface, "file": path.name}
        try:
            raw = path.read_bytes()
            body = json.loads(raw)
        except (OSError, ValueError):
            _reject_queued(path)
            _log(log_path, {**base, "status": "rejected", "error": "unreadable or invalid JSON"})
            result.rejected += 1
            continue
        if not isinstance(body, dict) or body.get("surface") != expected_surface:
            _reject_queued(path)
            _log(log_path, {**base, "status": "rejected", "error": f"surface is not {expected_surface}"})
            result.rejected += 1
            continue
        base["name"] = str(body.get("name", ""))[:80]
        if len(raw) > ROUTE_MAX_BYTES:
            _reject_queued(path)
            _log(log_path, {**base, "status": "rejected", "error": "body over the propose route's 1 MB cap"})
            result.rejected += 1
            continue
        try:
            status, reply = client.post(raw)
        except KeyUnreadable:
            result.ok = False
            result.kept += len(files) - index
            break
        except BridgeError:
            result.kept += 1
            continue
        if status == 200 and reply.get("status") in FINAL_STATUSES:
            path.unlink(missing_ok=True)
            _log(log_path, {**base, "status": reply["status"], "pr_url": reply.get("pr_url")})
            result.proposed += 1
        elif status in (400, 413):
            _reject_queued(path)
            rules = sorted({str(f.get("rule")) for f in reply.get("findings") or [] if isinstance(f, dict)})
            _log(log_path, {**base, "status": "rejected", "error": str(reply.get("error", ""))[:400],
                            "http_status": status, "rules": rules})
            result.rejected += 1
        elif status == 401:
            result.ok = False
            result.kept += len(files) - index
            break
        else:
            result.kept += 1
    return result
