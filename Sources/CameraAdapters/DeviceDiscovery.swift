import Foundation
import ImageCaptureCore

/// A PTP/MTP camera exposed by ImageCaptureCore. Mounted mass-storage cards are
/// discovered by the desktop app's filesystem adapter, never here.
public struct CameraSource: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    /// The camera's storages (card slots) when it has several; empty when it has one or they are not known yet.
    public let storages: [CameraStorage]
}

/// One storage of a camera: a top-level folder of its catalog. `id` is that folder's name, which names the same
/// slot on every connection; `name` is how people read it ("NIKON Z F [Slot 1]" -> "Slot 1").
public struct CameraStorage: Hashable, Sendable {
    public let id: String
    public let name: String
}

/// One file of a camera as the bridge lists it: its storage (card slot), the folders below that, its name, size,
/// dates and an id the bridge reads it by for as long as the session stays open.
public struct CameraFileEntry: Sendable {
    public let storage: String
    public let folder: [String]
    public let name: String
    public let size: Int64
    public let modified: Date?
    public let created: Date?
    public let objectID: String
}

public enum CameraAdapterError: LocalizedError, Sendable {
    case unavailable, storageUnavailable, disconnected, unknownFile(String), invalidRead
    public var errorDescription: String? {
        switch self {
        case .unavailable: "The camera is no longer available."
        case .storageUnavailable: "The camera card slot is no longer available."
        case .disconnected: "The camera disconnected before the transfer completed."
        case .unknownFile(let id): "The camera no longer lists the file \(id); list its files again."
        case .invalidRead: "Invalid camera read."
        }
    }
}

@MainActor
public final class DeviceDiscovery: NSObject {
    private let browser = ICDeviceBrowser()
    private var cameras: [String: ICCameraDevice] = [:]
    private var sessions: [String: CameraSession] = [:]
    private var storages: [String: [CameraStorage]] = [:]
    /// The session a camera gets when it connects, which reads its catalog once to learn its storages.
    private var probes: [String: Task<Void, Never>] = [:]

    public override init() {
        super.init()
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue)!
        browser.start()
    }

    public func stop() {
        for probe in probes.values { probe.cancel() }
        probes.removeAll()
        for session in sessions.values { session.cancel() }
        sessions.removeAll()
        storages.removeAll()
        browser.stop()
        cameras.removeAll()
    }

    /// Classified on every read: a device can mount as mass storage after it was added.
    private func isPTP(_ camera: ICCameraDevice) -> Bool {
        CameraSourceClassifier.shouldListAsPTP(transportType: camera.transportType, mountPoint: camera.mountPoint)
    }

    public var sources: [CameraSource] {
        cameras.filter { isPTP($0.value) }.map { CameraSource(id: $0.key, name: $0.value.name ?? "USB camera", storages: storages[$0.key] ?? []) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// The camera's open session, opened (and its complete catalog awaited) on first use. It stays open for the
    /// listings and reads that follow, until the camera goes away or the bridge ends.
    private func session(_ id: String) async throws -> CameraSession {
        if let open = sessions[id], open.usable { return open }
        guard let camera = cameras[id], isPTP(camera) else { throw CameraAdapterError.unavailable }
        let session = CameraSession(camera: camera)
        sessions[id] = session
        do { try await session.open() } catch { if sessions[id] === session { sessions[id] = nil }; throw error }
        storages[id] = CameraStorages.storages(in: camera.contents ?? [])
        return session
    }

    /// Opens the session of a camera that just connected, so `sources` can list each of its slots apart.
    private func probe(id: String) {
        guard probes[id] == nil else { return }
        probes[id] = Task { [weak self] in
            _ = try? await self?.session(id)
            self?.probes[id] = nil
        }
    }

    /// Every file of the camera, or with `storageID` of that storage (card slot) only, without downloading any.
    public func files(id: String, storageID: String?) async throws -> [CameraFileEntry] {
        try await session(id).files(storageID: storageID)
    }

    /// Up to `length` bytes of a listed file from `offset` (fewer only at its end), read from the camera by range.
    public func read(id: String, objectID: String, offset: Int64, length: Int64) async throws -> Data {
        try await session(id).read(objectID: objectID, offset: offset, length: length)
    }
}

extension DeviceDiscovery: @preconcurrency ICDeviceBrowserDelegate {
    public func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        // The browser's local mask excludes network devices. Mass-storage devices are listed as volumes.
        guard let camera = device as? ICCameraDevice, isPTP(camera) else { return }
        let id = camera.uuidString ?? String(describing: ObjectIdentifier(camera))
        cameras[id] = camera
        probe(id: id)
    }
    public func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        for id in cameras.filter({ $0.value === device }).map(\.key) {
            probes[id]?.cancel()
            probes[id] = nil
            sessions[id]?.didRemove(device)
            sessions[id] = nil
            storages[id] = nil
            cameras[id] = nil
        }
    }
}

