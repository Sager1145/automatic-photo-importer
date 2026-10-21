# 历史 Swift 产品（已移除）

当前唯一产品是 Electron/React/Node 桌面程序，见 README 的 npm 命令。

2026-10-20 架构审查移除了已被多平台实现取代的 SwiftUI 应用（`Sources/PhotoImporter`）、Swift 复制核心（`Sources/ImporterCore`）、仅供它使用的 Swift 目标保护/路由/元数据代码及其测试，以及 `Scripts/package_app.sh`。这些代码是规划、复制、卷发现和元数据读取的第二套实现，不被 Electron 调用。移除前的完整工作树备份在 `build/architecture-review-2/pre-review-backup.tar.gz`（`build/` 不进入 git）。

保留的原生代码只有 macOS 相机协议 adapter：`Sources/CameraBridge`（JSONL 进程边界，另提供 `--set-file-times` 写入 Created 日期）与 `Sources/CameraAdapters/DeviceDiscovery.swift`（只浏览 ImageCaptureCore PTP/MTP 相机并下载到暂存目录）。挂载的存储卡统一由 `desktop/platform/volumes.ts` 发现，Swift 侧不再有第二个卷扫描器。构建：`npm run native:mac`；测试：`Scripts/test.sh`。
