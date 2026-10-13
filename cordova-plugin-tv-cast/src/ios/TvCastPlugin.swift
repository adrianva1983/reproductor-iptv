import Foundation
import GoogleCast

// NOTA IMPORTANTE: este archivo se escribió sin acceso a un Mac/Xcode para
// compilarlo o probarlo (misma limitación ya señalada en TsProxyPlugin.swift).
// Replica la lógica ya verificada en Android (TvCastPlugin.java: inicialización
// perezosa del contexto de Cast, un botón de Cast oculto para abrir el selector
// nativo sin construir UI propia, y los mismos tres eventos de sesión). Revisar
// con calma la primera vez que se compile para iOS: los nombres exactos de los
// métodos de GCKSessionManagerListener/GCKCastStateDelegate pueden haber
// cambiado entre versiones del SDK de Google Cast; comprobar contra la versión
// del pod "google-cast-sdk" fijada en plugin.xml.
@objc(TvCastPlugin)
class TvCastPlugin: CDVPlugin, GCKSessionManagerListener, GCKCastStateDelegate {

    private var castButton: GCKUICastButton?
    private var availabilityCallbackId: String?
    private var sessionCallbackId: String?

    override func pluginInitialize() {
        let criteria = GCKDiscoveryCriteria(applicationID: kGCKDefaultMediaReceiverApplicationID)
        let options = GCKCastOptions(discoveryCriteria: criteria)
        GCKCastContext.setSharedInstanceWith(options)

        let context = GCKCastContext.sharedInstance()
        context.sessionManager.add(self)
        context.add(self)

        // Botón de Cast oculto: igual truco que en Android (MediaRouteButton +
        // performClick), para reutilizar el selector de dispositivos del SDK sin
        // construir una UI de descubrimiento propia.
        let button = GCKUICastButton(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        button.alpha = 0
        self.viewController.view.addSubview(button)
        castButton = button
    }

    @objc(isAvailable:)
    func isAvailable(command: CDVInvokedUrlCommand) {
        commandDelegate.send(CDVPluginResult(status: .ok), callbackId: command.callbackId)
    }

    @objc(registerAvailabilityCallback:)
    func registerAvailabilityCallback(command: CDVInvokedUrlCommand) {
        availabilityCallbackId = command.callbackId
    }

    @objc(registerSessionCallback:)
    func registerSessionCallback(command: CDVInvokedUrlCommand) {
        sessionCallbackId = command.callbackId
    }

    @objc(showCastPicker:)
    func showCastPicker(command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async {
            self.castButton?.sendActions(for: .touchUpInside)
        }
        commandDelegate.send(CDVPluginResult(status: .ok), callbackId: command.callbackId)
    }

    @objc(loadMedia:)
    func loadMedia(command: CDVInvokedUrlCommand) {
        guard let urlString = command.argument(at: 0) as? String, let url = URL(string: urlString) else {
            commandDelegate.send(CDVPluginResult(status: .ok), callbackId: command.callbackId)
            return
        }
        let title = command.argument(at: 1) as? String ?? ""
        let contentType = command.argument(at: 2) as? String ?? "video/mp4"

        DispatchQueue.main.async {
            guard let session = GCKCastContext.sharedInstance().sessionManager.currentCastSession,
                  let remoteMediaClient = session.remoteMediaClient else {
                return
            }
            let metadata = GCKMediaMetadata(metadataType: .generic)
            if !title.isEmpty {
                metadata.setString(title, forKey: kGCKMetadataKeyTitle)
            }
            let mediaInfoBuilder = GCKMediaInformationBuilder(contentURL: url)
            mediaInfoBuilder.streamType = .live
            mediaInfoBuilder.contentType = contentType
            mediaInfoBuilder.metadata = metadata
            let mediaInfo = mediaInfoBuilder.build()

            let requestBuilder = GCKMediaLoadRequestDataBuilder()
            requestBuilder.mediaInformation = mediaInfo
            requestBuilder.autoplay = true
            remoteMediaClient.loadMedia(with: requestBuilder.build())
        }
        commandDelegate.send(CDVPluginResult(status: .ok), callbackId: command.callbackId)
    }

    @objc(stop:)
    func stop(command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async {
            GCKCastContext.sharedInstance().sessionManager.endSessionAndStopCasting(true)
        }
        commandDelegate.send(CDVPluginResult(status: .ok), callbackId: command.callbackId)
    }

    // MARK: - GCKCastStateDelegate

    func castStateDidChange(to state: GCKCastState) {
        guard let callbackId = availabilityCallbackId else { return }
        let available = state != .noDevicesAvailable
        let result = CDVPluginResult(status: .ok, messageAs: available)
        result?.setKeepCallbackAs(true)
        commandDelegate.send(result, callbackId: callbackId)
    }

    // MARK: - GCKSessionManagerListener

    func sessionManager(_ sessionManager: GCKSessionManager, willStart session: GCKSession) {
        sendSessionState("connecting", deviceName: nil)
    }

    func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKSession) {
        sendSessionState("connected", deviceName: session.device.friendlyName)
    }

    func sessionManager(_ sessionManager: GCKSessionManager, didResumeSession session: GCKSession) {
        sendSessionState("connected", deviceName: session.device.friendlyName)
    }

    func sessionManager(_ sessionManager: GCKSessionManager, didFailToStart session: GCKSession, withError error: Error) {
        sendSessionState("disconnected", deviceName: nil)
    }

    func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKSession, withError error: Error?) {
        sendSessionState("disconnected", deviceName: nil)
    }

    func sessionManager(_ sessionManager: GCKSessionManager, didSuspend session: GCKSession, with reason: GCKConnectionSuspendReason) {
        sendSessionState("disconnected", deviceName: nil)
    }

    private func sendSessionState(_ state: String, deviceName: String?) {
        guard let callbackId = sessionCallbackId else { return }
        var payload: [String: String] = ["state": state]
        if let deviceName = deviceName { payload["deviceName"] = deviceName }
        let result = CDVPluginResult(status: .ok, messageAs: payload)
        result?.setKeepCallbackAs(true)
        commandDelegate.send(result, callbackId: callbackId)
    }
}
