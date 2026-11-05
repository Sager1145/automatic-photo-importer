import Foundation

/// One storage (card slot) as the camera reports it over PTP (GetStorageInfo): its id, the name people read
/// ("NIKON Z F   [Slot 1]" -> "Slot 1") and its capacity and free space in bytes when the camera gives them.
public struct PTPStorage: Hashable, Sendable {
    public let id: UInt32
    public let name: String
    public let total: Int64?
    public let free: Int64?
    /// How many more pictures fit, as the camera estimates them; nil when it does not say.
    public var freeImages: Int? = nil
    /// The id the app keeps for this slot: the PTP storage id in hex ("10001" for Slot 1, "20001" for Slot 2), as the
    /// Windows bridge names it from WPD's "SID-{10001,...}", so a slot is the same source on every connection.
    public var key: String { String(id, radix: 16, uppercase: true) }

    public init(id: UInt32, name: String, total: Int64?, free: Int64?, freeImages: Int? = nil) {
        self.id = id; self.name = name; self.total = total; self.free = free; self.freeImages = freeImages
    }

    /// Card labels cameras and computers give every card alike, which name no card: Canon formats each card as
    /// EOS_DIGITAL, others leave NO NAME or Untitled.
    static let genericLabels: Set<String> = ["EOS_DIGITAL", "NO NAME", "NONAME", "UNTITLED", "LUMIX", "CANON", "NIKON", "SONY", "FUJIFILM", "OLYMPUS", "OM SYSTEM", "PENTAX", "RICOH", "LEICA", "GOPRO", "DJI", "INSTA360", "SIGMA", "HASSELBLAD", "CARD", "SD", "DCIM"]

    /// The name from a storage's label and description: the bracketed slot of a label ("Slot 1"), else the label,
    /// else the description ("External Memory"); labels that are only zeros, blank or generic (EOS_DIGITAL) are not names.
    public static func name(label: String, description: String, index: Int) -> String {
        let meaningful = { (text: String, isLabel: Bool) -> String? in
            let tidy = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if tidy.contains("["), tidy.contains("]") { return tidy }
            return tidy.isEmpty || tidy.allSatisfy({ $0 == "0" }) || isLabel && genericLabels.contains(tidy.uppercased()) ? nil : tidy
        }
        if let label = meaningful(label, true) { return CameraStorages.displayName(label) }
        if let description = meaningful(description, false) { return CameraStorages.displayName(description) }
        return "Card \(index + 1)"
    }
}

extension PTPStorage {
    /// Cards whose names repeat (two cards both "SD", or both labelled alike) are named by their physical slot instead:
    /// a PTP storage id's high 16 bits number the slot ("Slot 1" for 0x00010001, "Slot 2" for 0x00020001).
    public static func distinctNames(_ cards: [PTPStorage]) -> [PTPStorage] {
        let names = cards.map(\.name)
        guard Set(names).count < names.count else { return cards }
        return cards.enumerated().map { index, card in
            let slot = card.id >> 16
            return PTPStorage(id: card.id, name: slot > 0 ? "Slot \(slot)" : "Card \(index + 1)", total: card.total, free: card.free, freeImages: card.freeImages)
        }
    }
}

/// A folder of the camera as PTP lists it on one storage: its path from the storage's root ("DCIM/102NZF__") and how
/// many files (not folders) are directly in it.
public struct PTPFolder: Hashable, Sendable {
    public let storage: UInt32
    public let handle: UInt32
    public let path: String
    public let files: Int
    public init(storage: UInt32, handle: UInt32, path: String, files: Int) {
        self.storage = storage; self.handle = handle; self.path = path; self.files = files
    }
}

/// A folder of ImageCaptureCore's catalog that holds files: one object per folder per card, even where the catalog
/// merges both cards under one DCIM (a Nikon Z f: two "DCIM/102NZF__" objects, one per slot). `key` names it for the
/// caller; `names` are its files as "name|size".
public struct CatalogFolder: Hashable, Sendable {
    public let key: Int
    public let path: String
    public let names: Set<String>
    public init(key: Int, path: String, names: Set<String>) { self.key = key; self.path = path; self.names = names }
    public static func entry(name: String, size: Int64) -> String { "\(name)|\(size)" }
}

/// Which card each catalog folder is on. ImageCaptureCore gives no storage per file (and on recent macOS no PTP
/// handle either), so its folders are matched to the folders the camera lists per storage: a path only one card has
/// is that card's; a path on several cards goes by its number of files, and where that is equal too, by a few file
/// names and sizes the camera reports for each candidate (`samples`, fetched only for those). Nothing is guessed:
/// when any folder cannot be placed on exactly one card, the result is nil and the camera stays one source, so no
/// file is ever left out of a listing.
public enum StorageMap {
    /// Paths that appear on more than one storage: only their folders need samples.
    public static func shared(_ folders: [PTPFolder]) -> Set<String> {
        var storagesByPath: [String: Set<UInt32>] = [:]
        for folder in folders { storagesByPath[folder.path, default: []].insert(folder.storage) }
        return Set(storagesByPath.filter { $0.value.count > 1 }.keys)
    }

    public static func assign(catalog: [CatalogFolder], ptp: [PTPFolder], samples: [UInt32: [String]]) -> [Int: UInt32]? {
        var result: [Int: UInt32] = [:]
        var taken = Set<UInt32>()
        // Folders whose path is on one card first, then the shared ones, the most files first.
        let ordered = catalog.sorted { ($0.path, -$0.names.count) < ($1.path, -$1.names.count) }
        for folder in ordered {
            let candidates = ptp.filter { $0.path == folder.path && !taken.contains($0.handle) }
            var chosen: PTPFolder?
            if candidates.count == 1 {
                chosen = candidates[0]
            } else if candidates.count > 1 {
                // Every sampled file of the camera's folder is in this catalog folder (a camera can list files the
                // catalog leaves out, so a count is only a tie-breaker).
                let matching = candidates.filter { candidate in
                    guard let sampled = samples[candidate.handle], !sampled.isEmpty else { return false }
                    return sampled.allSatisfy(folder.names.contains)
                }
                let byCount = (matching.isEmpty ? candidates : matching).filter { $0.files == folder.names.count }
                if matching.count == 1 { chosen = matching[0] }
                else if byCount.count == 1 { chosen = byCount[0] }
                else if !matching.isEmpty, Set(matching.map(\.files)).count == 1, matching.allSatisfy({ $0.files == folder.names.count }) {
                    // The same files on each card (a slot recording a backup of the other): either card holds them.
                    chosen = matching[0]
                }
            }
            guard let chosen else { return nil }
            taken.insert(chosen.handle)
            result[folder.key] = chosen.storage
        }
        return result
    }
}
