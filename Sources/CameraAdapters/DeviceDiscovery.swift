import Foundation
import ImageCaptureCore
import IOKit

/// A PTP/MTP camera exposed by ImageCaptureCore. Mounted mass-storage cards are
/// discovered by the desktop app's filesystem adapter, never here.
public struct CameraSource: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    /// The camera's storages (card slots) with their capacity: several when its files are told apart per card, one
    /// when it has one card (or its cards cannot be told apart: then their capacity is summed); empty until known.
    public let storages: [CameraStorage]
    /// Set when the camera could not be reached in full; the app says what to do.
    public var problem: CameraProblem? = nil
    /// Its cards are being read (just connected): the app shows it as loading, not yet as a source to import.
    public var loading = false
    /// The camera's USB vendor id (0x04B0 Nikon, 0x04CB Fujifilm…), for the app's brand-specific setup hints; 0 when unknown.
    public var vendor = 0
    /// Battery level in percent, when the camera reports it (an import can stop when it runs out).
    public var battery: Int? = nil
    /// The camera's serial number: two bodies of one model stay apart.
    public var serial: String? = nil
    /// What the camera holds when its cards are not told apart (else each storage has its own).
    public var summary: CardSummary? = nil
}

/// Why a camera is listed without everything: its cards and capacity could not be read (it can still be imported as one
/// source), or its session would not open.
public enum CameraProblem: String, Sendable { case cardsUnknown, notAnswering, noCards }

/// A USB camera the system has on its bus that ImageCaptureCore has not offered for a while: it cannot be read until
/// it is turned off and on, or reconnected.
public struct UnansweredCamera: Sendable {
    public let name: String
    public let location: Int
    public let vendor: Int
}

/// One storage of a camera (a card slot). `id` names the same slot on every connection: its PTP storage id in hex
/// ("10001"), or with an older catalog the top-level folder's name; `name` is how people read it ("Slot 1").
/// `total` and `free` are the card's capacity and free space in bytes, when the camera reports them.
public struct CameraStorage: Hashable, Sendable {
    public let id: String
    public let name: String
    public var total: Int64? = nil
    public var free: Int64? = nil
    /// How many more pictures fit, as the camera estimates them.
    public var freeImages: Int? = nil
    /// What the card holds, once the camera's catalog is complete.
    public var summary: CardSummary? = nil
}

/// What a card holds, from the camera's catalog (nothing is read from the files): files and bytes per extension, and
/// the dates of its earliest and latest file. For choosing what to import and checking it fits.
public struct CardSummary: Hashable, Sendable {
    public var extensions: [String: [Int64]] = [:]
    public var first: Date? = nil
    public var last: Date? = nil
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
    /// What went wrong reaching a camera, for the app to say: its cards could not be read, or its session would not open.
    private var problems: [String: CameraProblem] = [:]
    /// How often a camera whose cards were not read in full is probed again, and when the last one began.
    private var reprobes: [String: Int] = [:]
    /// The cards each camera reported last, kept across a reconnect: shown at once when it comes back (its id is the
    /// same), and replaced as soon as the camera answers again, about 15 s later for a full Nikon Z f.
    private var lastCards: [String: [CameraStorage]] = [:]
    /// What each camera's cards hold (by card id, "all" when not told apart) and its battery, from its last complete catalog.
    private var summaries: [String: [String: CardSummary]] = [:]
    private var batteries: [String: Int] = [:]
    /// Cameras whose cards this connection has read from the camera itself (not remembered).
    private var live: Set<String> = []
    /// USB still-image devices first seen at (by USB location id), to tell a camera ImageCaptureCore never offers.
    private var usbSeen: [Int: Date] = [:]
    /// When the device browser was last started again (see unanswered).
    private var restarted = Date.distantPast

