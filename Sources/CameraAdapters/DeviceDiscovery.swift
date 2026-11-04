import Foundation
import ImageCaptureCore

/// A PTP/MTP camera exposed by ImageCaptureCore. Mounted mass-storage cards are
/// discovered by the desktop app's filesystem adapter, never here.
public struct CameraSource: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    /// The camera's storages (card slots) with their capacity: several when its files are told apart per card, one
    /// when it has one card (or its cards cannot be told apart: then their capacity is summed); empty until known.
    public let storages: [CameraStorage]
}

/// One storage of a camera (a card slot). `id` names the same slot on every connection: its PTP storage id in hex
/// ("10001"), or with an older catalog the top-level folder's name; `name` is how people read it ("Slot 1").
/// `total` and `free` are the card's capacity and free space in bytes, when the camera reports them.
public struct CameraStorage: Hashable, Sendable {
    public let id: String
    public let name: String
    public var total: Int64? = nil
    public var free: Int64? = nil
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

/// With IMPORTER_CAMERA_DEBUG set, what the camera sessions do goes to stderr (the app keeps its last lines in errors).
let cameraDebug = ProcessInfo.processInfo.environment["IMPORTER_CAMERA_DEBUG"] != nil
func trace(_ text: @autoclosure () -> String) {
    guard cameraDebug else { return }
    FileHandle.standardError.write(Data("[camera \(String(format: "%.2f", ProcessInfo.processInfo.systemUptime))] \(text())\n".utf8))
}

public enum CameraAdapterError: LocalizedError, Sendable {
    case unavailable, storageUnavailable, disconnected, unknownFile(String), invalidRead, notAnswering, readTimedOut
    public var errorDescription: String? {
        switch self {
        case .unavailable: "The camera is no longer available."
        case .storageUnavailable: "The camera card slot is no longer available."
        case .disconnected: "The camera disconnected before the transfer completed."
        case .unknownFile(let id): "The camera no longer lists the file \(id); list its files again."
        case .invalidRead: "Invalid camera read."
        case .notAnswering: "The camera stopped answering. Make sure it is on and awake, that no other app (Photos, Image Capture, Lightroom) is importing from it, then unplug it and plug it in again."
        case .readTimedOut: "The camera did not send the file in time. Make sure it is on and awake, then try again."
        }
    }
}

@MainActor
public final class DeviceDiscovery: NSObject {
    private let browser = ICDeviceBrowser()
    private var cameras: [String: ICCameraDevice] = [:]
    private var sessions: [String: CameraSession] = [:]
    /// A session being opened: everything that needs the camera meanwhile waits for this one, never opens a second.
    private var opening: [String: (session: CameraSession, task: Task<Void, Error>)] = [:]
    /// A session being closed: the next open waits until the camera has let it go.
    private var closing: [String: Task<Void, Never>] = [:]
    private var storages: [String: [CameraStorage]] = [:]
    /// The session a camera gets when it connects, which reads its catalog once to learn its storages.
    private var probes: [String: Task<Void, Never>] = [:]
    /// Cameras an import is reading: their session stays open from "files" until "close".
    private var held: Set<String> = []

    public override init() {
        super.init()
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue)!
        browser.start()
    }

