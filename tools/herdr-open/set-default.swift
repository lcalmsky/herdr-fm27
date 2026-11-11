import AppKit
import UniformTypeIdentifiers

var arguments = Array(CommandLine.arguments.dropFirst())
let printOnly = arguments.first == "--print"
if printOnly { arguments.removeFirst() }
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: set-default [--print] <app path> <extension>...\n".utf8))
    exit(2)
}

let application = URL(fileURLWithPath: arguments[0])
let workspace = NSWorkspace.shared
var failed = false

for raw in arguments.dropFirst() {
    let name = raw.hasPrefix(".") ? String(raw.dropFirst()) : raw
    guard let type = UTType(filenameExtension: name) else {
        FileHandle.standardError.write(Data("set-default: unknown extension \(name)\n".utf8))
        failed = true
        continue
    }
    let current = workspace.urlForApplication(toOpen: type)?.path ?? ""
    print("\(name)\t\(current)")
    if printOnly { continue }

    let done = DispatchSemaphore(value: 0)
    var error: Error?
    workspace.setDefaultApplication(at: application, toOpen: type) { thrown in
        error = thrown
        done.signal()
    }
    done.wait()
    if let error {
        FileHandle.standardError.write(Data("set-default: \(name): \(error.localizedDescription)\n".utf8))
        failed = true
    }
}

exit(failed ? 1 : 0)
