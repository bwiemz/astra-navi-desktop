// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AstraStation",
    platforms: [
        .iOS(.v16),
    ],
    products: [
        .library(
            name: "AstraStation",
            targets: ["AstraStation"]
        ),
    ],
    targets: [
        .target(
            name: "AstraStation",
            path: "Sources"
        ),
    ]
)
