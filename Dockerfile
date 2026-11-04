# 打包镜像：在 Linux 容器里完成 `npm ci` 与 `npm run package`。
#
# 为什么需要这个镜像
# ------------------
# `npm run package` = `package:ext`（.vsix）+ `package:app:installer`（NSIS x64 / arm64）
# + `package:tui`（四平台 TUI 安装器）。整条链的前置是 `vscode:prepublish` 里的
# `npm run build:core`：要产出 `PACKAGE_DIRS` 登记的全部四份 Core
# （win32 x64 / arm64 + linux x64 / arm64，见 scripts/build-core.mjs），
# 链尾 `scripts/verify-core-artifacts.mjs` 会逐个查产物、构建指纹与 `dist/` 里的副本
# （docs/core/standalone-core.md 第 3.3 节）。
#
# 四份 Core 在 Linux 宿主上的落地方式：
#   * linux x64（musl）：系统 cc + musl-gcc（musl-tools）；
#   * linux arm64（musl）：zig cc / zig ar（脚本在非 Linux 宿主才注入，Linux 宿主上
#     由本镜像的 ENV 显式给出）；
#   * win32 x64 / arm64（msvc）：MSVC 链接器不跨平台，用 cargo-xwin 取 CRT 与
#     Windows SDK，clang-cl 编译、lld-link 链接、llvm-lib 归档。
#     `build-core.mjs` 的 `buildableOnHost()` 把 msvc 目标限定在 Windows 宿主，
#     所以这两份由镜像在 `npm run package` 之前显式构建（见 CMD）。
#   * NSIS 安装包：electron-builder 产出未签名安装器后要用 wine 跑一次它来写
#     uninstaller（app-builder-lib 的 NsisTarget），镜像里必须装 wine。
#
# 所有镜像源都是 build-arg，无网络限制的机器可以换回官方源。

# ---------------------------------------------------------------------------
# 基础镜像
# ---------------------------------------------------------------------------
# 国内拉取 Docker Hub 走镜像站前缀，例如：
#   --build-arg NODE_IMAGE=docker.1ms.run/library/node:22-bookworm
ARG NODE_IMAGE=node:22-bookworm
FROM ${NODE_IMAGE}

# ---------------------------------------------------------------------------
# 镜像源（默认国内，可覆盖）
# ---------------------------------------------------------------------------
ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security
ARG RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup
ARG RUSTUP_UPDATE_ROOT=https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup
ARG CARGO_REGISTRY=sparse+https://rsproxy.cn/index/
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ARG ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
# zig 的获取渠道：官方站点在国内常常只有十几 KB/s（47MB 要下很久），
# 改从 PyPI 的 ziglang wheel 取同一个官方二进制（PyPI 镜像速度是 MB 级）。
ARG ZIG_VERSION=0.13.0
ARG PYPI_MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    RUSTUP_DIST_SERVER=${RUSTUP_DIST_SERVER} \
    RUSTUP_UPDATE_ROOT=${RUSTUP_UPDATE_ROOT} \
    CARGO_REGISTRY=${CARGO_REGISTRY} \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    ELECTRON_MIRROR=${ELECTRON_MIRROR} \
    ELECTRON_BUILDER_BINARIES_MIRROR=${ELECTRON_BUILDER_BINARIES_MIRROR}

# ---------------------------------------------------------------------------
# 系统依赖
# ---------------------------------------------------------------------------
# 每一项的用途：
#   build-essential / musl-tools  linux x64（musl）本机 C 编译器：ring 的 C / 汇编、
#                                 mimalloc、bundled SQLite 都经 cc-rs 编译
#   nasm                          ring 的 x86_64 汇编预生成目标
#   clang / lld / llvm            win32 目标的 clang-cl + lld-link + llvm-lib
#   wine wine64 wine32            electron-builder 跑 NSIS 安装器写 uninstaller
#   python3                       scripts/fix_vsix_permissions.py（vsce 之后修 unix +x），
#                                 该脚本以 `python` 调用，下面补一个同名软链
#   git / xz-utils / unzip / zip  zig 压缩包解压、electron-builder 的 7z 旁路、npm 的 git 依赖
RUN printf 'Types: deb\nURIs: %s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
        "${DEBIAN_MIRROR}" "${DEBIAN_SECURITY_MIRROR}" > /etc/apt/sources.list.d/debian.sources \
 && dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential musl-tools nasm \
      clang lld llvm \
      wine wine64 wine32:i386 \
      python3 python3-pip git xz-utils unzip zip \
      ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/local/bin/python

