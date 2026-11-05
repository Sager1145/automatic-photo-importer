import Foundation
import Testing
@testable import CameraAdapters

/// Card slots of a USB camera told apart. The layouts are a real Nikon Z f with both slots filled (macOS 27 merges both
/// cards under one DCIM in its catalog, with one folder object per card) and a Fujifilm X100VI with one card.
struct StorageMapTests {
    let slot1: UInt32 = 0x0001_0001, slot2: UInt32 = 0x0002_0001
    func names(_ prefix: String, _ count: Int) -> Set<String> { Set((0..<count).map { CatalogFolder.entry(name: "\(prefix)\($0).NEF", size: Int64(1000 + $0)) }) }

    @Test func eachFolderOfTheMergedCatalogGoesToItsCard() {
        // Slot 1: 102NZF__ (974), 103NZF__ (54). Slot 2: 101NZF__ (4836), 102NZF__ (1944), 103NZF__ (54, other files).
        let ptp = [
            PTPFolder(storage: slot1, handle: 1, path: "DCIM/102NZF__", files: 974),
            PTPFolder(storage: slot1, handle: 2, path: "DCIM/103NZF__", files: 54),
            PTPFolder(storage: slot2, handle: 3, path: "DCIM/101NZF__", files: 4836),
            PTPFolder(storage: slot2, handle: 4, path: "DCIM/102NZF__", files: 1944),
            PTPFolder(storage: slot2, handle: 5, path: "DCIM/103NZF__", files: 54),
        ]
        let catalog = [
            CatalogFolder(key: 0, path: "DCIM/101NZF__", names: names("a", 4836)),
            CatalogFolder(key: 1, path: "DCIM/102NZF__", names: names("b", 1944)),
            CatalogFolder(key: 2, path: "DCIM/102NZF__", names: names("c", 974)),
            CatalogFolder(key: 3, path: "DCIM/103NZF__", names: names("d", 54)),
            CatalogFolder(key: 4, path: "DCIM/103NZF__", names: names("e", 54)),
        ]
        #expect(StorageMap.shared(ptp) == ["DCIM/102NZF__", "DCIM/103NZF__"])
        // Same path and the same count (103NZF__ on both): the sampled names decide.
        let samples: [UInt32: [String]] = [
            1: [CatalogFolder.entry(name: "c0.NEF", size: 1000)], 4: [CatalogFolder.entry(name: "b5.NEF", size: 1005)],
            2: [CatalogFolder.entry(name: "e3.NEF", size: 1003)], 5: [CatalogFolder.entry(name: "d9.NEF", size: 1009)],
        ]
        let map = StorageMap.assign(catalog: catalog, ptp: ptp, samples: samples)
        #expect(map == [0: slot2, 1: slot2, 2: slot1, 3: slot2, 4: slot1])
    }

    @Test func aFolderThatCannotBePlacedKeepsTheCameraOneSource() {
        let ptp = [PTPFolder(storage: slot1, handle: 1, path: "DCIM/100NZF__", files: 10), PTPFolder(storage: slot2, handle: 2, path: "DCIM/100NZF__", files: 10)]
        let catalog = [CatalogFolder(key: 0, path: "DCIM/100NZF__", names: names("x", 10)), CatalogFolder(key: 1, path: "DCIM/100NZF__", names: names("y", 10))]
        // No samples, equal counts: nothing tells the two apart.
        #expect(StorageMap.assign(catalog: catalog, ptp: ptp, samples: [:]) == nil)
        // A folder the camera does not list on any card.
        #expect(StorageMap.assign(catalog: [CatalogFolder(key: 0, path: "DCIM/999XXX__", names: [])], ptp: ptp, samples: [:]) == nil)
    }

    @Test func aBackupCardWithTheSameFilesGoesToEitherCard() {
        // Slot 2 recording a backup of slot 1: the same folder, names and sizes on both.
        let ptp = [PTPFolder(storage: slot1, handle: 1, path: "DCIM/100NZF__", files: 3), PTPFolder(storage: slot2, handle: 2, path: "DCIM/100NZF__", files: 3)]
        let same = names("z", 3), sample = [CatalogFolder.entry(name: "z1.NEF", size: 1001)]
        let catalog = [CatalogFolder(key: 0, path: "DCIM/100NZF__", names: same), CatalogFolder(key: 1, path: "DCIM/100NZF__", names: same)]
        let map = StorageMap.assign(catalog: catalog, ptp: ptp, samples: [1: sample, 2: sample])
        #expect(map.map { Set($0.values) } == [slot1, slot2])
    }