/// One open PTP session on a camera. Nothing is ever downloaded to disk: files are listed from the session's catalog
/// and read by range (ICCameraFile.requestReadData), the bytes handed straight to the app, which hashes them and writes
/// new files only into the destination. Nothing on the camera is changed or deleted. ImageCaptureCore delivers device
/// delegate methods on the main thread; read completions may arrive on another queue and come back to MainActor.
@MainActor
private final class CameraSession: NSObject, @preconcurrency ICCameraDeviceDelegate {
    private let camera: ICCameraDevice
    private var ready: CheckedContinuation<Void, Error>?
    private var reads: [UUID: CheckedContinuation<Data, Error>] = [:]
    private var failure: Error?
    private var opened = false
    private var filesByID: [String: ICCameraFile] = [:]

    init(camera: ICCameraDevice) { self.camera = camera }

    var usable: Bool { opened && failure == nil && camera.hasOpenSession }

    func open() async throws {
        camera.delegate = self
        try await withCheckedThrowingContinuation { continuation in
            ready = continuation
            camera.requestOpenSession()
        }
        if let failure { throw failure }
        opened = true
    }

    func files(storageID: String?) throws -> [CameraFileEntry] {
        if let failure { throw failure }
        let contents = camera.contents ?? []
        // A slot is a top-level folder, named by its id; the camera's flat media list adds only the files in it.
        var root: ICCameraFolder?
        if let storageID {
            guard let folder = contents.compactMap({ $0 as? ICCameraFolder }).first(where: { $0.name == storageID }) else {
                throw CameraAdapterError.storageUnavailable
            }
            root = folder
        }
        var entries: [CameraFileEntry] = []
        filesByID.removeAll()
        for (index, file) in allFiles(root.map { [$0] } ?? contents, within: root).enumerated() {
            var components: [String] = []
            var parent = file.parentFolder
            while let folder = parent {
                components.insert(folder.name ?? "folder", at: 0)
                parent = folder.parentFolder
            }
            // The top folder is the storage, read as people name it ("Slot 1", as on Windows); a file outside every
            // folder is the camera's own.
            let top = components.first.map(CameraStorages.displayName).map(safeComponent) ?? "Camera"
            // The PTP object handle when the driver gives one; else the catalog position, valid while this session lasts.
            let handle = file.ptpObjectHandle
            let id = handle != 0 ? String(format: "o%X", handle) : "i\(index)"
            filesByID[id] = file
            entries.append(CameraFileEntry(storage: top, folder: components.dropFirst().map(safeComponent), name: safeComponent(file.name ?? "unnamed-\(index)"), size: Int64(file.fileSize), modified: file.modificationDate, created: file.creationDate, objectID: id))
        }
        return entries
    }

