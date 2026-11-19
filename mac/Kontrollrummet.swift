// Kontrollrummet.app: the control room in its own window in the Dock.
//
// The server runs under the LaunchAgent se.kontrollrummet and keeps running
// when this window closes, so the desks in the Claude app keep working. The
// app starts the agent if it is not running, shows the board, and puts the
// number of things waiting for the owner on its Dock icon.

import Cocoa
import UserNotifications
import WebKit

// One LaunchAgent: this app's own binary in background mode runs the server and the desks.
let serviceLabel = "se.kontrollrummet"
// The first project's office: the web app picks it.
let home = URL(string: "http://127.0.0.1:4317/")!
let uid = getuid()

@discardableResult
func launchctl(_ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
    return p.terminationStatus
}

func plist(_ label: String) -> String {
    NSHomeDirectory() + "/Library/LaunchAgents/\(label).plist"
}

/// Loads the agent if launchd does not know it, then makes sure it runs.
func ensureRunning(_ label: String) {
    if launchctl(["print", "gui/\(uid)/\(label)"]) != 0 {
        launchctl(["bootstrap", "gui/\(uid)", plist(label)])
    }
    launchctl(["kickstart", "gui/\(uid)/\(label)"])
}

func stop(_ label: String) {
    launchctl(["bootout", "gui/\(uid)/\(label)"])
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var retry: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "badge")
        // The page posts what needs the owner or is done; it becomes a macOS notification.
        config.userContentController.add(self, name: "notify")
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1480, height: 920),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Kontrollrummet"
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("Kontrollrummet")
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)

        showWaiting()
        DispatchQueue.global().async {
            ensureRunning(serviceLabel)
            DispatchQueue.main.async { self.load() }
        }
    }

    func showWaiting() {
        web.loadHTMLString("""
        <html><body style="font: 15px -apple-system; display: grid; place-items: center; height: 100vh; margin: 0;
          background: Canvas; color: CanvasText;"><p>Startar kontrollrummet…</p></body></html>
        """, baseURL: nil)
    }

    func load() {
        web.load(URLRequest(url: home))
    }

    // The server may still be starting: try again until it answers.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in self?.load() }
    }

    // PRs, Figma and anything off the board open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, host != "127.0.0.1", action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // <input type="file">: a web view shows no file picker unless the app opens one.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        if let window = webView.window {
            panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    // window.confirm and window.alert: without these the page's questions answer no on their own.
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Avbryt")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    // The page posts how many cards and approvals wait for the owner.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "notify" {
            notify(message.body as? [String: Any] ?? [:])
            return
        }
        let n = (message.body as? Int) ?? 0
        NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    }

    /// A notification, unless the owner is looking at the window already.
    func notify(_ note: [String: Any]) {
        if NSApp.isActive && window.isKeyWindow && window.isVisible { return }
        let content = UNMutableNotificationContent()
        content.title = note["title"] as? String ?? "Kontrollrummet"
        content.body = note["body"] as? String ?? ""
        content.sound = .default
        content.userInfo = ["href": note["href"] as? String ?? ""]
        // Same tag, same notification: a newer state of a card replaces the older one.
        let id = note["tag"] as? String ?? UUID().uuidString
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    // A click: the window in front, on what the notification is about.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let href = response.notification.request.content.userInfo["href"] as? String ?? ""
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
            if href.hasPrefix("#") {
                let js = "location.hash = \(String(reflecting: href))"
                self.web.evaluateJavaScript(js, completionHandler: nil)
            }
        }
        done()
    }

    // Shown also when the app is in front but its window is not (another space, minimised).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    // Closing the window keeps the app (and the server) running; the Dock icon brings it back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    @objc func reload() { load() }

    @objc func restartServer() {
        showWaiting()
        DispatchQueue.global().async {
            // Only the server: the desks' sessions in the Claude app keep going.
            launchctl(["kill", "SIGUSR1", "gui/\(uid)/\(serviceLabel)"])
            DispatchQueue.main.async { self.load() }
        }
    }

    @objc func stopTeam() {
        let alert = NSAlert()
        alert.messageText = "Stoppa teamet?"
        alert.informativeText = "Servern och skrivborden i Claude-appen stängs. Agenter som arbetar avbryts och fortsätter när du startar igen."
        alert.addButton(withTitle: "Stoppa")
        alert.addButton(withTitle: "Avbryt")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        stop(serviceLabel)
        NSApp.dockTile.badgeLabel = nil
        web.loadHTMLString("""
        <html><body style="font: 15px -apple-system; display: grid; place-items: center; height: 100vh; margin: 0;
          background: Canvas; color: CanvasText;"><p>Teamet är stoppat. Välj Starta teamet i menyn.</p></body></html>
        """, baseURL: nil)
    }

    @objc func startTeam() {
        showWaiting()
        DispatchQueue.global().async {
            ensureRunning(serviceLabel)
            DispatchQueue.main.async { self.load() }
        }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let app = NSMenu()
        app.addItem(withTitle: "Om Kontrollrummet", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Starta teamet", action: #selector(startTeam), keyEquivalent: "")
        app.addItem(withTitle: "Starta om servern", action: #selector(restartServer), keyEquivalent: "")
        app.addItem(withTitle: "Stoppa teamet…", action: #selector(stopTeam), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Göm Kontrollrummet", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Avsluta fönstret", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Redigera")
        edit.addItem(withTitle: "Ångra", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Gör om", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Klipp ut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Kopiera", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Klistra in", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Markera allt", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "Visa")
        view.addItem(withTitle: "Läs in igen", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Fönster")
        windowMenu.addItem(withTitle: "Minimera", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Stäng", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

// MARK: - Background mode: one LaunchAgent for everything
//
// `Kontrollrummet --supervise <services.json>`: what the single LaunchAgent
// se.kontrollrummet starts. It runs the server and the desks from the list,
// starts again whatever stops, and stops them all with itself. One item named
// Kontrollrummet in Login Items, and the one macOS asks for access on behalf
// of, instead of a node or zsh for each. SIGUSR1 restarts only the server.

struct Service: Decodable {
    let name: String
    let log: String
    let command: [String]
}

final class Supervised {
    let service: Service
    var pid: pid_t = 0
    var startedAt = Date()
    var stopping = false
    var soon = false
    var exitSource: DispatchSourceProcess?

    init(_ service: Service) { self.service = service }

    func start() {
        guard !stopping else { return }
        let fd = open(service.log, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        if fd >= 0 {
            posix_spawn_file_actions_adddup2(&actions, fd, 1)
            posix_spawn_file_actions_adddup2(&actions, fd, 2)
        }
        // Its own process group, so a stop reaches everything it started (caffeinate, node, claude), as launchd did.
        var attrs: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attrs)
        // Signals back to their defaults: we ignore TERM and friends to handle them ourselves, and a child would inherit that.
        var defaults = sigset_t()
        sigfillset(&defaults)
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigdefault(&attrs, &defaults)
        posix_spawnattr_setsigmask(&attrs, &none)
        posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
        posix_spawnattr_setpgroup(&attrs, 0)
        let argv: [UnsafeMutablePointer<CChar>?] = service.command.map { strdup($0) } + [nil]
        var child: pid_t = 0
        let rc = posix_spawn(&child, service.command[0], &actions, &attrs, argv, environ)
        argv.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions)
        posix_spawnattr_destroy(&attrs)
        if fd >= 0 { close(fd) }
        startedAt = Date()
        guard rc == 0 else {
            note("\(service.name) startade inte (\(String(cString: strerror(rc)))). Försöker igen om 30 s.")
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { self.start() }
            return
        }
        pid = child
        let source = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in self?.exited() }
        source.resume()
        exitSource = source
    }

    func exited() {
        var status: Int32 = 0
        waitpid(pid, &status, 0)
        exitSource?.cancel()
        exitSource = nil
        // Whatever it left behind in its group goes too.
        kill(-pid, SIGTERM)
        pid = 0
        guard !stopping else { return }
        // Asked to restart, or ran a good while: again at once. A quick crash waits, as launchd's throttle did.
        let delay: Double = soon ? 1 : Date().timeIntervalSince(startedAt) < 30 ? 30 : 2
        soon = false
        note("\(service.name) stannade (status \(status)). Startar igen om \(Int(delay)) s.")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.start() }
    }

    func stop(_ sig: Int32 = SIGTERM) {
        if pid > 0 { kill(-pid, sig) }
    }

    func note(_ text: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) Kontrollrummet: \(text)\n"
        if let h = FileHandle(forWritingAtPath: service.log) {
            h.seekToEndOfFile()
            h.write(line.data(using: .utf8)!)
            try? h.close()
        }
    }
}

func supervise(_ file: String) -> Never {
    guard let data = FileManager.default.contents(atPath: file),
          let services = try? JSONDecoder().decode([Service].self, from: data), !services.isEmpty else {
        FileHandle.standardError.write("Kontrollrummet --supervise: kan inte läsa \(file)\n".data(using: .utf8)!)
        exit(78)
    }
    let all = services.map(Supervised.init)
    var sources: [DispatchSourceSignal] = []
    var polls: [DispatchSourceTimer] = []
    func on(_ sig: Int32, _ handler: @escaping () -> Void) {
        signal(sig, SIG_IGN)
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        s.setEventHandler(handler: handler)
        s.resume()
        sources.append(s)
    }
    // launchd stops us: stop everything, wait a little for it, then go.
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        on(sig) {
            all.forEach { $0.stopping = true; $0.stop() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                all.forEach { $0.stop(SIGKILL) }
                exit(0)
            }
            // Done as soon as every one has gone (dispatchMain runs no Timer, so a dispatch timer).
            let poll = DispatchSource.makeTimerSource(queue: .main)
            poll.schedule(deadline: .now() + 0.2, repeating: 0.2)
            poll.setEventHandler { if all.allSatisfy({ $0.pid == 0 }) { exit(0) } }
            poll.resume()
            polls.append(poll)
        }
    }
    // "Starta om servern" in the app's menu.
    on(SIGUSR1) {
        for s in all where s.service.name == "server" {
            s.soon = true
            s.stop()
        }
    }
    all.forEach { $0.start() }
    withExtendedLifetime((sources, polls)) { dispatchMain() }
}

// Started as kontrollrummet-launch: a LaunchAgent from before the single one
// (install-mac.sh replaces them). It runs its command as before, until then.
if URL(fileURLWithPath: CommandLine.arguments[0]).lastPathComponent == "kontrollrummet-launch" {
    let rest = Array(CommandLine.arguments.dropFirst())
    guard let first = rest.first else { exit(64) }
    let argv: [UnsafeMutablePointer<CChar>?] = rest.map { strdup($0) } + [nil]
    execv(first, argv)
    exit(127)
}

if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--supervise" {
    supervise(CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : NSHomeDirectory() + "/.control-room/services.json")
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