# ---------------------------------------------------------------------------
# Rust 工具链
# ---------------------------------------------------------------------------
# 四个 Core 目标全部装进默认 stable 工具链（asan 变体要 nightly，不在本镜像范围）。
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

# 登录 shell（`bash -l`）会读 /etc/profile，把 PATH 覆盖成镜像默认值、丢掉 cargo 的路径；
# 补一份 profile 片段，让交互式 `docker run -it ... bash` 里也能直接调 cargo / zig。
RUN printf 'export PATH=/usr/local/cargo/bin:$PATH\n' > /etc/profile.d/rust.sh

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
 && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable --no-modify-path \
 && rm /tmp/rustup-init.sh \
 && rustup target add \
      x86_64-unknown-linux-musl \
      aarch64-unknown-linux-musl \
      x86_64-pc-windows-msvc \
      aarch64-pc-windows-msvc \
 && rustc -vV

# crates.io 索引镜像（无网络限制时用官方：--build-arg CARGO_REGISTRY=sparse+https://index.crates.io/）
RUN mkdir -p "${CARGO_HOME}" \
 && printf '[source.crates-io]\nreplace-with = "mirror"\n\n[source.mirror]\nregistry = "%s"\n' \
      "${CARGO_REGISTRY}" > "${CARGO_HOME}/config.toml" \
 && cat "${CARGO_HOME}/config.toml"

# ---------------------------------------------------------------------------
# cargo-xwin：win32 目标的 CRT / Windows SDK
# ---------------------------------------------------------------------------
# 预取到固定目录，之后构建 win32 Core 与 TUI 安装器都不再需要联网。
ENV XWIN_CACHE_DIR=/opt/xwin

RUN cargo install cargo-xwin --locked \
 && cargo xwin --version

# 预取 CRT + Windows SDK（x86_64 与 aarch64 两份）。xwin 解包 SDK 时并行处理两种架构，
# 偶发撞上「符号链接已存在」的竞态，所以每次从空目录重来并重试。
RUN for attempt in 1 2 3; do \
      rm -rf /opt/xwin \
   && cargo xwin cache xwin \
   && break \
   || { echo "[xwin] 第 ${attempt} 次预取失败，重试…"; sleep 5; }; \
    done \
 && test -d /opt/xwin/xwin/crt/lib/x86_64 \
 && test -d /opt/xwin/xwin/crt/lib/aarch64 \
 && test -d /opt/xwin/xwin/sdk/lib/um/x86_64 \
 && test -d /opt/xwin/xwin/sdk/lib/um/aarch64 \
 && test -d /opt/xwin/xwin/sdk/include/um

# Debian 的 clang 包不带 `clang-cl` 这个入口（LLVM 官方发行版才有），
# 而 `clang --driver-mode=cl` 是同一个东西。补一个包装脚本，让 cc-rs / ring 的
# `CC_...=clang-cl` 能解析到。
RUN printf '#!/bin/sh\nexec clang --driver-mode=cl "$@"\n' > /usr/local/bin/clang-cl \
 && chmod +x /usr/local/bin/clang-cl \
 && clang-cl --version | head -2