    public func stop() {
        for probe in probes.values { probe.cancel() }
        probes.removeAll()
        for pending in opening.values { pending.task.cancel(); pending.session.cancel() }
        opening.removeAll()
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
    /// listings and reads that follow, until the app closes it, the camera goes away or the bridge ends. Callers that
    /// arrive while it opens share that one opening: a second session would take the camera's delegate from the first.
    private func session(_ id: String, progress: ((Int) -> Void)? = nil) async throws -> CameraSession {
        if let open = sessions[id], open.usable { return open }
        if let pending = opening[id] {
            if let progress { pending.session.listen(progress) }
            try await pending.task.value
            return pending.session
        }
        guard let camera = cameras[id], isPTP(camera) else { throw CameraAdapterError.unavailable }
        let session = CameraSession(camera: camera)
        if let progress { session.listen(progress) }
        let task = Task { @MainActor [weak self] in
            await self?.closing[id]?.value
            try await session.open()
            await session.learnStorages()
            self?.sessions[id] = session
            self?.storages[id] = session.storages ?? CameraStorages.storages(in: camera.contents ?? [])
        }
        opening[id] = (session, task)
        defer { if opening[id]?.session === session { opening[id] = nil } }
        try await task.value
        return session
    }

    /// Opens the session of a camera that just connected, so `sources` can list each of its slots apart.
    private func probe(id: String) {
        guard probes[id] == nil else { return }
        probes[id] = Task { [weak self] in
            let opened = try? await self?.session(id)
            guard let self else { return }
            self.probes[id] = nil
            // Its storages are known now; unless an import began meanwhile, the camera is let go again.
            if let opened, !self.held.contains(id), self.sessions[id] === opened { self.end(id) }
        }
    }

    /// The app's imports of the camera ended: its session closes (a later "files" opens a new one).
    public func close(id: String) {
        held.remove(id)
        end(id)
    }

    private func end(_ id: String) {
        guard let session = sessions.removeValue(forKey: id) else { return }
        let previous = closing[id]
        let task = Task { @MainActor in
            await previous?.value
            await session.close()
        }
        closing[id] = task
        Task { @MainActor [weak self] in
            await task.value
            if self?.closing[id] == task { self?.closing[id] = nil }
        }
    }

    /// Every file of the camera, or with `storageID` of that storage (card slot) only, without downloading any.
    /// `progress` hears how many files the camera has listed so far while its catalog loads.
    public func files(id: String, storageID: String?, progress: ((Int) -> Void)? = nil) async throws -> [CameraFileEntry] {
        held.insert(id)
        let open = try await session(id, progress: progress)
        trace("files: session ready, listing")
        let list = try open.files(storageID: storageID)
        trace("files: \(list.count) listed")
        return list
    }

    /// Up to `length` bytes of a listed file from `offset` (fewer only at its end), read from the camera by range.
    public func read(id: String, objectID: String, offset: Int64, length: Int64) async throws -> Data {
        guard let open = sessions[id], open.usable else { throw CameraAdapterError.unknownFile(objectID) }
        return try await open.read(objectID: objectID, offset: offset, length: length)
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
            opening[id]?.session.didRemove(device)
            sessions[id]?.didRemove(device)
            sessions[id] = nil
            held.remove(id)
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
    /// How long a camera may go without listing another file, or saying its catalog is complete, before it counts as not answering.
    static let quiet: TimeInterval = 45
    /// How long one range read may take.
    static let readLimit: TimeInterval = 90
    private let camera: ICCameraDevice
    private var ready: CheckedContinuation<Void, Error>?
    private var reads: [UUID: CheckedContinuation<Data, Error>] = [:]
    private var failure: Error?
    private var opened = false
    private var filesByID: [String: ICCameraFile] = [:]
    /// The camera's storages over PTP, and for a camera with several cards whose files are told apart, the card each
    /// catalog folder is on. Nil until learned, or when the camera does not answer PTP requests.
    private var ptpStorages: [PTPStorage]?
    private var folderStorage: [ObjectIdentifier: UInt32]?
    private var ptpWaits: [UUID: CheckedContinuation<Data?, Never>] = [:]
    private var transaction: UInt32 = 0x4000_0000

    /// The storages as the app lists them: one per card when the files are told apart, else one with their capacity summed.
    var storages: [CameraStorage]? {
        guard let ptpStorages, !ptpStorages.isEmpty else { return nil }
        if folderStorage != nil || ptpStorages.count == 1 {
            return ptpStorages.map { CameraStorage(id: $0.key, name: $0.name, total: $0.total, free: $0.free) }
        }
        let sum = { (values: [Int64?]) in values.contains(where: { $0 == nil }) ? nil : values.compactMap { $0 }.reduce(0, +) }
        return [CameraStorage(id: "all", name: "Camera", total: sum(ptpStorages.map(\.total)), free: sum(ptpStorages.map(\.free)))]
    }

    /// One PTP request, answered with its data phase, or nil when it fails, is refused or gets no answer in 15 s.
    private func ptp(_ code: UInt16, _ parameters: [UInt32]) async -> Data? {
        guard camera.hasOpenSession, failure == nil else { return nil }
        transaction &+= 1
        let request = PTP.command(code, parameters, transaction: transaction)
        let token = UUID()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            ptpWaits[token] = continuation
            camera.requestSendPTPCommand(request, outData: nil) { [weak self] data, response, error in
                let answer = error == nil && PTP.responseCode(response) == PTP.ok ? data : nil
                Task { @MainActor in self?.ptpWaits.removeValue(forKey: token)?.resume(returning: answer) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
                MainActor.assumeIsolated { self?.ptpWaits.removeValue(forKey: token)?.resume(returning: nil) }
            }
        }
    }

    /// Learns the camera's storages (GetStorageIDs, GetStorageInfo: names, capacity, free space) and, when it has
    /// several, which card each catalog folder is on (see StorageMap). Read-only PTP requests; a camera that does
    /// not answer them is listed as before.
    func learnStorages() async {
        guard camera.capabilities.contains(ICDeviceCapability.cameraDeviceCanAcceptPTPCommands.rawValue),
              let idData = await ptp(PTP.getStorageIDs, []), let ids = PTP.array(idData)?.filter(PTP.present), !ids.isEmpty else {
            trace("storages \(camera.name ?? "?"): not available over PTP")
            return
        }
        var found: [PTPStorage] = []
        for (index, id) in ids.enumerated() {
            let info = await ptp(PTP.getStorageInfo, [id]).flatMap(PTP.storageInfo)
            let capacity = info.map { Int64(clamping: $0.maxCapacity) }, free = info.map { Int64(clamping: $0.freeSpace) }
            found.append(PTPStorage(id: id, name: PTPStorage.name(label: info?.label ?? "", description: info?.description ?? "", index: index), total: capacity.flatMap { $0 > 0 ? $0 : nil }, free: capacity.flatMap { $0 > 0 ? free : nil }))
        }
        ptpStorages = found
        trace("storages \(camera.name ?? "?"): \(found.map { "\($0.key) \($0.name) \($0.total ?? -1)/\($0.free ?? -1)" })")
        guard found.count > 1 else { return }
        folderStorage = await mapFolders(found)
        trace("storages \(camera.name ?? "?"): files \(folderStorage == nil ? "not told apart" : "told apart per card")")
    }

    /// Which card each folder of the catalog is on, from the folders the camera lists per storage; nil when any
    /// folder cannot be placed (the camera then stays one source).
    private func mapFolders(_ storages: [PTPStorage]) async -> [ObjectIdentifier: UInt32]? {
        var ptpFolders: [PTPFolder] = []
        var children: [UInt32: [UInt32]] = [:]
        for storage in storages {
            // The folders only (format filter): a few, where all objects would be thousands.
            guard let data = await ptp(PTP.getObjectHandles, [storage.id, UInt32(PTP.association), 0]),
                  let handles = PTP.array(data), handles.count <= 5000 else { return nil }
            var info: [UInt32: PTP.ObjectInfo] = [:]
            for handle in handles {
                guard let object = await ptp(PTP.getObjectInfo, [handle]).flatMap(PTP.objectInfo) else { return nil }
                // A camera that ignores the format filter lists files too: only folders count here.
                if object.format == PTP.association { info[handle] = object }
            }
            for (handle, object) in info {
                var parts = [object.name], parent = object.parent, depth = 0
                while parent != 0, parent != 0xFFFF_FFFF, let up = info[parent], depth < 32 { parts.insert(up.name, at: 0); parent = up.parent; depth += 1 }
                guard let data = await ptp(PTP.getObjectHandles, [storage.id, 0, handle]), let inside = PTP.array(data) else { return nil }
                let files = inside.filter { info[$0] == nil }
                children[handle] = files
                ptpFolders.append(PTPFolder(storage: storage.id, handle: handle, path: parts.joined(separator: "/"), files: files.count))
            }
        }
        // A few files of each folder whose path is on several cards: first, middle and last.
        var samples: [UInt32: [String]] = [:]
        let shared = StorageMap.shared(ptpFolders)
        for folder in ptpFolders where shared.contains(folder.path) {
            let files = children[folder.handle] ?? []
            var picked: [String] = []
            for handle in Set([files.first, files.dropFirst(files.count / 2).first, files.last].compactMap { $0 }) {
                if let object = await ptp(PTP.getObjectInfo, [handle]).flatMap(PTP.objectInfo) { picked.append(CatalogFolder.entry(name: object.name, size: Int64(object.size))) }
            }
            samples[folder.handle] = picked
        }
        // The catalog's folders that hold files, as objects (one per card even where their paths are the same).
        var catalogByObject: [ObjectIdentifier: (folder: ICCameraFolder, names: Set<String>)] = [:]
        for case let file as ICCameraFile in camera.mediaFiles ?? [] {
            guard let parent = file.parentFolder else { return nil }
            // PTP reports sizes in 32 bits; a file over 4 GB is compared by name only through its folder's other files.
            catalogByObject[ObjectIdentifier(parent), default: (parent, [])].names.insert(CatalogFolder.entry(name: file.name ?? "", size: Int64(file.fileSize) & 0xFFFF_FFFF))
        }
        let keys = Array(catalogByObject.keys)
        let catalog = keys.enumerated().map { index, key in CatalogFolder(key: index, path: Self.path(of: catalogByObject[key]!.folder), names: catalogByObject[key]!.names) }
        guard let assigned = StorageMap.assign(catalog: catalog, ptp: ptpFolders, samples: samples) else { return nil }
        return Dictionary(uniqueKeysWithValues: assigned.map { (keys[$0.key], $0.value) })
    }

    private static func path(of folder: ICCameraFolder) -> String {
        var parts: [String] = []
        var current: ICCameraFolder? = folder
        while let item = current { parts.insert(item.name ?? "", at: 0); current = item.parentFolder }
        return parts.joined(separator: "/")
    }
    /// Told how many files the camera has listed while its catalog loads: everyone waiting for this session to open.
    private var listeners: [(Int) -> Void] = []

    init(camera: ICCameraDevice) { self.camera = camera }

    func listen(_ progress: @escaping (Int) -> Void) { listeners.append(progress) }

    var usable: Bool { opened && failure == nil && camera.hasOpenSession }

    /// The catalog is complete: the camera said so, or it reports every item listed (a ready event can be missed when
    /// the session was already open).
    private var complete: Bool { camera.hasOpenSession && camera.contentCatalogPercentCompleted >= 100 }

    func open() async throws {
        camera.delegate = self
        // Checked twice a second: the catalog's growth (sent as progress) and its completion, and a camera that goes
        // quiet for too long while it opens, which then counts as not answering instead of hanging the app.
        var listed = -1, lastChange = Date()
        let watch = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.ready != nil else { return }
                let count = (self.camera.mediaFiles?.count ?? 0) + Int(self.camera.contentCatalogPercentCompleted)
                trace("watch \(self.camera.name ?? "?"): open=\(self.camera.hasOpenSession) files=\(self.camera.mediaFiles?.count ?? -1) catalog=\(self.camera.contentCatalogPercentCompleted)%")
                if count != listed { listed = count; lastChange = Date(); for listener in self.listeners { listener(self.camera.mediaFiles?.count ?? 0) } }
                if self.complete { self.becameReady() }
                else if Date().timeIntervalSince(lastChange) > Self.quiet { self.fail(CameraAdapterError.notAnswering) }
            }
        }
        defer { watch.invalidate() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            ready = continuation
            trace("open \(camera.name ?? "?"): open=\(camera.hasOpenSession) catalog=\(camera.contentCatalogPercentCompleted)%")
            if complete { becameReady(); return }
            camera.requestOpenSession(options: nil) { [weak self] error in
                guard let error else { return }
                Task { @MainActor in self?.fail(error) }
            }
        }
        trace("open returned \(camera.name ?? "?"): failure=\(String(describing: failure))")
        if let failure { throw failure }
        opened = true
    }

