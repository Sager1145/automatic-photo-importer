import AppKit
import CameraAdapters
import Foundation
import Darwin

private struct Command: Decodable, Sendable {
    let id: String
    let command: String
    let cameraID: String?
    /// With "files": only this storage (card slot) of the camera, by the id "list" reported for it.
    let storageID: String?
    let objectID: String?
    let offset: Int64?
    let length: Int64?
}

/// JSONL process boundary around the non-deleting ImageCaptureCore adapter. The protocol is the Windows bridge's
/// (desktop/platform/windows-camera.ts): "list" the cameras, "files" of one (names, folders, sizes, dates; nothing
/// downloaded), "read" a byte range of one file (base64 in the reply), "release" what a reader held, "close" the camera's session once
/// the app's imports of it end. The app plans from
/// the list, reads only what it needs, and writes new files only into the destination.
@main
@MainActor
struct NativeCameraBridge {
    static func line(_ data: Data) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    static func emit(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        line(data)
    }

    /// A string's characters as they stand inside a JSON string literal.
    static func escaped(_ text: String) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": result += "\\\""
            case "\\": result += "\\\\"
            case _ where scalar.value < 0x20: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result
    }

    static func milliseconds(_ date: Date?) -> Int64? {
        guard let date, date.timeIntervalSince1970 > 0 else { return nil }
        return Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    static func serve() async {
        let discovery = DeviceDiscovery()
        defer { discovery.stop() }
        do {
            for try await text in FileHandle.standardInput.bytes.lines {
                guard let data = text.data(using: .utf8),
                      let command = try? JSONDecoder().decode(Command.self, from: data) else { continue }
                do {
                    switch command.command {
                    case "list":
                        let cameras = discovery.sources.map { source -> [String: Any] in
                            var camera: [String: Any] = ["name": source.name, "cameraID": source.id]
                            if !source.storages.isEmpty { camera["storages"] = source.storages.map { ["id": $0.id, "name": $0.name] } }
                            return camera
                        }
                        emit(["id": command.id, "result": cameras])
                    case "files":
                        guard let cameraID = command.cameraID else { throw CameraAdapterError.unavailable }
                        let files = try await discovery.files(id: cameraID, storageID: command.storageID)
                        emit(["id": command.id, "result": files.map { file -> [String: Any] in
                            var entry: [String: Any] = ["storage": file.storage, "folder": file.folder, "name": file.name, "size": file.size, "objectID": file.objectID]
                            if let modified = milliseconds(file.modified) { entry["modified"] = modified }
                            if let created = milliseconds(file.created) { entry["created"] = created }
                            return entry
                        }])
                    case "read":
                        guard let cameraID = command.cameraID, let objectID = command.objectID, let offset = command.offset, let length = command.length else { throw CameraAdapterError.invalidRead }
                        let bytes = try await discovery.read(id: cameraID, objectID: objectID, offset: offset, length: length)
                        // Written by hand: a 16 MB range is 22 MB of base64, which JSONSerialization would copy again.
                        var reply = Data("{\"id\":\"".utf8)
                        reply.append(Data(escaped(command.id).utf8))
                        reply.append(Data("\",\"result\":{\"bytes\":\(bytes.count),\"data\":\"".utf8))
                        reply.append(bytes.base64EncodedData())
                        reply.append(Data("\"}}".utf8))
                        line(reply)
                    case "release":
                        // Each range is its own request on the camera; nothing stays open between them.
                        emit(["id": command.id, "result": true])
                    case "close":
                        // The app's imports of this camera ended: its session goes, so Photos, Lightroom or another
                        // app can use the camera and it can sleep. The next "files" opens a new one.
                        if let cameraID = command.cameraID { discovery.close(id: cameraID) }
                        emit(["id": command.id, "result": true])
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
