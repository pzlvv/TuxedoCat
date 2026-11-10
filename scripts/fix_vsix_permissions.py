#!/usr/bin/env python3
"""Fix Unix executable permissions in .vsix (zip) files.

VSIX packages built on Windows lose Unix executable permissions.
This script restores +x for the bundled Linux executables (ripgrep / Standalone Core).
"""

import json
import zipfile
import os
import sys
import shutil

# 产品名与 Core 二进制名取工程配置的唯一来源（docs/product-identity.md）：
# 路径相对本脚本文件解析，不受调用方 cwd 影响。
_PROJECT_JSON = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "src", "config", "project.json",
)
with open(_PROJECT_JSON, encoding="utf-8") as _f:
    _PROJECT = json.load(_f)

CORE_BINARY_NAME = _PROJECT["core"]["binaryName"]

# 内置工具（rg / fd）随 Core 产物落位，打包只带 dist/resources/core/**/<tool>/：
# 两份工具（与 Core 可执行文件同级，Grep / Glob 与工具 shell 的 PATH 前置靠它们）在
# x64-linux 与 arm64-linux 各一份（build-core.mjs 的 PACKAGE_DIRS）。
# 本变体里不存在的条目匹配不到，静默跳过。
TARGET_FILES = [
    f"extension/dist/resources/core/x64-linux/{CORE_BINARY_NAME}",
    "extension/dist/resources/core/x64-linux/ripgrep/rg",
    "extension/dist/resources/core/x64-linux/fd/fd",
    # arm64 Linux 与 x64 同为打包要携带的平台（build-core.mjs 的 PACKAGE_DIRS）
    f"extension/dist/resources/core/arm64-linux/{CORE_BINARY_NAME}",
    "extension/dist/resources/core/arm64-linux/ripgrep/rg",
    "extension/dist/resources/core/arm64-linux/fd/fd",
    # Add more linux/macos binaries here if needed
    # "extension/dist/resources/core/x64-darwin/ripgrep/rg",
]


def find_newest_vsix(directory: str = "release") -> str | None:
    """Return the most recently modified .vsix file in directory."""
    candidates = [
        os.path.join(directory, f)
        for f in os.listdir(directory)
        if f.lower().endswith(".vsix") and os.path.isfile(os.path.join(directory, f))
    ]
    if not candidates:
        return None
    return max(candidates, key=os.path.getmtime)


def fix_permissions(vsix_path: str) -> None:
    """Rewrite the vsix with proper Unix executable permissions."""

    if not os.path.exists(vsix_path):
        print(f"Error: File not found: {vsix_path}")
        sys.exit(1)

    tmp_path = vsix_path + ".tmp"

    with zipfile.ZipFile(vsix_path, "r") as zin:
        with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                # Check if this file needs +x
                should_be_x = any(
                    item.filename == target or item.filename.startswith(target)
                    for target in TARGET_FILES
                )

                if should_be_x:
                    # Preserve existing mode bits, add owner/group/other execute
                    old_mode = (item.external_attr >> 16) & 0xFFFF
                    new_mode = (old_mode | 0o111) & ~0o022  # rwxr-xr-x (755) instead of 777
                    item.external_attr = (new_mode << 16) | (
                        item.external_attr & 0xFFFF
                    )
                    print(
                        f"  +x {item.filename}: "
                        f"mode {oct(old_mode)} -> {oct(new_mode)}"
                    )

                data = zin.read(item.filename)
                zout.writestr(item, data)

    # Replace original with fixed version
    shutil.move(tmp_path, vsix_path)
    print(f"\nDone: {vsix_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        vsix_path = find_newest_vsix()
        if vsix_path is None:
            print("Error: No .vsix file found in release directory")
            sys.exit(1)
        print(f"Auto-detected: {vsix_path}")
    else:
        vsix_path = sys.argv[1]

    fix_permissions(vsix_path)
