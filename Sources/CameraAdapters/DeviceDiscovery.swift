import Foundation
import ImageCaptureCore

/// A PTP/MTP camera exposed by ImageCaptureCore. Mounted mass-storage cards are
/// discovered by the desktop app's filesystem adapter, never here.
public struct CameraSource: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
}

/// One file of a camera as the bridge lists it: its storage (the first folder, a card slot), the folders below that,
/// its name, size, dates and an id the bridge reads it by for as long as the session stays open.
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
    case unavailable, disconnected, unknownFile(String), invalidRead
    public var errorDescription: String? {
        switch self {
        case .unavailable: "The camera is no longer available."
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

    public override init() {
        super.init()
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue)!
        browser.start()
    }

    public func stop() {
        for session in sessions.values { session.cancel() }
        sessions.removeAll()
        browser.stop()
        cameras.removeAll()
    }

    /// Classified on every read: a device can mount as mass storage after it was added.
    private func isPTP(_ camera: ICCameraDevice) -> Bool {
        CameraSourceClassifier.shouldListAsPTP(transportType: camera.transportType, mountPoint: camera.mountPoint)
    }

    public var sources: [CameraSource] {
        cameras.filter { isPTP($0.value) }.map { CameraSource(id: $0.key, name: $0.value.name ?? "USB camera") }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// The camera's open session, opened (and its complete catalog awaited) on first use. It stays open for the reads
    /// that follow, until the camera goes away or the bridge ends.
    private func session(_ id: String) async throws -> CameraSession {
        if let open = sessions[id], open.usable { return open }
        guard let camera = cameras[id], isPTP(camera) else { throw CameraAdapterError.unavailable }
        let session = CameraSession(camera: camera)
        sessions[id] = session
        do { try await session.open() } catch { if sessions[id] === session { sessions[id] = nil }; throw error }
        return session
    }

    /// Every file of the camera (or of one storage), without downloading any.
    public func files(id: String, storage: String?) async throws -> [CameraFileEntry] {
        try await session(id).files(storage: storage)
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
        cameras[camera.uuidString ?? String(describing: ObjectIdentifier(camera))] = camera
    }
    public func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        for id in cameras.filter({ $0.value === device }).map(\.key) {
            sessions[id]?.didRemove(device)
            sessions[id] = nil
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

    func files(storage: String?) throws -> [CameraFileEntry] {
        if let failure { throw failure }
        var entries: [CameraFileEntry] = []
        filesByID.removeAll()
        for (index, file) in allFiles(camera.contents ?? []).enumerated() {
            var components: [String] = []
            var parent = file.parentFolder
            while let folder = parent {
                components.insert(safeComponent(folder.name ?? "folder"), at: 0)
                parent = folder.parentFolder
            }
            // The top folder of a PTP catalog is the storage (card slot); a file outside every folder is the camera's own.
            let top = components.first ?? "Camera"
            if let storage, storage != top { continue }
            // The PTP object handle when the driver gives one; else the catalog position, valid while this session lasts.
            let handle = file.ptpObjectHandle
            let id = handle != 0 ? String(format: "o%X", handle) : "i\(index)"
            filesByID[id] = file
            entries.append(CameraFileEntry(storage: top, folder: Array(components.dropFirst()), name: safeComponent(file.name ?? "unnamed-\(index)"), size: Int64(file.fileSize), modified: file.modificationDate, created: file.creationDate, objectID: id))
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

    private func allFiles(_ items: [ICCameraItem]) -> [ICCameraFile] {
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
        visit(camera.mediaFiles ?? [])
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
