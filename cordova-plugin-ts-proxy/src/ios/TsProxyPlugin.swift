import Foundation
import Network

// NOTA IMPORTANTE: este archivo se escribió sin acceso a un Mac/Xcode para
// compilarlo o probarlo. Replica la lógica (ya verificada en el dispositivo real)
// del proxy Android, pero revísalo con calma la primera vez que compiles para iOS:
// puede necesitar ajustes de bridging de Swift en el proyecto Xcode generado por
// cordova-ios, y no se ha confirmado el comportamiento de NWListener/URLSession
// en este contexto concreto.
//
// Servidor HTTP local (solo en 127.0.0.1) que reenvía streams remotos añadiendo
// cabeceras CORS, igual que TsProxyPlugin.java en Android.
@objc(TsProxyPlugin)
class TsProxyPlugin: CDVPlugin {
    private var listener: NWListener?
    private var port: UInt16 = 0
    private let queue = DispatchQueue(label: "TsProxyPlugin.server")
    private var activeStreams: [StreamProxy] = []
    // Algunos servidores IPTV rechazan (403) peticiones con User-Agent genérico;
    // se usa el del WebView real, recibido desde JS, en vez de uno fijo.
    private var userAgent: String = "Mozilla/5.0"

    @objc(start:)
    func start(command: CDVInvokedUrlCommand) {
        if let ua = command.argument(at: 0) as? String, !ua.isEmpty {
            userAgent = ua
        }
        if let listener = listener, listener.state == .ready {
            respondPort(command: command)
            return
        }
        do {
            let newListener = try NWListener(using: .tcp, on: .any)
            newListener.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    self.port = newListener.port?.rawValue ?? 0
                    self.respondPort(command: command)
                case .failed(let error):
                    let result = CDVPluginResult(status: .error, messageAs: "No se pudo iniciar el servidor proxy: \(error)")
                    self.commandDelegate.send(result, callbackId: command.callbackId)
                default:
                    break
                }
            }
            newListener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection: connection)
            }
            newListener.start(queue: queue)
            self.listener = newListener
        } catch {
            let result = CDVPluginResult(status: .error, messageAs: "No se pudo iniciar el servidor proxy: \(error)")
            commandDelegate.send(result, callbackId: command.callbackId)
        }
    }

    private func respondPort(command: CDVInvokedUrlCommand) {
        let result = CDVPluginResult(status: .ok, messageAs: ["port": Int(port)])
        commandDelegate.send(result, callbackId: command.callbackId)
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(on: connection, buffer: Data())
    }

    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            var newBuffer = buffer
            if let data = data, !data.isEmpty {
                newBuffer.append(data)
            }
            if let headerEnd = newBuffer.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = newBuffer.subdata(in: newBuffer.startIndex..<headerEnd.lowerBound)
                self.processRequest(headerData: headerData, connection: connection)
                return
            }
            if error != nil || isComplete {
                connection.cancel()
                return
            }
            self.receiveRequest(on: connection, buffer: newBuffer)
        }
    }

    private func processRequest(headerData: Data, connection: NWConnection) {
        guard let requestText = String(data: headerData, encoding: .isoLatin1) else {
            connection.cancel()
            return
        }
        let lines = requestText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            connection.cancel()
            return
        }
        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else {
            connection.cancel()
            return
        }
        let method = parts[0]
        let path = parts[1]

        var rangeHeader: String? = nil
        for line in lines.dropFirst() {
            if line.lowercased().hasPrefix("range:") {
                rangeHeader = line.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces)
            }
        }

        if method.uppercased() == "OPTIONS" {
            sendPreflight(connection: connection)
            return
        }

        guard path.hasPrefix("/ts-proxy"), let targetUrl = extractUrlParam(path: path),
              targetUrl.hasPrefix("http://") || targetUrl.hasPrefix("https://") else {
            sendSimpleStatus(connection: connection, code: 400, text: "Bad Request")
            return
        }

        let proxy = StreamProxy(connection: connection, method: method, targetUrl: targetUrl, rangeHeader: rangeHeader, userAgent: userAgent) { [weak self] finished in
            self?.activeStreams.removeAll { $0 === finished }
        }
        activeStreams.append(proxy)
        proxy.start()
    }

    private func extractUrlParam(path: String) -> String? {
        guard let qIndex = path.firstIndex(of: "?") else { return nil }
        let query = String(path[path.index(after: qIndex)...])
        for pair in query.components(separatedBy: "&") {
            let kv = pair.components(separatedBy: "=")
            if kv.count == 2, kv[0] == "url" {
                return kv[1].removingPercentEncoding
            }
        }
        return nil
    }

    private func sendPreflight(connection: NWConnection) {
        let response = "HTTP/1.1 204 No Content\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
            + "Access-Control-Allow-Headers: Range, Content-Type\r\n"
            + "Connection: close\r\n\r\n"
        connection.send(content: Data(response.utf8), completion: .contentProcessed({ _ in
            connection.cancel()
        }))
    }

    private func sendSimpleStatus(connection: NWConnection, code: Int, text: String) {
        let response = "HTTP/1.1 \(code) \(text)\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Connection: close\r\n\r\n"
        connection.send(content: Data(response.utf8), completion: .contentProcessed({ _ in
            connection.cancel()
        }))
    }
}