    func read(objectID: String, offset: Int64, length: Int64) async throws -> Data {
        if let failure { throw failure }
        guard offset >= 0, length >= 0, length <= 64 << 20 else { throw CameraAdapterError.invalidRead }
        guard let file = filesByID[objectID] else { throw CameraAdapterError.unknownFile(objectID) }
        // The camera's own size bounds the range; past it there is nothing to read.
        let size = Int64(file.fileSize), wanted = max(0, min(length, size - offset))
        if wanted == 0 { return Data() }
        let token = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            reads[token] = continuation
            file.requestReadData(atOffset: off_t(offset), length: off_t(wanted)) { [weak self] data, error in
                let result: Result<Data, Error> = error.map { .failure($0) } ?? .success(data ?? Data())
                Task { @MainActor in
                    guard let self, let pending = self.reads.removeValue(forKey: token) else { return }
                    pending.resume(with: result)
                }
            }
        }
    }

    /// Every file under `items`; with `within`, the camera's flat media list adds only the files in that storage.
    private func allFiles(_ items: [ICCameraItem], within root: ICCameraFolder? = nil) -> [ICCameraFile] {
        var result: [ICCameraFile] = []
        var seen = Set<ObjectIdentifier>()
        func visit(_ items: [ICCameraItem]) {
            for item in items where seen.insert(ObjectIdentifier(item)).inserted {
                if let file = item as? ICCameraFile {
                    result.append(file)
                    visit(file.sidecarFiles ?? [])
                }
                if let folder = item as? ICCameraFolder { visit(folder.contents ?? []) }
            }
        }
        visit(items)
        // Covers flat catalogs returned by camera drivers while retaining all non-media sidecars
        // exposed through the hierarchy above.
        visit((camera.mediaFiles ?? []).filter { root == nil || CameraStorages.topFolder(of: $0) === root })
        return result
    }

    private func safeComponent(_ value: String) -> String {
        let safe = value.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: "\0", with: "_")
        return safe.isEmpty || safe == "." || safe == ".." ? "unnamed" : safe
    }

    func cancel() {
        fail(CancellationError())
        if camera.hasOpenSession { camera.requestCloseSession() }
        camera.delegate = nil
    }

    func fail(_ error: Error) {
        if failure == nil { failure = error }
        let pendingReady = ready
        ready = nil
        pendingReady?.resume(throwing: error)
        let pendingReads = reads
        reads.removeAll()
        for pending in pendingReads.values { pending.resume(throwing: error) }
    }

    func didRemove(_ device: ICDevice) { fail(CameraAdapterError.disconnected) }

    func device(_ device: ICDevice, didOpenSessionWithError error: (any Error)?) {
        if let error { fail(error) }
        // Successful open precedes catalog enumeration; wait for completeContentCatalog.
    }
    func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) {
        let pending = ready
        ready = nil
        pending?.resume()
    }
    func device(_ device: ICDevice, didCloseSessionWithError error: (any Error)?) {
        opened = false
        fail(error ?? CameraAdapterError.disconnected)
    }
    func device(_ device: ICDevice, didEncounterError error: (any Error)?) { if let error { fail(error) } }
    func cameraDevice(_ camera: ICCameraDevice, didAdd items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRemove items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRenameItems items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveThumbnail thumbnail: CGImage?, for item: ICCameraItem, error: (any Error)?) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveMetadata metadata: [AnyHashable: Any]?, for item: ICCameraItem, error: (any Error)?) {}
    func cameraDeviceDidChangeCapability(_ camera: ICCameraDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceivePTPEvent eventData: Data) {}
    func cameraDeviceDidRemoveAccessRestriction(_ device: ICDevice) {}
    func cameraDeviceDidEnableAccessRestriction(_ device: ICDevice) { fail(CameraAdapterError.unavailable) }
}

/// Classifies the backend rather than comparing names or UUIDs: ImageCaptureCore may expose a
/// mass-storage device with no mountPoint and an identifier different from its mounted volume.
enum CameraSourceClassifier {
    static func shouldListAsPTP(transportType: String?, mountPoint: String?) -> Bool {
        transportType != ICDeviceTransport.transportTypeMassStorage.rawValue && mountPoint == nil
    }
}

/// A camera's storages are the top-level folders of its catalog, one per card slot. A top level that holds DCIM,
/// or files, is one storage's own contents instead: the camera is then one source.
enum CameraStorages {
    static func storages(in items: [ICCameraItem]) -> [CameraStorage] {
        let names = items.compactMap { ($0 as? ICCameraFolder)?.name }
        guard names.count == items.count, !names.contains(where: { $0.caseInsensitiveCompare("DCIM") == .orderedSame }) else { return [] }
        return names.map { CameraStorage(id: $0, name: displayName($0)) }
    }

    /// "NIKON Z F   [Slot 1]" -> "Slot 1"; otherwise the name with its spacing tidied.
    static func displayName(_ name: String) -> String {
        if let open = name.lastIndex(of: "["), let close = name[open...].firstIndex(of: "]") {
            let inner = name[name.index(after: open)..<close].trimmingCharacters(in: .whitespaces)
            if !inner.isEmpty { return inner }
        }
        let tidy = name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return tidy.isEmpty ? name : tidy
    }

    /// The top-level folder (storage) an item is in.
    static func topFolder(of item: ICCameraItem) -> ICCameraFolder? {
        var folder = item.parentFolder
        while let parent = folder?.parentFolder { folder = parent }
        return folder
    }
}
