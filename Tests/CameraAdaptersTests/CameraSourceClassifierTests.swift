import ImageCaptureCore
import Testing
@testable import CameraAdapters

struct CameraSourceClassifierTests {
    @Test func massStorageWithNilMountPointIsNotListedAsPTP() {
        // Observed on the built-in SD reader: filesystem and ICDevice UUIDs differ.
        #expect(!CameraSourceClassifier.shouldListAsPTP(transportType: ICDeviceTransport.transportTypeMassStorage.rawValue, mountPoint: nil))
    }

    @Test func mountedMassStorageIsNotListedAsPTP() {
        #expect(!CameraSourceClassifier.shouldListAsPTP(transportType: ICDeviceTransport.transportTypeMassStorage.rawValue, mountPoint: "/Volumes/Card"))
    }

    @Test func genuineUSBPTPDeviceIsListed() {
        #expect(CameraSourceClassifier.shouldListAsPTP(transportType: ICDeviceTransport.transportTypeUSB.rawValue, mountPoint: nil))
    }

    @Test func filesystemBackedDeviceIsNotListedAsPTP() {
        #expect(!CameraSourceClassifier.shouldListAsPTP(transportType: ICDeviceTransport.transportTypeUSB.rawValue, mountPoint: "/Volumes/Card"))
    }

}
