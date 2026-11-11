"""Merge the layout's keys.json sections into the person's keys.json, keeping a backup."""
import json
import shutil
import sys
import time
from pathlib import Path

target, source = Path(sys.argv[1]), Path(sys.argv[2])
add = json.loads(source.read_text())
keys = json.loads(target.read_text()) if target.exists() else {}
if target.exists():
    shutil.copy(target, target.with_name(f"keys.json.bak-fm27-{int(time.time())}"))
for section, bindings in add.items():
    keys.setdefault(section, {}).update(bindings)
target.write_text(json.dumps(keys, ensure_ascii=False, indent=2) + "\n")
print(f"merged {', '.join(add)} into {target}")
