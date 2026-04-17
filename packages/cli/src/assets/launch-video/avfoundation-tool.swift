import Foundation
import AVFoundation
import AppKit
import Vision

struct InspectOutput: Encodable {
  let durationSeconds: Double?
  let width: Double?
  let height: Double?
  let nominalFrameRate: Float?
  let videoCodec: String?
  let audioCodec: String?
  let hasAudio: Bool
}

struct KeyframeRecord: Encodable {
  let index: Int
  let timeSeconds: Double
  let path: String
}

struct FrameAnalysis: Encodable {
  let path: String
  let width: Int
  let height: Int
  let averageHex: String
  let palette: [String]
  let brightness: Double
  let contrast: Double
  let textLines: [String]
}

struct FrameDiff: Encodable {
  let fromPath: String
  let toPath: String
  let differenceScore: Double
}

enum ToolError: Error {
  case invalidArguments(String)
  case missingVideoTrack
  case jpegEncodeFailed
  case imageLoadFailed(String)
  case contextCreateFailed
}

func fourCC(_ value: FourCharCode) -> String {
  let n = Int(value)
  let bytes = [
    Character(UnicodeScalar((n >> 24) & 255)!),
    Character(UnicodeScalar((n >> 16) & 255)!),
    Character(UnicodeScalar((n >> 8) & 255)!),
    Character(UnicodeScalar(n & 255)!),
  ]
  return String(bytes)
}

func writeJSON<T: Encodable>(_ value: T) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  let data = try encoder.encode(value)
  if let string = String(data: data, encoding: .utf8) {
    print(string)
  }
}

func loadCGImage(at path: String) throws -> CGImage {
  let url = URL(fileURLWithPath: path)
  guard let image = NSImage(contentsOf: url) else {
    throw ToolError.imageLoadFailed(path)
  }
  var rect = CGRect(origin: .zero, size: image.size)
  guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    throw ToolError.imageLoadFailed(path)
  }
  return cgImage
}

func renderRGBA(_ image: CGImage, width: Int, height: Int) throws -> [UInt8] {
  let bytesPerPixel = 4
  let bytesPerRow = width * bytesPerPixel
  var pixels = [UInt8](repeating: 0, count: width * height * bytesPerPixel)

  guard let context = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else {
    throw ToolError.contextCreateFailed
  }

  context.interpolationQuality = .low
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return pixels
}

func rgbToHex(r: Int, g: Int, b: Int) -> String {
  return String(format: "#%02X%02X%02X", r, g, b)
}

func analyzeImage(at path: String) throws -> FrameAnalysis {
  let cgImage = try loadCGImage(at: path)
  let sampleWidth = 64
  let sampleHeight = 64
  let pixels = try renderRGBA(cgImage, width: sampleWidth, height: sampleHeight)
  var totalR = 0.0
  var totalG = 0.0
  var totalB = 0.0
  var brightnessValues: [Double] = []
  var paletteCounts: [String: Int] = [:]

  for index in stride(from: 0, to: pixels.count, by: 4) {
    let r = Double(pixels[index])
    let g = Double(pixels[index + 1])
    let b = Double(pixels[index + 2])
    totalR += r
    totalG += g
    totalB += b
    let brightness = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
    brightnessValues.append(brightness)

    let qR = Int((r / 32.0).rounded(.down) * 32.0)
    let qG = Int((g / 32.0).rounded(.down) * 32.0)
    let qB = Int((b / 32.0).rounded(.down) * 32.0)
    let key = rgbToHex(r: min(255, qR), g: min(255, qG), b: min(255, qB))
    paletteCounts[key, default: 0] += 1
  }

  let pixelCount = Double(sampleWidth * sampleHeight)
  let avgR = Int((totalR / pixelCount).rounded())
  let avgG = Int((totalG / pixelCount).rounded())
  let avgB = Int((totalB / pixelCount).rounded())
  let averageHex = rgbToHex(r: avgR, g: avgG, b: avgB)

  let averageBrightness = brightnessValues.reduce(0, +) / max(1, Double(brightnessValues.count))
  let variance = brightnessValues.reduce(0.0) { partial, value in
    partial + pow(value - averageBrightness, 2)
  } / max(1, Double(brightnessValues.count))
  let contrast = sqrt(variance)

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])
  let lines =
    request.results?
    .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty } ?? []

  let palette = paletteCounts
    .sorted { lhs, rhs in
      if lhs.value == rhs.value { return lhs.key < rhs.key }
      return lhs.value > rhs.value
    }
    .prefix(5)
    .map(\.key)

  return FrameAnalysis(
    path: path,
    width: cgImage.width,
    height: cgImage.height,
    averageHex: averageHex,
    palette: palette,
    brightness: averageBrightness,
    contrast: contrast,
    textLines: Array(lines.prefix(8))
  )
}

