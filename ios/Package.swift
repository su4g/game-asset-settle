// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BuffReaderCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "BuffReaderCore", targets: ["BuffReaderCore"])],
    targets: [
        .target(name: "BuffReaderCore"),
        .target(name: "BuffReaderState", dependencies: ["BuffReaderCore"], path: "App",
                exclude: ["Assets.xcassets", "Info.plist", "PrivacyInfo.xcprivacy", "BuffReaderApp.swift", "ReaderViews.swift", "AlchemyViews.swift", "ReaderDesign.swift", "ReaderPreview.swift"],
                sources: ["ReaderStore.swift", "KeychainStore.swift"]),
        .testTarget(name: "BuffReaderCoreTests", dependencies: ["BuffReaderCore"], resources: [.copy("Fixtures")]),
        .testTarget(name: "BuffReaderStateTests", dependencies: ["BuffReaderState", "BuffReaderCore"]),
    ]
)
