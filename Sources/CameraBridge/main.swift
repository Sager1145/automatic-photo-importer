import AppKit
import CameraAdapters
import Foundation
import Darwin

private struct Command: Decodable, Sendable {
    let id: String
    let command: String
    let cameraID: String?
    let directory: String?
}

/// JSONL process boundary around the existing non-deleting ImageCaptureCore adapter.
@main
@MainActor
struct NativeCameraBridge {
    static func emit(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    static func serve() async {
        let discovery = DeviceDiscovery()
        defer { discovery.stop() }
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                guard let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(Command.self, from: data) else { continue }
                do {
                    switch command.command {
                    case "list":
                        let cameras = discovery.sources.map { ["name": $0.name, "cameraID": $0.id] }
                        emit(["id": command.id, "result": cameras])
                    case "stage":
                        guard let cameraID = command.cameraID, let directory = command.directory,
                              directory.hasPrefix("/"), FileManager.default.fileExists(atPath: directory) else {
                            emit(["id": command.id, "error": "Camera staging requires an existing absolute temporary folder."])
                            continue
                        }
                        let staged = try await discovery.stageCamera(id: cameraID, to: URL(fileURLWithPath: directory, isDirectory: true)) { completed, total in
                            Task { @MainActor in
                                emit(["id": command.id, "progress": ["completed": completed, "total": total]])
                            }
                        }
                        emit(["id": command.id, "result": ["path": staged.path]])
                    default:
                        emit(["id": command.id, "error": "Unknown native camera command."])
                    }
                } catch {
                    emit(["id": command.id, "error": error.localizedDescription])
                }
            }
        } catch {
            FileHandle.standardError.write(Data(("Native camera bridge: \(error.localizedDescription)\n").utf8))
        }
        NSApplication.shared.terminate(nil)
    }

    /// The writable descriptor is inherited as fd 3. No source or destination
    /// pathname crosses this boundary, so replacements cannot redirect writes.
    static func setFileTimes() -> Never {
        do {
            guard CommandLine.arguments.count == 4,
                  let created = Double(CommandLine.arguments[2]), created.isFinite,
                  let modified = Double(CommandLine.arguments[3]), modified.isFinite,
                  abs(created) <= 8_640_000_000_000, abs(modified) <= 8_640_000_000_000 else {
                throw NSError(domain: "File timestamps", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid filesystem timestamp request."])
            }
            var stat = Darwin.stat()
            guard fstat(3, &stat) == 0, (stat.st_mode & S_IFMT) == S_IFREG, stat.st_nlink == 1 else {
                throw NSError(domain: "File timestamps", code: 2, userInfo: [NSLocalizedDescriptionKey: "Filesystem timestamps require an exclusively owned regular file."])
            }
            func clock(_ seconds: Double) -> timespec {
                let whole = floor(seconds)
                return timespec(tv_sec: Int(whole), tv_nsec: Int((seconds - whole) * 1_000_000_000))
            }
            struct Times { var created: timespec; var modified: timespec }
            var attributes = attrlist()
            attributes.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
            attributes.commonattr = attrgroup_t(ATTR_CMN_CRTIME | ATTR_CMN_MODTIME)
            var times = Times(created: clock(created), modified: clock(modified))
            guard fsetattrlist(3, &attributes, &times, MemoryLayout<Times>.size, 0) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            exit(0)
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }

    /// Parent directories arrive as fd 3/4 and the reviewed source as fd 5. Only
    /// a single component is accepted; no pathname resolution crosses this boundary.
    static func renameExclusive() -> Never {
        func fail(_ error: Int32) -> Never {
            emit(["errno": Int(error)])
            FileHandle.standardError.write(Data((String(cString: strerror(error)) + "\n").utf8))
            exit(1)
        }
        let args = CommandLine.arguments
        func component(_ name: String) -> Bool {
            !name.isEmpty && name != "." && name != ".." && !name.contains("/") && !name.utf8.contains(0)
        }
        guard args.count == 4, component(args[2]), component(args[3]) else { fail(EINVAL) }
        var fromParent = Darwin.stat(), toParent = Darwin.stat(), held = Darwin.stat(), named = Darwin.stat()
        guard fstat(3, &fromParent) == 0, fstat(4, &toParent) == 0, fstat(5, &held) == 0 else { fail(errno) }
        guard (fromParent.st_mode & S_IFMT) == S_IFDIR, (toParent.st_mode & S_IFMT) == S_IFDIR,
              (held.st_mode & S_IFMT) == S_IFREG else { fail(EINVAL) }
        guard fstatat(3, args[2], &named, AT_SYMLINK_NOFOLLOW) == 0 else { fail(errno) }
        guard (named.st_mode & S_IFMT) == S_IFREG, named.st_dev == held.st_dev, named.st_ino == held.st_ino,
              named.st_size == held.st_size, named.st_mtimespec.tv_sec == held.st_mtimespec.tv_sec,
              named.st_mtimespec.tv_nsec == held.st_mtimespec.tv_nsec,
              named.st_ctimespec.tv_sec == held.st_ctimespec.tv_sec,
              named.st_ctimespec.tv_nsec == held.st_ctimespec.tv_nsec else { fail(ESTALE) }
        guard renameatx_np(3, args[2], 4, args[3], UInt32(RENAME_EXCL)) == 0 else { fail(errno) }
        emit(["renamed": true])
        exit(0)
    }

    static func main() {
        if CommandLine.arguments.dropFirst().first == "--set-file-times" { setFileTimes() }
        if CommandLine.arguments.dropFirst().first == "--rename-exclusive" { renameExclusive() }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        Task { @MainActor in await serve() }
        application.run()
    }
}
