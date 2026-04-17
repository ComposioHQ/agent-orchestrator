import AppKit
import AVFoundation
import CoreGraphics
import Foundation

struct SampledFrame: Codable {
    let index: Int
    let timeSeconds: Double
    let timestamp: String
    let fileName: String
    let relativePath: String
    let averageLuma: Double
    let averageColorHex: String
    let meanPixelDifferenceFromPrevious: Double
}

struct RawReferenceAnalysis: Codable {
    let inputPath: String
    let generatedAt: String
    let durationSeconds: Double
    let width: Int
    let height: Int
    let nominalFrameRate: Double
    let sampleIntervalSeconds: Double
    let hasAudioTrack: Bool
    let audioRelativePath: String?
    let frames: [SampledFrame]
}

enum AnalyzerError: Error, LocalizedError {
    case missingValue(String)
    case invalidArgument(String)
    case failedToSaveImage(String)
    case videoTrackUnavailable
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingValue(let name):
            return "Missing value for \(name)"
        case .invalidArgument(let message):
            return message
        case .failedToSaveImage(let path):
            return "Failed to save frame image to \(path)"
        case .videoTrackUnavailable:
            return "The input file does not contain a readable video track."
        case .exportFailed(let message):
            return "Audio export failed: \(message)"
        }
    }
}

func parseArguments() throws -> [String: String] {
    let args = Array(CommandLine.arguments.dropFirst())
    var parsed: [String: String] = [:]
    var index = 0

    while index < args.count {
        let key = args[index]
        if key == "--force" {
            parsed[key] = "true"
            index += 1
            continue
        }

        guard index + 1 < args.count else {
            throw AnalyzerError.missingValue(key)
        }

        parsed[key] = args[index + 1]
        index += 2
    }

    return parsed
}

func require(_ arguments: [String: String], _ key: String) throws -> String {
    guard let value = arguments[key], !value.isEmpty else {
        throw AnalyzerError.missingValue(key)
    }
    return value
}

func ensureDirectory(_ path: String) throws {
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
}

func timestampString(seconds: Double) -> String {
    let total = max(seconds, 0)
    let minutes = Int(total / 60)
    let remainder = total - (Double(minutes) * 60)
    return String(format: "%02d:%05.2f", minutes, remainder)
}

func rgbaThumbnail(for image: CGImage, size: Int = 32) -> [UInt8]? {
    let bytesPerPixel = 4
    let bytesPerRow = size * bytesPerPixel
    var pixels = [UInt8](repeating: 0, count: size * size * bytesPerPixel)

    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
        return nil
    }

    guard let context = CGContext(
        data: &pixels,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }

    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    return pixels
}

func saveJPEG(_ image: CGImage, to path: String) throws {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else {
        throw AnalyzerError.failedToSaveImage(path)
    }

    do {
        try data.write(to: URL(fileURLWithPath: path))
    } catch {
        throw AnalyzerError.failedToSaveImage(path)
    }
}

func averageColorHex(from pixels: [UInt8]) -> String {
    if pixels.isEmpty {
        return "#000000"
    }

    var red = 0.0
    var green = 0.0
    var blue = 0.0
    let pixelCount = pixels.count / 4

    for index in stride(from: 0, to: pixels.count, by: 4) {
        red += Double(pixels[index])
        green += Double(pixels[index + 1])
        blue += Double(pixels[index + 2])
    }

    let count = Double(max(pixelCount, 1))
    return String(
        format: "#%02X%02X%02X",
        Int((red / count).rounded()),
        Int((green / count).rounded()),
        Int((blue / count).rounded())
    )
}

func averageLuma(from pixels: [UInt8]) -> Double {
    if pixels.isEmpty {
        return 0
    }

    var luma = 0.0
    let pixelCount = pixels.count / 4

    for index in stride(from: 0, to: pixels.count, by: 4) {
        let red = Double(pixels[index])
        let green = Double(pixels[index + 1])
        let blue = Double(pixels[index + 2])
        luma += (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
    }

    return luma / Double(max(pixelCount, 1))
}

func meanPixelDifference(current: [UInt8], previous: [UInt8]?) -> Double {
    guard let previous, previous.count == current.count, !current.isEmpty else {
        return 0
    }

    var total = 0.0
    let channelCount = current.count / 4 * 3

    for index in stride(from: 0, to: current.count, by: 4) {
        total += abs(Double(current[index]) - Double(previous[index]))
        total += abs(Double(current[index + 1]) - Double(previous[index + 1]))
        total += abs(Double(current[index + 2]) - Double(previous[index + 2]))
    }

    return total / Double(max(channelCount, 1))
}

func removeExistingFrames(in directory: String) throws {
    let fileManager = FileManager.default
    if !fileManager.fileExists(atPath: directory) {
        return
    }

    let contents = try fileManager.contentsOfDirectory(atPath: directory)
    for item in contents where item.hasSuffix(".jpg") {
        try fileManager.removeItem(atPath: "\(directory)/\(item)")
    }
}

func exportAudio(asset: AVAsset, to outputPath: String, force: Bool) throws -> String? {
    let fileManager = FileManager.default
    guard !asset.tracks(withMediaType: .audio).isEmpty else {
        return nil
    }

    if fileManager.fileExists(atPath: outputPath) {
        if force {
            try fileManager.removeItem(atPath: outputPath)
        } else {
            return "audio/reference-audio.m4a"
        }
    }

    guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
        throw AnalyzerError.exportFailed("Unable to create export session.")
    }

    exporter.outputURL = URL(fileURLWithPath: outputPath)
    exporter.outputFileType = .m4a
    exporter.timeRange = CMTimeRange(start: .zero, duration: asset.duration)

    let semaphore = DispatchSemaphore(value: 0)
    exporter.exportAsynchronously {
        semaphore.signal()
    }
    semaphore.wait()

    switch exporter.status {
    case .completed:
        return "audio/reference-audio.m4a"
    case .failed:
        throw AnalyzerError.exportFailed(exporter.error?.localizedDescription ?? "Unknown export failure.")
    case .cancelled:
        throw AnalyzerError.exportFailed("Export was cancelled.")
    default:
        throw AnalyzerError.exportFailed("Unexpected exporter status \(exporter.status.rawValue).")
    }
}