    public override init() {
        super.init()
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue)!
        browser.start()
    }

    /// Closes every session, open or still opening, and waits for the cameras to confirm, for at most `limit` seconds;
    /// then stops. A process that ends with a session open (killed) can leave the system holding it: until the camera
    /// is reconnected, it is then not offered to this app again while other apps still see it.
    public func shutdown(limit: TimeInterval = 1.5) async {
        let all = Array(sessions.values) + opening.values.map(\.session)
        trace("shutdown: closing \(all.count) session(s)")
        var left = all.count
        for session in all { Task { @MainActor in await session.close(); left -= 1 } }
        let deadline = Date().addingTimeInterval(limit)
        while left > 0, Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
        trace("shutdown: \(all.count - left) of \(all.count) closed")
        stop()
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
        cameras.filter { isPTP($0.value) }.map { entry in CameraSource(id: entry.key, name: entry.value.name ?? "USB camera", storages: (storages[entry.key] ?? []).map { card in var card = card; card.summary = summaries[entry.key]?[card.id]; return card }, problem: probes[entry.key] == nil ? problems[entry.key] : nil, loading: probes[entry.key] != nil && (storages[entry.key] ?? []).isEmpty && entry.value.capabilities.contains(ICDeviceCapability.cameraDeviceCanAcceptPTPCommands.rawValue), vendor: Int(entry.value.usbVendorID), battery: batteries[entry.key], serial: entry.value.serialNumberString.flatMap { $0.isEmpty ? nil : $0 }, summary: (storages[entry.key] ?? []).isEmpty ? summaries[entry.key]?["all"] : nil) }
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
        // The cards and their capacity show as soon as the camera reports them; the files of each follow with the catalog.
        session.onCards = { [weak self] cards in
            guard let self, self.cameras[id] != nil else { return }
            let known = self.live.contains(id) ? self.storages[id] ?? [] : []
            self.live.insert(id)
            if known.count <= cards.count, known.filter({ $0.total != nil }).count <= cards.filter({ $0.total != nil }).count {
                // Live answers replace remembered ones even when they report less (a card taken out while unplugged).
                self.storages[id] = cards.map { CameraStorage(id: $0.key, name: $0.name, total: $0.total, free: $0.free, freeImages: $0.freeImages) }
                self.lastCards[id] = self.storages[id]
                if let battery = session.battery { self.batteries[id] = battery }
                trace("cards \(id): \(cards.count) shown before the catalog is complete")
            }
        }
        let task = Task { @MainActor [weak self] in
            await self?.closing[id]?.value
            try await session.open()
            await session.learnStorages()
            self?.summaries[id] = session.summaries()
            if session.battery == nil { await session.readBattery() }
            if let battery = session.battery { self?.batteries[id] = battery }
            self?.sessions[id] = session
            // Card details learned before (a probe at connect) stay when this session could not read them again.
            // The camera answers but has no card it can read: asleep or off, in a USB mode that shows no files, or no card.
            if session.storages == nil, (camera.mediaFiles ?? []).isEmpty { self?.problems[id] = .noCards; self?.storages[id] = nil }
            else if let learned = session.storages {
                // A session that could not tell the files of several cards apart reports them as one ("all"): that never
                // replaces cards already known one by one (another session's, or this one's early read).
                let known = self?.storages[id] ?? []
                let worse = learned.count == 1 && learned[0].id == "all" && known.count > 1
                if !worse { self?.storages[id] = learned; self?.lastCards[id] = learned }
                self?.live.insert(id); self?.problems[id] = session.storagesComplete ? nil : .cardsUnknown
            }
            else if self?.storages[id]?.isEmpty ?? true { self?.storages[id] = CameraStorages.storages(in: camera.contents ?? []); self?.problems[id] = .cardsUnknown }
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
            var opened: CameraSession?
            do { opened = try await self?.session(id) } catch { trace("probe \(id): \(error)"); self?.problems[id] = .notAnswering }
            guard let self else { return }
            self.probes[id] = nil
            // A camera just connected or woken may need a moment for its cards: ask again a little later (three times at most).
            if !(opened?.storagesComplete ?? false), self.cameras[id] != nil, (self.reprobes[id] ?? 0) < 3, !self.held.contains(id) {
                self.reprobes[id, default: 0] += 1
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(8))
                    guard let self, self.cameras[id] != nil, !self.held.contains(id), self.probes[id] == nil, self.sessions[id] == nil else { return }
                    self.probe(id: id)
                }
            }
            // Its storages are known now; unless an import began meanwhile, the camera is let go again.
            // The session stays open a while for what usually follows (the app reading the newest photo's shutter count,
            // or an import): opening another would make the camera list every file again, a minute or more on a full card.
            if let opened, !self.held.contains(id), self.sessions[id] === opened {
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(90))
                    guard let self, !self.held.contains(id), self.sessions[id] === opened else { return }
                    self.end(id)
                }
            }
        }
    }

    /// USB still-image devices (interface class 6, PTP/MTP) on the bus for 35 s or more that ImageCaptureCore has not
    /// offered. The system can take about 15 s to let go of a session another process left open (a helper that was
    /// ended), so the browser is started again after 20 s and only then, if still nothing, the camera is reported.
    public func unanswered(now: Date = Date()) -> [UnansweredCamera] {
        let offered = Set(cameras.values.map { Int($0.usbLocationID) })
        let present = USBStillImage.devices()
        usbSeen = usbSeen.filter { seen in present.contains { $0.location == seen.key } }
        var result: [UnansweredCamera] = [], waiting: [String] = []
        for device in present where !offered.contains(device.location) {
            let since = usbSeen[device.location] ?? now
            usbSeen[device.location] = since
            if now.timeIntervalSince(since) >= 20 { waiting.append(device.name) }
            if now.timeIntervalSince(since) >= 35 { result.append(UnansweredCamera(name: device.name, location: device.location, vendor: device.vendor)) }
        }
        // A browser started while the system was still letting go of another app's session (this helper restarted at
        // once) can stay without devices: start it again, at most every 30 s, while a camera on USB is not offered.
        if !waiting.isEmpty, now.timeIntervalSince(restarted) >= 30 {
            restarted = now
            trace("browser: \(waiting) on USB but not offered; restarting the device browser")
            browser.stop()
            browser.start()
        }
        return result
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
        // Cards known but their files not yet told apart (the match failed while the camera was busy): try again first.
        if !open.storagesComplete { await open.learnStorages() }
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
        problems[id] = nil
        reprobes[id] = 0
        if let remembered = lastCards[id], storages[id] == nil { storages[id] = remembered; trace("cards \(id): last known shown until the camera answers") }
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
            problems[id] = nil
            reprobes[id] = nil
            live.remove(id)
            summaries[id] = nil
            batteries[id] = nil
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
            return ptpStorages.map { CameraStorage(id: $0.key, name: $0.name, total: $0.total, free: $0.free, freeImages: $0.freeImages) }
        }
        let sum = { (values: [Int64?]) in values.contains(where: { $0 == nil }) ? nil : values.compactMap { $0 }.reduce(0, +) }
        return [CameraStorage(id: "all", name: "Camera", total: sum(ptpStorages.map(\.total)), free: sum(ptpStorages.map(\.free)))]
    }

    /// One PTP request, answered with its data phase, or nil when it fails, is refused or gets no answer in 60 s. While
    /// ImageCaptureCore lists a reconnected camera's files its own requests go first (one PTP transaction at a time):
    /// a Nikon Z f with 7,900 files answered the first one after about 15 s.
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
                MainActor.assumeIsolated { self?.ptpWaits.removeValue(forKey: token)?.resume(returning: nil) }
            }
        }
    }

    /// Learns the camera's storages (GetStorageIDs, GetStorageInfo: names, capacity, free space) and, when it has
    /// several, which card each catalog folder is on (see StorageMap). Read-only PTP requests; a camera that does
    /// not answer them is listed as before.
    /// Every card read, with its capacity.
    var cardsRead: Bool { !(ptpStorages ?? []).isEmpty && ptpStorages!.allSatisfy { $0.total != nil } }
    /// Told the cards and their capacity as soon as they are read, before the catalog is complete: a camera with
    /// thousands of files can take a minute or more to list them after it is reconnected.
    var onCards: (([PTPStorage]) -> Void)?
    private var cardsAsked = false

    /// The camera's battery level in percent, when it reports one (ImageCaptureCore, else the PTP battery property).
    private(set) var battery: Int?
    func readBattery() async {
        if camera.batteryLevelAvailable { battery = Int(camera.batteryLevel); return }
        let data = await ptp(PTP.getDevicePropDesc, [PTP.batteryLevel])
        trace("battery \(camera.name ?? "?"): \(data.map { $0.map { String(format: "%02x", $0) }.joined() } ?? "no answer")")
        if let data, let percent = PTP.batteryPercent(data) { battery = percent }
    }

    /// Reads the cards once the session is open, while the catalog still loads. PTP requests are answered meanwhile.
    private func readCardsEarly() async {
        for wait in [0, 1, 2, 3, 4] {
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard failure == nil, camera.hasOpenSession, ready != nil else { return }
            await readStorages()
            if cardsRead { break }
        }
        await readBattery()
        if let cards = ptpStorages, !cards.isEmpty { onCards?(cards) }
    }

    /// Whether the camera's cards were read in full: every one with its capacity, and with several, which files are on which.
    var storagesComplete: Bool {
        guard let ptpStorages, !ptpStorages.isEmpty, ptpStorages.allSatisfy({ $0.total != nil }) else { return false }
        return ptpStorages.count == 1 || folderStorage != nil
    }

    /// Learns the cards, asking again while a camera that has just been connected or woken is still mounting them: it
    /// can answer with no storage, a storage of no capacity, or refuse (Store Not Available) for a few seconds.
    func learnStorages() async {
        guard camera.capabilities.contains(ICDeviceCapability.cameraDeviceCanAcceptPTPCommands.rawValue) else {
            trace("storages \(camera.name ?? "?"): the camera takes no PTP requests")
            return
        }
        for (attempt, wait) in [0, 1, 2, 3, 4].enumerated() {
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard failure == nil, camera.hasOpenSession else { return }
            if !cardsRead { await readStorages() }
            if battery == nil { await readBattery() }
            // Which card each folder is on needs the complete catalog, which this runs after.
            if cardsRead, let cards = ptpStorages, cards.count > 1, folderStorage == nil {
                folderStorage = await mapFolders(cards)
                trace("storages \(camera.name ?? "?"): files \(folderStorage == nil ? "not told apart" : "told apart per card")")
            }
            if storagesComplete { return }
            trace("storages \(camera.name ?? "?"): incomplete on attempt \(attempt + 1)")
        }
    }

    private func readStorages() async {
        guard let idData = await ptp(PTP.getStorageIDs, []), let ids = PTP.array(idData)?.filter(PTP.present), !ids.isEmpty else {
            trace("storages \(camera.name ?? "?"): no storage ids")
            return
        }
        var found: [PTPStorage] = []
        for (index, id) in ids.enumerated() {
            let info = await ptp(PTP.getStorageInfo, [id]).flatMap(PTP.storageInfo)
            let capacity = info.map { Int64(clamping: $0.maxCapacity) }, free = info.map { Int64(clamping: $0.freeSpace) }
            let images = info.flatMap { $0.freeImages == .max ? nil : Int($0.freeImages) }
            found.append(PTPStorage(id: id, name: PTPStorage.name(label: info?.label ?? "", description: info?.description ?? "", index: index), total: capacity.flatMap { $0 > 0 ? $0 : nil }, free: capacity.flatMap { $0 > 0 ? free : nil }, freeImages: images))
        }
        found = PTPStorage.distinctNames(found)
        // A read that came back with less than an earlier one (a card not mounted yet) does not replace it.
        if let known = ptpStorages, known.count > found.count || known.filter({ $0.total != nil }).count > found.filter({ $0.total != nil }).count { return }
        ptpStorages = found
        trace("storages \(camera.name ?? "?"): \(found.map { "\($0.key) \($0.name) \($0.total ?? -1)/\($0.free ?? -1)" })")
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
                if self.camera.hasOpenSession, !self.cardsAsked, self.camera.capabilities.contains(ICDeviceCapability.cameraDeviceCanAcceptPTPCommands.rawValue) {
                    self.cardsAsked = true
                    Task { @MainActor in await self.readCardsEarly() }
                }
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

    /// The camera said its catalog is complete (or reported 100 %). A Nikon Z f was seen to say so with 4,351 of its
    /// 7,862 files listed while ImageCaptureCore still added more, so the catalog counts as complete only once its
    /// file count has not changed for 1.5 s.
    private var settling = false
    private func becameReady() {
        guard ready != nil, !settling else { return }
        settling = true
        Task { @MainActor [weak self] in
            var last = -1, steady = 0
            while let self, self.ready != nil, steady < 3 {
                let count = self.camera.mediaFiles?.count ?? 0
                steady = count == last ? steady + 1 : 0
                last = count
                try? await Task.sleep(for: .milliseconds(500))
            }
            guard let self else { return }
            self.settling = false
            trace("ready \(self.camera.name ?? "?"): files=\(self.camera.mediaFiles?.count ?? -1) waiting=\(self.ready != nil)")
            let pending = self.ready
            self.ready = nil
            pending?.resume()
        }
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

    /// What each card holds (by its id; "all" when the cards are not told apart), from the complete catalog: files and
    /// bytes per extension, and the earliest and latest file dates a camera can have (1990 to 2100).
    func summaries() -> [String: CardSummary] {
        var result: [String: CardSummary] = [:]
        let cards = ptpStorages ?? []
        for file in allFiles(camera.contents ?? []) {
            var key = "all"
            if cards.count == 1 { key = cards[0].key }
            else if let parent = file.parentFolder, let id = folderStorage?[ObjectIdentifier(parent)], let card = cards.first(where: { $0.id == id }) { key = card.key }
            let ext = ((file.name ?? "") as NSString).pathExtension.lowercased()
            var summary = result[key] ?? CardSummary()
            var counts = summary.extensions[ext] ?? [0, 0]
            counts[0] += 1; counts[1] += Int64(file.fileSize)
            summary.extensions[ext] = counts
            if let date = file.creationDate ?? file.modificationDate, date.timeIntervalSince1970 > 631_152_000, date.timeIntervalSince1970 < 4_102_444_800 {
                summary.first = min(summary.first ?? date, date); summary.last = max(summary.last ?? date, date)
            }
            result[key] = summary
        }
        return result
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

/// USB devices with a still-image interface (class 6: PTP/MTP cameras), read from the I/O Registry.
enum USBStillImage {
    struct Device { let location: Int; let name: String; let vendor: Int }
    static func devices() -> [Device] {
        guard let matching = IOServiceMatching("IOUSBHostInterface") as NSMutableDictionary? else { return [] }
        matching["IOPropertyMatch"] = ["bInterfaceClass": 6]
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS else { return [] }
        defer { IOObjectRelease(iterator) }
        var result: [Device] = []
        while true {
            let interface = IOIteratorNext(iterator)
            if interface == 0 { break }
            defer { IOObjectRelease(interface) }
            var device: io_registry_entry_t = 0
            guard IORegistryEntryGetParentEntry(interface, kIOServicePlane, &device) == KERN_SUCCESS else { continue }
            defer { IOObjectRelease(device) }
            func property(_ key: String) -> Any? { IORegistryEntryCreateCFProperty(device, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() }
            guard let location = (property("locationID") as? NSNumber)?.intValue else { continue }
            let name = (property("USB Product Name") as? String) ?? (property("kUSBProductString") as? String) ?? "USB camera"
            let vendor = (property("idVendor") as? NSNumber)?.intValue ?? 0
            if !result.contains(where: { $0.location == location }) { result.append(Device(location: location, name: name, vendor: vendor)) }
        }
        return result
    }
}
