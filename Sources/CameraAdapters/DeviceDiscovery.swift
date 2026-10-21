import Foundation
import ImageCaptureCore

/// A PTP/MTP camera exposed by ImageCaptureCore. Mounted mass-storage cards are
/// discovered by the desktop app's filesystem adapter, never here.
public struct CameraSource: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
}

public enum CameraAdapterError: LocalizedError, Sendable {
    case unavailable, busy, disconnected, missingDownload(String), unsafeDownloadPath(String), sizeMismatch(String, expected: Int64, actual: Int64)
    public var errorDescription: String? {
        switch self {
        case .unavailable: "The camera is no longer available."
        case .busy: "An import is already running for this camera."
        case .disconnected: "The camera disconnected before the transfer completed."
        case .missingDownload(let name): "The camera did not save the requested file: \(name)."
        case .unsafeDownloadPath(let name): "The camera returned an invalid download path: \(name)."
        case .sizeMismatch(let name, let expected, let actual): "The downloaded file \(name) has \(actual) bytes; the camera reported \(expected)."
        }
    }
}

@MainActor
public final class DeviceDiscovery: NSObject {
    private let browser = ICDeviceBrowser()
    private var cameras: [String: ICCameraDevice] = [:]
    private var active: [String: CameraTransfer] = [:]

    public override init() {
        super.init()
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue)!
        browser.start()
    }

    public func stop() {
        for transfer in active.values { transfer.cancel() }
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

    /// Opens a PTP session, waits for its complete catalog, and downloads every exposed file.
    /// The returned directory is unique, allowing callers to remove it after a successful import.
    /// A failed transfer leaves its partial directory in place for inspection/recovery.
    public func stageCamera(id: String, to directory: URL, progress: @escaping @Sendable (Int, Int) -> Void) async throws -> URL {
        guard let camera = cameras[id], isPTP(camera) else { throw CameraAdapterError.unavailable }
        guard active[id] == nil else { throw CameraAdapterError.busy }
        let transfer = CameraTransfer(camera: camera)
        active[id] = transfer
        defer { active[id] = nil }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await transfer.run(to: directory) { completed, total in progress(completed, total) }
        } onCancel: {
            Task { @MainActor in transfer.cancel() }
        }
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
            active[id]?.didRemove(device)
            cameras[id] = nil
        }
    }
}

/// ImageCaptureCore delivers device delegate methods on the main thread. Only the download
/// completion may arrive on another queue; it passes a Sendable result back to MainActor.
@MainActor
private final class CameraTransfer: NSObject, @preconcurrency ICCameraDeviceDelegate {
    private let camera: ICCameraDevice
    private var ready: CheckedContinuation<Void, Error>?
    private var download: CheckedContinuation<String, Error>?
    private var closed: CheckedContinuation<Void, Never>?
    private var failure: Error?
    private var opening = false
    private var disconnected = false
    private var closeTimeout: Task<Void, Never>?

    init(camera: ICCameraDevice) { self.camera = camera }