    @Test func storageNamesAndIds() {
        #expect(PTPStorage.name(label: "NIKON Z F   [Slot 2]", description: "", index: 1) == "Slot 2")
        // A Fujifilm X100VI's label is only zeros: its description names the card.
        #expect(PTPStorage.name(label: String(repeating: "0", count: 48), description: "External Memory", index: 0) == "External Memory")
        #expect(PTPStorage.name(label: " ", description: "", index: 1) == "Card 2")
        #expect(PTPStorage(id: 0x0002_0001, name: "Slot 2", total: nil, free: nil).key == "20001")
        #expect(PTP.present(0x0001_0001) && !PTP.present(0x0002_0000))
        // Labels every card gets alike name no card: a Canon card is EOS_DIGITAL, others NO NAME or Untitled.
        #expect(PTPStorage.name(label: "EOS_DIGITAL", description: "SD", index: 0) == "SD")
        #expect(PTPStorage.name(label: "NO NAME", description: "", index: 1) == "Card 2")
        // Two cards named alike are named by their physical slot.
        let alike = [PTPStorage(id: 0x0001_0001, name: "SD", total: 1, free: 1), PTPStorage(id: 0x0002_0001, name: "SD", total: 2, free: 2)]
        #expect(PTPStorage.distinctNames(alike).map(\.name) == ["Slot 1", "Slot 2"])
        #expect(PTPStorage.distinctNames([PTPStorage(id: 0x0001_0001, name: "CFexpress", total: nil, free: nil), PTPStorage(id: 0x0002_0001, name: "SD", total: nil, free: nil)]).map(\.name) == ["CFexpress", "SD"])
    }

    @Test func batteryLevelFromEachCamerasOwnRange() {
        func bytes(_ hex: String) -> Data { Data(stride(from: 0, to: hex.count, by: 2).map { UInt8(hex.dropFirst($0).prefix(2), radix: 16)! }) }
        // Nikon Z f: range 1–100, at 60. Fujifilm X100VI: range 0–10, at 10.
        #expect(PTP.batteryPercent(bytes("0150020000643c01016401")) == 60)
        #expect(PTP.batteryPercent(bytes("01500200000a0a01000a01")) == 100)
        // An enumeration (0, 25, 50, 75, 100), and a property that is not the battery.
        #expect(PTP.batteryPercent(bytes("015002000064320205000019324b64")) == 50)
        #expect(PTP.batteryPercent(bytes("0250020000643c01016401")) == nil)
    }

    @Test func ptpDatasetsAreParsed() {
        func le<T: FixedWidthInteger>(_ value: T) -> [UInt8] { withUnsafeBytes(of: value.littleEndian, Array.init) }
        func string(_ text: String) -> [UInt8] { let units = Array(text.utf16) + [0]; return [UInt8(units.count)] + units.flatMap { le($0) } }
        let request = PTP.command(PTP.getStorageInfo, [0x0001_0001], transaction: 7)
        #expect(Array(request) == le(UInt32(16)) + le(UInt16(1)) + le(PTP.getStorageInfo) + le(UInt32(7)) + le(UInt32(0x0001_0001)))
        #expect(PTP.responseCode(Data(le(UInt32(12)) + le(UInt16(3)) + le(PTP.ok) + le(UInt32(7)))) == PTP.ok)
        #expect(PTP.array(Data(le(UInt32(2)) + le(UInt32(0x0001_0001)) + le(UInt32(0x0002_0001)))) == [0x0001_0001, 0x0002_0001])
        #expect(PTP.array(Data(le(UInt32(3)) + le(UInt32(1)))) == nil)
        let info = Data(le(UInt16(4)) + le(UInt16(3)) + le(UInt16(2)) + le(UInt64(124_642_131_968)) + le(UInt64(92_846_555_136)) + le(UInt32(1893)) + string("") + string("NIKON Z F   [Slot 1]"))
        #expect(PTP.storageInfo(info) == PTP.StorageInfo(maxCapacity: 124_642_131_968, freeSpace: 92_846_555_136, description: "", label: "NIKON Z F   [Slot 1]", freeImages: 1893))
        #expect(PTP.storageInfo(info.prefix(20)) == nil)
        let object = Data(le(UInt32(0x0001_0001)) + le(PTP.association) + le(UInt16(0)) + le(UInt32(0)) + le(UInt16(0)) + Array(repeating: 0, count: 24) + le(UInt32(0x1100_4000)) + le(UInt16(1)) + le(UInt32(0)) + le(UInt32(0)) + string("102NZF__"))
        #expect(PTP.objectInfo(object) == PTP.ObjectInfo(storage: 0x0001_0001, format: PTP.association, size: 0, parent: 0x1100_4000, name: "102NZF__"))
    }
}
