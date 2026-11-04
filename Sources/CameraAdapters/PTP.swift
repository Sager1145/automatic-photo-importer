import Foundation

/// The few PTP operations the helper sends itself (through ICCameraDevice.requestSendPTPCommand), to learn a camera's
/// storages (card slots), their capacity and which folders are on which. Read-only: none of them changes the camera.
public enum PTP {
    public static let getStorageIDs: UInt16 = 0x1004
    public static let getStorageInfo: UInt16 = 0x1005
    public static let getObjectHandles: UInt16 = 0x1007
    public static let getObjectInfo: UInt16 = 0x1008
    public static let ok: UInt16 = 0x2001
    /// ObjectFormatCode of a folder.
    public static let association: UInt16 = 0x3001

    /// An operation request container: length, type 1 (command), code, transaction id, parameters (little-endian).
    public static func command(_ code: UInt16, _ parameters: [UInt32], transaction: UInt32) -> Data {
        var data = Data()
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        put(UInt32(12 + 4 * parameters.count)); put(UInt16(1)); put(code); put(transaction)
        for parameter in parameters { put(parameter) }
        return data
    }

    /// The response code of a response container (0 when it is too short to hold one).
    public static func responseCode(_ response: Data) -> UInt16 {
        var reader = Reader(response); _ = reader.u32(); _ = reader.u16(); return reader.u16()
    }

    /// A storage id names a present storage only when its low 16 bits are set (PTP 1.1, 5.2.1): an empty slot is 0xNNNN0000.
    public static func present(_ id: UInt32) -> Bool { id & 0xFFFF != 0 }

    /// A UInt32 array dataset (GetStorageIDs, GetObjectHandles), or nil when it is cut short.
    public static func array(_ data: Data) -> [UInt32]? {
        var reader = Reader(data)
        let count = Int(reader.u32())
        guard data.count >= 4 + 4 * count else { return nil }
        return (0..<count).map { _ in reader.u32() }
    }

    public struct StorageInfo: Equatable, Sendable {
        public let maxCapacity: UInt64, freeSpace: UInt64, description: String, label: String
    }
    public static func storageInfo(_ data: Data) -> StorageInfo? {
        var reader = Reader(data)
        _ = reader.u16(); _ = reader.u16(); _ = reader.u16()
        let capacity = reader.u64(), free = reader.u64(); _ = reader.u32()
        let description = reader.string(), label = reader.string()
        return reader.overrun ? nil : StorageInfo(maxCapacity: capacity, freeSpace: free, description: description, label: label)
    }

    public struct ObjectInfo: Equatable, Sendable {
        public let storage: UInt32, format: UInt16, size: UInt32, parent: UInt32, name: String
    }
    public static func objectInfo(_ data: Data) -> ObjectInfo? {
        var reader = Reader(data)
        let storage = reader.u32(), format = reader.u16(); _ = reader.u16()
        let size = reader.u32()
        _ = reader.u16(); for _ in 0..<6 { _ = reader.u32() }
        let parent = reader.u32(); _ = reader.u16(); _ = reader.u32(); _ = reader.u32()
        let name = reader.string()
        return reader.overrun ? nil : ObjectInfo(storage: storage, format: format, size: size, parent: parent, name: name)
    }

    struct Reader {
        let data: Data
        var at = 0
        var overrun = false
        init(_ data: Data) { self.data = data }
        mutating func u8() -> UInt8 {
            guard at < data.count else { overrun = true; return 0 }
            defer { at += 1 }
            return data[data.startIndex + at]
        }
        mutating func u16() -> UInt16 { UInt16(u8()) | UInt16(u8()) << 8 }
        mutating func u32() -> UInt32 { UInt32(u16()) | UInt32(u16()) << 16 }
        mutating func u64() -> UInt64 { UInt64(u32()) | UInt64(u32()) << 32 }
        /// A PTP string: a count of UTF-16 units (with its terminating 0), then the units.
        mutating func string() -> String {
            let count = Int(u8())
            var units: [UInt16] = []
            for _ in 0..<count { units.append(u16()) }
            while units.last == 0 { units.removeLast() }
            return String(decoding: units, as: UTF16.self)
        }
    }
}