# ---------------------------------------------------------------------------
# zig：linux arm64 与 win32 arm64 的 C 编译器
# ---------------------------------------------------------------------------
# 固定 0.13.0：与 .github/workflows/release.yml 的 mlugg/setup-zig 同一版本，产物可比。
# 二进制与官方 zig-linux-x86_64-0.13.0.tar.xz 是同一份（PyPI 的 ziglang 包就打包官方发行物），
# 只是换了个更快的下载渠道。
RUN pip3 install --no-cache-dir --break-system-packages \
      --index-url "${PYPI_MIRROR}" "ziglang==${ZIG_VERSION}" \
 && ZIG_BIN="$(python3 -c 'import ziglang, os; print(os.path.join(os.path.dirname(ziglang.__file__), "zig"))')" \
 && test -x "${ZIG_BIN}" \
 && ln -s "${ZIG_BIN}" /usr/local/bin/zig \
 && zig version

# ---------------------------------------------------------------------------
# 交叉工具链接线（镜像的核心价值）
# ---------------------------------------------------------------------------
# Linux arm64（musl）：build-core.mjs 在 Linux 宿主上不注入 zig（它认为系统的 cc 能用），
# 但 Debian 的 musl-tools 只提供 x86_64 的 musl-gcc，aarch64 必须由 zig 充当。
ENV CC_aarch64_unknown_linux_musl="zig cc" \
    CFLAGS_aarch64_unknown_linux_musl="--target=aarch64-linux-musl" \
    AR_aarch64_unknown_linux_musl="zig ar"

# win32 x64（msvc）：clang-cl 编译、llvm-lib 归档、lld-link 链接。
# 头文件与导入库路径按目标分别给出（CARGO_TARGET_*_RUSTFLAGS 是目标专属变量，
# 不会污染宿主编译），值来自 `cargo xwin env --target <triple>` 的输出。
ENV CC_x86_64_pc_windows_msvc=clang-cl \
    AR_x86_64_pc_windows_msvc=llvm-lib \
    CFLAGS_x86_64_pc_windows_msvc="--target=x86_64-pc-windows-msvc /imsvc /opt/xwin/xwin/crt/include /imsvc /opt/xwin/xwin/sdk/include/ucrt /imsvc /opt/xwin/xwin/sdk/include/um /imsvc /opt/xwin/xwin/sdk/include/shared" \
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=lld-link \
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-C linker-flavor=lld-link -Lnative=/opt/xwin/xwin/crt/lib/x86_64 -Lnative=/opt/xwin/xwin/sdk/lib/um/x86_64 -Lnative=/opt/xwin/xwin/sdk/lib/ucrt/x86_64"

# win32 arm64（msvc）：ring 的 build.rs 对这个目标硬性要求 clang，仓库
# `core-rs/.cargo/config.toml` 的 `[env]` 用 `zig cc` 充当（Windows 宿主上同样如此）。
#
# 这里有个必须绕开的点：`build-core.mjs::crossToolchainEnv()` 会**自己**为这个三元组
# 注入 `CC_<triple> = "<ZIG 或 zig> cc"`，镜像里设的 `CC_aarch64_pc_windows_msvc`
# 会被它覆盖（脚本注入优先）。所以不能靠 ENV 改编译器，而要改 `ZIG` 指向的**可执行
# 文件**本身：给 zig 包一层，把 xwin 的 CRT / SDK 头文件经 CPATH 交给它——zig 自带的
# libc 只覆盖 unix 目标，msvc 目标缺 assert.h / stdint.h 就在这一步失败。
# 头文件必须走 CPATH（按系统头处理）：用 -I 时 MSVC 的 corecrt.h 会解析出错。
# 这条 CPATH 只在这层包装里生效，不会像全局 ENV 那样漏进同一镜像的 linux musl 构建。
RUN mkdir -p /opt/zig-msvc \
 && printf '#!/bin/sh\nCPATH=/opt/xwin/xwin/crt/include:/opt/xwin/xwin/sdk/include/ucrt:/opt/xwin/xwin/sdk/include/um:/opt/xwin/xwin/sdk/include/shared \\\n  exec /usr/local/bin/zig "$@"\n' > /opt/zig-msvc/zig \
 && chmod +x /opt/zig-msvc/zig \
 && printf '#include <assert.h>\n#include <stdio.h>\nint f(void){return 0;}\n' > /tmp/probe.c \
 && ZIG=/opt/zig-msvc/zig sh -c '/opt/zig-msvc/zig cc --target=aarch64-windows-msvc -c /tmp/probe.c -o /tmp/probe.o' \
 && rm -f /tmp/probe.c /tmp/probe.o \
 && echo "[zig-msvc] CRT / SDK 头文件可用"

