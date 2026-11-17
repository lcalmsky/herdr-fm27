"""Add the layout's key zones to a Herdr keys.json without changing the person's bindings."""
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

TAG_RE = re.compile(r"[A-Za-z0-9._-]+")
USAGE = "usage: merge-keys.py <target keys.json> <source keys.json> --backup-tag <tag>"


def fail(message):
    print(f"merge-keys: {message}", file=sys.stderr)
    sys.exit(1)


def load(path, what):
    try:
        text = path.read_text()
    except OSError as err:
        fail(f"cannot read {what} {path}: {err.strerror}")
    except UnicodeDecodeError as err:
        fail(f"{what} {path} is not UTF-8: {err}")
    try:
        data = json.loads(text)
    except ValueError as err:
        fail(f"{what} {path} is not valid JSON: {err}")
    if not isinstance(data, dict):
        fail(f"{what} {path} does not hold a JSON object")
    return data


def write_atomic(target, data, mode):
    handle, temp = tempfile.mkstemp(dir=target.parent, prefix=".keys-", suffix=".tmp")
    try:
        with os.fdopen(handle, "w") as out:
            out.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        os.chmod(temp, mode if mode is not None else 0o644)
        os.replace(temp, target)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def main():
    args = sys.argv[1:]
    tag = None
    if "--backup-tag" in args:
        at = args.index("--backup-tag")
        tag = args[at + 1] if at + 1 < len(args) else None
        if (
            not tag
            or tag.startswith("-")
            or tag in (".", "..")
            or not TAG_RE.fullmatch(tag)
        ):
            fail(USAGE)
        del args[at:at + 2]
    if len(args) != 2 or tag is None:
        fail(USAGE)
    target, source = Path(args[0]), Path(args[1])
    # A linked keys.json is written through to the file it points at, with the backup beside that file.
    if target.is_symlink():
        target = target.resolve()
    add = load(source, "source")
    for zone, bindings in add.items():
        if not isinstance(bindings, dict):
            fail(f"source {source} zone {zone} is not a JSON object")

    exists = target.exists()
    keys = load(target, "target") if exists else {}

    added = {}
    skipped = []
    for zone, bindings in add.items():
        current = keys.get(zone)
        if current is None:
            current = keys[zone] = {}
        elif not isinstance(current, dict):
            fail(f"target {target} zone {zone} is not a JSON object")
        new = []
        for name, command in bindings.items():
            if name not in current:
                current[name] = command
                new.append(name)
            elif current[name] != command:
                skipped.append((zone, name, current[name]))
        if new:
            added[zone] = new

    if added:
        summary = "; ".join(f"{zone}: {', '.join(names)}" for zone, names in added.items())
        print(f"added {summary}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if exists:
            backup = target.with_name(f"{target.name}.bak-{tag}-{int(time.time())}")
            shutil.copy2(target, backup)
        mode = os.stat(target).st_mode & 0o777 if exists else None
        write_atomic(target, keys, mode)
    else:
        print(f"nothing to add; {target} already has every layout key")

    for zone, name, bound in skipped:
        print(f"kept {name} in {zone} (bound to {bound})")


if __name__ == "__main__":
    main()
