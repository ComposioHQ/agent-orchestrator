import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import ImageIO
import UniformTypeIdentifiers

// Minimal native capture probe. It captures the Simulator window selected by
// owner name and writes one PNG frame to stdout; the Go daemon can supervise
// this helper and reuse the same selection logic for a persistent stream.
@main
struct SimulatorCaptureProbe {
    static func main() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.owningApplication?.applicationName == "Simulator" }) else {
                throw NSError(domain: "AO.Capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Simulator window not found"])
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            configuration.width = max(Int(window.frame.width * 2), 1)
            configuration.height = max(Int(window.frame.height * 2), 1)
            configuration.pixelFormat = kCVPixelFormatType_32BGRA
            configuration.queueDepth = 3
            let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
            let output = FrameOutput()
            try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "ao.capture"))
            try await stream.startCapture()
            let image = try await output.nextImage()
            try await stream.stopCapture()
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw NSError(domain: "AO.Capture", code: 2) }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "AO.Capture", code: 3) }
            FileHandle.standardOutput.write(data as Data)
        } catch { FileHandle.standardError.write(Data("AO capture: \(error)\n".utf8)); exit(1) }
    }
}

final class FrameOutput: NSObject, SCStreamOutput {
    private var continuation: CheckedContinuation<CGImage, Error>?
    func nextImage() async throws -> CGImage { try await withCheckedThrowingContinuation { continuation = $0 } }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let buffer = sampleBuffer.imageBuffer else { return }
        let ci = CIImage(cvPixelBuffer: buffer)
        let context = CIContext()
        if let image = context.createCGImage(ci, from: ci.extent) { continuation?.resume(returning: image); continuation = nil }
    }
}