// Reenvía la respuesta de origen hacia el WebView en streaming (sin acumular todo
// en memoria, importante para TV en directo que no termina nunca), añadiendo las
// cabeceras CORS. Sin verificar: ver nota al principio del archivo.
private class StreamProxy: NSObject, URLSessionDataDelegate {
    private let connection: NWConnection
    private let method: String
    private let targetUrl: String
    private let rangeHeader: String?
    private let userAgent: String
    private let onFinished: (StreamProxy) -> Void
    private var session: URLSession?
    private var headersSent = false

    init(connection: NWConnection, method: String, targetUrl: String, rangeHeader: String?, userAgent: String, onFinished: @escaping (StreamProxy) -> Void) {
        self.connection = connection
        self.method = method
        self.targetUrl = targetUrl
        self.rangeHeader = rangeHeader
        self.userAgent = userAgent
        self.onFinished = onFinished
    }

    func start() {
        guard let url = URL(string: targetUrl) else {
            sendSimpleStatus(code: 400, text: "Bad Request")
            finish()
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        if let rangeHeader = rangeHeader {
            request.setValue(rangeHeader, forHTTPHeaderField: "Range")
        }
        let config = URLSessionConfiguration.default
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        session.dataTask(with: request).resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let httpResponse = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            sendSimpleStatus(code: 502, text: "Bad Gateway")
            finish()
            return
        }
        var headerText = "HTTP/1.1 \(httpResponse.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode))\r\n"
        headerText += "Access-Control-Allow-Origin: *\r\n"
        headerText += "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
        headerText += "Access-Control-Allow-Headers: Range, Content-Type\r\n"
        headerText += "Connection: close\r\n"
        if let contentType = httpResponse.allHeaderFields["Content-Type"] as? String {
            headerText += "Content-Type: \(contentType)\r\n"
        }
        if let contentRange = httpResponse.allHeaderFields["Content-Range"] as? String {
            headerText += "Content-Range: \(contentRange)\r\n"
        }
        headerText += "Accept-Ranges: bytes\r\n\r\n"
        headersSent = true
        connection.send(content: Data(headerText.utf8), completion: .contentProcessed({ _ in }))
        let isHead = method.uppercased() == "HEAD"
        completionHandler(isHead ? .cancel : .allow)
        if isHead {
            finish()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        connection.send(content: data, completion: .contentProcessed({ _ in }))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if !headersSent {
            sendSimpleStatus(code: 502, text: "Bad Gateway")
        }
        finish()
    }

    private func sendSimpleStatus(code: Int, text: String) {
        let response = "HTTP/1.1 \(code) \(text)\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Connection: close\r\n\r\n"
        connection.send(content: Data(response.utf8), completion: .contentProcessed({ _ in }))
    }

    private func finish() {
        connection.cancel()
        session?.invalidateAndCancel()
        onFinished(self)
    }
}
