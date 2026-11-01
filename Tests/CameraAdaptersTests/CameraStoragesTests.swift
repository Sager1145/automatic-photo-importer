import Testing
@testable import CameraAdapters

struct CameraStoragesTests {
    @Test func slotNameComesFromTheStorageDescription() {
        #expect(CameraStorages.displayName("NIKON Z F   [Slot 1]") == "Slot 1")
        #expect(CameraStorages.displayName("Card  2") == "Card 2")
        #expect(CameraStorages.displayName("[ ]") == "[ ]")
    }
}