# ZIG 同时是 build-core.mjs 选 zig 的入口：设了它，脚本注入的 CC 就是这层包装。
ENV ZIG=/opt/zig-msvc/zig \
    AR_aarch64_pc_windows_msvc=llvm-lib \
    CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_LINKER=rust-lld \
    CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUSTFLAGS="-C linker-flavor=lld-link -Lnative=/opt/xwin/xwin/crt/lib/aarch64 -Lnative=/opt/xwin/xwin/sdk/lib/um/aarch64 -Lnative=/opt/xwin/xwin/sdk/lib/ucrt/aarch64"

# ---------------------------------------------------------------------------
# 依赖安装
# ---------------------------------------------------------------------------
WORKDIR /app

# 只拷两个清单：依赖层单独成层，源码改动不会让它失效
COPY package.json package-lock.json ./
RUN npm ci

# npm 装出来的可执行文件在部分包里丢掉了 +x 位（`7zip-bin` 的 `linux/*/7za` 在 tarball
# 里就是 0644）。`electron-builder.config.js` 在非 Windows 宿主上固定用这个 7za 打包，
# 少了执行位会在 NSIS 阶段报 EACCES。这里统一补一次。
RUN chmod +x node_modules/7zip-bin/linux/*/7za \
 && node_modules/7zip-bin/linux/x64/7za 2>&1 | head -2

# ---------------------------------------------------------------------------
# 源码
# ---------------------------------------------------------------------------
# resources/** 走 Git LFS（预编译 ripgrep）。构建上下文必须是 `git lfs pull` 之后的工作树，
# 否则拿到的是 LFS 指针文件，打进包的 Grep / Glob 不是可执行文件。
COPY . .

# ---------------------------------------------------------------------------
# 默认动作：产出全部发布物到 /app/release
# ---------------------------------------------------------------------------
# `npm run package` 里的两步会按宿主过滤掉 Windows 目标（都判 `process.platform`）：
#   * `vscode:prepublish` 的 `npm run build:core` 只建 linux 两份（buildableOnHost）；
#   * `package:tui` 的 build-tui-installer 默认集合同样跳过 win32 两个安装器。
# 所以在 `npm run package` 前后各补一次显式 `--target`，四平台产物才齐：
#   1. 先补 win32 两份 Core（链尾 verify-core-artifacts 要查四份）；
#   2. 跑 `npm run package`：vsix + NSIS x64/arm64 + Linux 两个 TUI 安装器；
#   3. 再补两个 win32 TUI 安装器（内嵌的 Core 上一步已经就位）。
CMD ["sh", "-lc", "node scripts/build-core.mjs --target x86_64-pc-windows-msvc && node scripts/build-core.mjs --target aarch64-pc-windows-msvc && npm run package && node scripts/build-tui-installer.mjs --target x86_64-pc-windows-msvc && node scripts/build-tui-installer.mjs --target aarch64-pc-windows-msvc"]

# 用法：
#   git lfs pull
#   docker build -t <image-name> .
#   docker run --rm -v "$PWD/release:/app/release" <image-name>
#
# 只想验证依赖安装：
#   docker run --rm <image-name> npm ci
#
# 镜像源换回官方（无网络限制的机器）：
#   docker build -t <image-name> \
#     --build-arg DEBIAN_MIRROR=http://deb.debian.org/debian \
#     --build-arg DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security \
#     --build-arg RUSTUP_DIST_SERVER=https://static.rust-lang.org \
#     --build-arg RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup \
#     --build-arg CARGO_REGISTRY=sparse+https://index.crates.io/ \
#     --build-arg NPM_REGISTRY=https://registry.npmjs.org \
#     .