let arguments = try parseArguments()
let inputPath = try require(arguments, "--input")
let framesDir = try require(arguments, "--frames-dir")
let audioDir = try require(arguments, "--audio-dir")
let outputJSON = try require(arguments, "--output-json")
let sampleInterval = Double(try require(arguments, "--sample-interval")) ?? 2.0
let force = arguments["--force"] == "true"

if sampleInterval <= 0 {
    throw AnalyzerError.invalidArgument("--sample-interval must be greater than 0")
}

try ensureDirectory(framesDir)
try ensureDirectory(audioDir)
try ensureDirectory((outputJSON as NSString).deletingLastPathComponent)

if force {
    try removeExistingFrames(in: framesDir)
}

let assetURL = URL(fileURLWithPath: inputPath)
let asset = AVURLAsset(url: assetURL)

guard let videoTrack = asset.tracks(withMediaType: .video).first else {
    throw AnalyzerError.videoTrackUnavailable
}

let durationSeconds = CMTimeGetSeconds(asset.duration)
let transformedSize = videoTrack.naturalSize.applying(videoTrack.preferredTransform)
let width = Int(abs(transformedSize.width.rounded()))
let height = Int(abs(transformedSize.height.rounded()))
let nominalFrameRate = Double(videoTrack.nominalFrameRate)

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.maximumSize = CGSize(width: 1280, height: 720)
generator.requestedTimeToleranceAfter = .zero
generator.requestedTimeToleranceBefore = .zero

var frames: [SampledFrame] = []
var previousPixels: [UInt8]? = nil
var sampleIndex = 0
var currentTime = 0.0

while currentTime < durationSeconds {
    let requested = CMTime(seconds: currentTime, preferredTimescale: 600)
    var actualTime = CMTime.zero
    let image = try generator.copyCGImage(at: requested, actualTime: &actualTime)
    let actualSeconds = CMTimeGetSeconds(actualTime)
    let fileName = String(format: "sample-%03d-%05.2fs.jpg", sampleIndex, actualSeconds)
    let framePath = "\(framesDir)/\(fileName)"

    try saveJPEG(image, to: framePath)

    let pixels = rgbaThumbnail(for: image) ?? []
    let frame = SampledFrame(
        index: sampleIndex,
        timeSeconds: actualSeconds,
        timestamp: timestampString(seconds: actualSeconds),
        fileName: fileName,
        relativePath: "frames/\(fileName)",
        averageLuma: Double(round(averageLuma(from: pixels) * 100) / 100),
        averageColorHex: averageColorHex(from: pixels),
        meanPixelDifferenceFromPrevious: Double(round(meanPixelDifference(current: pixels, previous: previousPixels) * 100) / 100)
    )

    frames.append(frame)
    previousPixels = pixels
    sampleIndex += 1
    currentTime += sampleInterval
}

let finalTime = CMTime(seconds: durationSeconds, preferredTimescale: 600)
if let lastFrame = frames.last, abs(lastFrame.timeSeconds - durationSeconds) > (sampleInterval / 2) {
    var actualTime = CMTime.zero
    let image = try generator.copyCGImage(at: finalTime, actualTime: &actualTime)
    let actualSeconds = CMTimeGetSeconds(actualTime)
    let fileName = String(format: "sample-%03d-%05.2fs.jpg", sampleIndex, actualSeconds)
    let framePath = "\(framesDir)/\(fileName)"

    try saveJPEG(image, to: framePath)

    let pixels = rgbaThumbnail(for: image) ?? []
    frames.append(
        SampledFrame(
            index: sampleIndex,
            timeSeconds: actualSeconds,
            timestamp: timestampString(seconds: actualSeconds),
            fileName: fileName,
            relativePath: "frames/\(fileName)",
            averageLuma: Double(round(averageLuma(from: pixels) * 100) / 100),
            averageColorHex: averageColorHex(from: pixels),
            meanPixelDifferenceFromPrevious: Double(round(meanPixelDifference(current: pixels, previous: previousPixels) * 100) / 100)
        )
    )
}

let audioRelativePath = try exportAudio(
    asset: asset,
    to: "\(audioDir)/reference-audio.m4a",
    force: force
)

let output = RawReferenceAnalysis(
    inputPath: inputPath,
    generatedAt: ISO8601DateFormatter().string(from: Date()),
    durationSeconds: Double(round(durationSeconds * 100) / 100),
    width: width,
    height: height,
    nominalFrameRate: Double(round(nominalFrameRate * 100) / 100),
    sampleIntervalSeconds: sampleInterval,
    hasAudioTrack: !asset.tracks(withMediaType: .audio).isEmpty,
    audioRelativePath: audioRelativePath,
    frames: frames
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(output)
try data.write(to: URL(fileURLWithPath: outputJSON))

print(outputJSON)