    private func becameReady() {
        trace("ready \(camera.name ?? "?"): files=\(camera.mediaFiles?.count ?? -1) waiting=\(ready != nil)")
        let pending = ready
        ready = nil
        pending?.resume()
    }

    func files(storageID: String?) throws -> [CameraFileEntry] {
        if let failure { throw failure }
        let contents = camera.contents ?? []
        // Cards known over PTP: each file goes under its card's name, and with `storageID` only that card's files.
        if let ptpStorages, folderStorage != nil || ptpStorages.count == 1 {
            return try filesByCard(ptpStorages, storageID: storageID)
        }
        // Else a slot is a top-level folder, named by its id; the camera's flat media list adds only the files in it.
        var root: ICCameraFolder?
        if let storageID, storageID != "all" {
            guard let folder = contents.compactMap({ $0 as? ICCameraFolder }).first(where: { $0.name == storageID }) else {
                throw CameraAdapterError.storageUnavailable
            }
            root = folder
        }
        var entries: [CameraFileEntry] = []
        var taken = Set<String>()
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
            let name = safeComponent(file.name ?? "unnamed-\(index)")
            // The PTP object handle when the driver gives one; else the file's place in the catalog (folders and name),
            // which stays the same across listings of this session, one slot or all (Fujifilm cameras give no handle).
            let handle = file.ptpObjectHandle
            var id = handle != 0 ? String(format: "o%X", handle) : "p" + (components + [file.name ?? "unnamed"]).joined(separator: "/")
            if !taken.insert(id).inserted { id += "#\(index)"; taken.insert(id) }
            // Kept across listings: listing one slot leaves the files of another readable.
            filesByID[id] = file
            entries.append(CameraFileEntry(storage: top, folder: components.dropFirst().map(safeComponent), name: name, size: Int64(file.fileSize), modified: file.modificationDate, created: file.creationDate, objectID: id))
        }
        return entries
    }

    /// The files of each card (or of `storageID`'s only), under the card's name and their whole folder path
    /// ("Slot 1" / DCIM/102NZF__ / name), as the Windows bridge lists them.
    private func filesByCard(_ cards: [PTPStorage], storageID: String?) throws -> [CameraFileEntry] {
        let wanted: PTPStorage?
        if let storageID, storageID != "all" {
            guard let card = cards.first(where: { $0.key == storageID }) else { throw CameraAdapterError.storageUnavailable }
            wanted = card
        } else { wanted = nil }
        var entries: [CameraFileEntry] = []
        var taken = Set<String>()
        for (index, file) in allFiles(camera.contents ?? []).enumerated() {
            let card: PTPStorage
            if cards.count == 1 { card = cards[0] }
            else {
                guard let parent = file.parentFolder, let id = folderStorage?[ObjectIdentifier(parent)], let match = cards.first(where: { $0.id == id }) else { continue }
                card = match
            }
            if let wanted, wanted.id != card.id { continue }
            var components: [String] = []
            var parent = file.parentFolder
            while let folder = parent { components.insert(folder.name ?? "folder", at: 0); parent = folder.parentFolder }
            let handle = file.ptpObjectHandle
            var id = handle != 0 ? String(format: "o%X", handle) : "p\(card.key)/" + (components + [file.name ?? "unnamed"]).joined(separator: "/")
            if !taken.insert(id).inserted { id += "#\(index)"; taken.insert(id) }
            filesByID[id] = file
            entries.append(CameraFileEntry(storage: safeComponent(card.name), folder: components.map(safeComponent), name: safeComponent(file.name ?? "unnamed-\(index)"), size: Int64(file.fileSize), modified: file.modificationDate, created: file.creationDate, objectID: id))
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
            // A range the camera never sends fails this read only; the app retries or reports the file.
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.readLimit) { [weak self] in
                MainActor.assumeIsolated { self?.reads.removeValue(forKey: token)?.resume(throwing: CameraAdapterError.readTimedOut) }
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

    /// Ends the session and waits until the camera has closed it, so a session opened next starts on a free camera.
    func close() async {
        trace("close \(camera.name ?? "?")")
        fail(CancellationError())
        if camera.hasOpenSession {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                closed = continuation
                camera.requestCloseSession(options: nil) { [weak self] _ in Task { @MainActor in self?.finishClose() } }
                // A camera unplugged meanwhile may never answer.
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in MainActor.assumeIsolated { self?.finishClose() } }
            }
        }
        if camera.delegate === self { camera.delegate = nil }
    }

    private var closed: CheckedContinuation<Void, Never>?
    private func finishClose() {
        let pending = closed
        closed = nil
        pending?.resume()
    }

    func cancel() {
        fail(CancellationError())
        if camera.hasOpenSession { camera.requestCloseSession(options: nil) { _ in } }
        if camera.delegate === self { camera.delegate = nil }
    }

    func fail(_ error: Error) {
        let pendingPTP = ptpWaits
        ptpWaits.removeAll()
        for pending in pendingPTP.values { pending.resume(returning: nil) }
        trace("fail \(camera.name ?? "?"): \(error)")
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
    func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) { becameReady() }
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