    func run(to directory: URL, progress: @escaping @MainActor (Int, Int) -> Void) async throws -> URL {
        let staging = directory.appendingPathComponent("camera-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        camera.delegate = self
        do {
            try await withCheckedThrowingContinuation { continuation in
                ready = continuation
                opening = true
                camera.requestOpenSession()
            }
            try checkFailure()
            let files = allFiles(camera.contents ?? [])
            progress(0, files.count)
            var usedPaths = Set<String>()
            for (index, file) in files.enumerated() {
                try checkFailure()
                var components: [String] = []
                var parent = file.parentFolder
                while let folder = parent {
                    components.insert(safeComponent(folder.name ?? "folder"), at: 0)
                    parent = folder.parentFolder
                }
                var folder = components.reduce(staging) { $0.appendingPathComponent($1, isDirectory: true) }
                let name = safeComponent(file.name ?? "unnamed-\(index)")
                let proposed = normalizedPath(folder.appendingPathComponent(name))
                // Some cameras expose duplicate names/paths. Preserve each without overwriting.
                if !usedPaths.insert(proposed).inserted {
                    folder = folder.appendingPathComponent("duplicate-\(index)-\(UUID().uuidString)", isDirectory: true)
                }
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let saved = try await downloadFile(file, directory: folder, name: name)
                try checkFailure()
                guard saved == safeComponent(saved) else { throw CameraAdapterError.unsafeDownloadPath(saved) }
                let savedURL = folder.appendingPathComponent(saved).resolvingSymlinksInPath().standardizedFileURL
                let stagingPath = staging.resolvingSymlinksInPath().standardizedFileURL.path
                guard savedURL.path.hasPrefix(stagingPath + "/") else { throw CameraAdapterError.unsafeDownloadPath(saved) }
                let values = try savedURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard values.isRegularFile == true else { throw CameraAdapterError.missingDownload(name) }
                let actualSize = Int64(values.fileSize ?? -1)
                if file.fileSize > 0, actualSize != file.fileSize {
                    throw CameraAdapterError.sizeMismatch(name, expected: file.fileSize, actual: actualSize)
                }
                var attributes: [FileAttributeKey: Any] = [:]
                if let date = file.creationDate { attributes[.creationDate] = date }
                if let date = file.modificationDate { attributes[.modificationDate] = date }
                if !attributes.isEmpty { try FileManager.default.setAttributes(attributes, ofItemAtPath: savedURL.path) }
                progress(index + 1, files.count)
            }
            await close()
            camera.delegate = nil
            return staging
        } catch {
            await close()
            camera.delegate = nil
            throw error
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

    private func normalizedPath(_ url: URL) -> String {
        url.standardizedFileURL.path.precomposedStringWithCanonicalMapping
            .folding(options: [.caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }

    private func safeComponent(_ value: String) -> String {
        let safe = value.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "\0", with: "_")
        return safe.isEmpty || safe == "." || safe == ".." ? "unnamed" : safe
    }

    private func downloadFile(_ file: ICCameraFile, directory: URL, name: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            download = continuation
            file.requestDownload(options: [
                .downloadsDirectoryURL: directory,
                .saveAsFilename: name,
                .overwrite: false,
                .deleteAfterSuccessfulDownload: false,
                .sidecarFiles: false
            ]) { [weak self] filename, error in
                let result: Result<String, Error> = error.map { .failure($0) } ?? .success(filename ?? name)
                Task { @MainActor in
                    guard let self, let pending = self.download else { return }
                    self.download = nil
                    pending.resume(with: result)
                }
            }
        }
    }

    private func checkFailure() throws {
        if let failure { throw failure }
        try Task.checkCancellation()
    }

    func cancel() {
        camera.cancelDownload()
        fail(CancellationError())
    }

    func fail(_ error: Error) {
        if failure == nil { failure = error }
        let pendingReady = ready
        ready = nil
        pendingReady?.resume(throwing: error)
        let pendingDownload = download
        download = nil
        pendingDownload?.resume(throwing: error)
    }

    private func close() async {
        guard !disconnected, camera.hasOpenSession || opening else { return }
        await withCheckedContinuation { continuation in
            closed = continuation
            camera.requestCloseSession()
            // Cancellation during an outstanding open may never produce a close callback.
            // Bound cleanup so a missing driver callback cannot hold the import task forever.
            closeTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                self?.finishClose()
            }
        }
    }

    private func finishClose() {
        closeTimeout?.cancel()
        closeTimeout = nil
        let pending = closed
        closed = nil
        pending?.resume()
    }

    func device(_ device: ICDevice, didOpenSessionWithError error: (any Error)?) {
        opening = false
        if let error { fail(error) }
        // Successful open precedes catalog enumeration; wait for completeContentCatalog.
    }
    func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) {
        let pending = ready
        ready = nil
        pending?.resume()
    }
    func device(_ device: ICDevice, didCloseSessionWithError error: (any Error)?) {
        opening = false
        if ready != nil || download != nil { fail(error ?? CameraAdapterError.disconnected) }
        finishClose()
    }
    func didRemove(_ device: ICDevice) {
        disconnected = true
        fail(CameraAdapterError.disconnected)
        finishClose()
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
