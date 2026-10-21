// swift-tools-version: 6.0
import PackageDescription
// Only the macOS ImageCaptureCore helper is native; the app itself is the Electron desktop build.
let package = Package(
    name: "AutomaticPhotoImporter",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "NativeCameraBridge", targets: ["CameraBridge"])],
    targets: [
        .target(name: "CameraAdapters"),
        .executableTarget(name: "CameraBridge", dependencies: ["CameraAdapters"]),
        .testTarget(name: "CameraAdaptersTests", dependencies: ["CameraAdapters"])
    ]
)