func calculateDifference(from first: String, to second: String) throws -> FrameDiff {
  let firstPixels = try renderRGBA(try loadCGImage(at: first), width: 64, height: 64)
  let secondPixels = try renderRGBA(try loadCGImage(at: second), width: 64, height: 64)
  var total = 0.0
  let count = min(firstPixels.count, secondPixels.count)

  for index in stride(from: 0, to: count, by: 4) {
    total += abs(Double(firstPixels[index]) - Double(secondPixels[index]))
    total += abs(Double(firstPixels[index + 1]) - Double(secondPixels[index + 1]))
    total += abs(Double(firstPixels[index + 2]) - Double(secondPixels[index + 2]))
  }

  let normalized = total / (Double(64 * 64 * 3) * 255.0)
  return FrameDiff(fromPath: first, toPath: second, differenceScore: normalized)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  throw ToolError.invalidArguments(
    "usage: swift avfoundation-tool.swift <inspect|keyframes|analyze-images|diff-images> ..."
  )
}

let command = args[1]

switch command {
case "inspect":
  let videoPath = args[2]
  let asset = AVURLAsset(url: URL(fileURLWithPath: videoPath))
  let videoTrack = asset.tracks(withMediaType: .video).first
  let audioTrack = asset.tracks(withMediaType: .audio).first
  let naturalSize =
    videoTrack?.naturalSize.applying(videoTrack?.preferredTransform ?? .identity) ?? .zero
  let videoCodec = videoTrack
    .flatMap { $0.formatDescriptions.first }
    .map { CMFormatDescriptionGetMediaSubType($0 as! CMFormatDescription) }
    .map(fourCC)
  let audioCodec = audioTrack
    .flatMap { $0.formatDescriptions.first }
    .map { CMFormatDescriptionGetMediaSubType($0 as! CMFormatDescription) }
    .map(fourCC)

  try writeJSON(
    InspectOutput(
      durationSeconds: CMTimeGetSeconds(asset.duration),
      width: abs(Double(naturalSize.width)),
      height: abs(Double(naturalSize.height)),
      nominalFrameRate: videoTrack?.nominalFrameRate,
      videoCodec: videoCodec,
      audioCodec: audioCodec,
      hasAudio: audioTrack != nil
    )
  )
case "keyframes":
  guard args.count >= 5 else {
    throw ToolError.invalidArguments(
      "usage: swift avfoundation-tool.swift keyframes <video-path> <output-dir> <times>"
    )
  }

  let videoPath = args[2]
  let asset = AVURLAsset(url: URL(fileURLWithPath: videoPath))
  guard asset.tracks(withMediaType: .video).first != nil else {
    throw ToolError.missingVideoTrack
  }

  let outputDir = args[3]
  let times = args[4]
    .split(separator: ",")
    .compactMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }

  try FileManager.default.createDirectory(
    at: URL(fileURLWithPath: outputDir),
    withIntermediateDirectories: true
  )

  let generator = AVAssetImageGenerator(asset: asset)
  generator.appliesPreferredTrackTransform = true
  generator.requestedTimeToleranceAfter = .zero
  generator.requestedTimeToleranceBefore = .zero

  var records: [KeyframeRecord] = []
  for (index, time) in times.enumerated() {
    let image = try generator.copyCGImage(
      at: CMTime(seconds: time, preferredTimescale: 600),
      actualTime: nil
    )
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(
      using: .jpeg,
      properties: [.compressionFactor: 0.84]
    ) else {
      throw ToolError.jpegEncodeFailed
    }

    let fileName = String(format: "keyframe-%03d.jpg", index + 1)
    let filePath = URL(fileURLWithPath: outputDir).appendingPathComponent(fileName).path
    try data.write(to: URL(fileURLWithPath: filePath))
    records.append(KeyframeRecord(index: index, timeSeconds: time, path: filePath))
  }

  try writeJSON(records)
case "analyze-images":
  let paths = args[2].split(separator: "|").map(String.init)
  let analyses = try paths.map { try analyzeImage(at: $0) }
  try writeJSON(analyses)
case "diff-images":
  let paths = args[2].split(separator: "|").map(String.init)
  var diffs: [FrameDiff] = []
  if paths.count >= 2 {
    for index in 0..<(paths.count - 1) {
      diffs.append(try calculateDifference(from: paths[index], to: paths[index + 1]))
    }
  }
  try writeJSON(diffs)
default:
  throw ToolError.invalidArguments("unknown command \(command)")
}
