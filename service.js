"use strict";

(function () {
    var http = require("http");
    var crypto = require("crypto");
    var fetch = require("node-fetch");

    var PORT = 8765;
    var SIGN_SECRET = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh";
    var API_KEY = "33AF5200-D827-4E6A-889D-96103DF6B92F";

    function md5(value) {
        return crypto.createHash("md5").update(String(value == null ? "" : value), "utf8").digest("hex");
    }

    function safeDecode(value) {
        try {
            return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
        } catch (e) {
            return String(value || "");
        }
    }

    // OkHttp HttpUrl.queryParameterNames + queryParameter(name):
    // unique parameter names, in URL order, decoded, then key=value joined by &.
    function getQueryParamContent(path) {
        var q = String(path || "").indexOf("?");
        if (q < 0) return "";

        var raw = String(path).substring(q + 1);
        if (!raw) return "";

        var parts = raw.split("&");
        var names = [];
        var values = {};
        var i, p, eq, name, value;

        for (i = 0; i < parts.length; i++) {
            p = parts[i];
            eq = p.indexOf("=");
            name = safeDecode(eq >= 0 ? p.substring(0, eq) : p);
            value = safeDecode(eq >= 0 ? p.substring(eq + 1) : "");
            if (!Object.prototype.hasOwnProperty.call(values, name)) {
                names.push(name);
                values[name] = value;
            }
        }

        names.sort();\n        return names.map(function (n) {
            return n + "=" + values[n];
        }).join("&");
    }

    function makeAuthx(path, method, bodyText) {
        var nonce = String(Math.floor(Math.random() * 2147483646) + 1);
        var timestamp = String(Date.now());
        var paramContent = String(method || "GET").toUpperCase() === "GET"
            ? getQueryParamContent(path)
            : String(bodyText || "");
        var paramDigest = md5(paramContent);
        var sign = md5([
            SIGN_SECRET,
            String(path || "").split("?")[0],
            nonce,
            timestamp,
            paramDigest,
            API_KEY
        ].join("_"));

        return "nonce=" + nonce + "&timestamp=" + timestamp + "&sign=" + sign;
    }

    function send(res, status, body, contentType) {
        res.statusCode = status;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", contentType || "application/json; charset=utf-8");
        res.end(body == null ? "" : String(body));
    }

    function readBody(req, callback) {
        var chunks = [];
        var size = 0;
        req.on("data", function (chunk) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", function () {
            callback(Buffer.concat(chunks).toString("utf8"));
        });
    }

    var server = http.createServer(function (req, res) {
        if (req.method === "OPTIONS") {
            send(res, 204, "", "text/plain");
            return;
        }

        if (req.method !== "POST" || req.url.split("?")[0] !== "/fygo") {
            send(res, 404, JSON.stringify({ code: 404, msg: "not found", data: null }));
            return;
        }

        readBody(req, function (raw) {
            var env;
            try {
                env = JSON.parse(raw || "{}");
            } catch (e) {
                send(res, 400, JSON.stringify({ code: 400, msg: "invalid proxy request", data: null }));
                return;
            }

            var protocol = env.protocol === "https" ? "https" : "http";
            var host = String(env.host || "").trim();
            var port = String(env.port || "").trim();
            var apiPath = String(env.path || "");
            var method = String(env.method || "GET").toUpperCase();
            var bodyText = typeof env.bodyText === "string" ? env.bodyText : "";

            if (!host || !apiPath || apiPath.charAt(0) !== "/") {
                send(res, 400, JSON.stringify({ code: 400, msg: "invalid Fygo target", data: null }));
                return;
            }

            var target = protocol + "://" + host + (port ? ":" + port : "") + apiPath;
            var headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-access-source": "app",
                "x-device-id": String(env.deviceId || "tizen-tv"),
                "X-Trim-Client-Version": "1.3.3",
                "authx": makeAuthx(apiPath, method, bodyText)
            };

            if (env.accessCode) headers["x-access-code"] = String(env.accessCode);

            var opts = { method: method, headers: headers };
            if (method !== "GET" && method !== "HEAD") opts.body = bodyText;

            fetch(target, opts)
                .then(function (upstream) {
                    return upstream.text().then(function (text) {
                        send(
                            res,
                            upstream.status || 200,
                            text,
                            upstream.headers && upstream.headers.get
                                ? (upstream.headers.get("content-type") || "application/json; charset=utf-8")
                                : "application/json; charset=utf-8"
                        );
                    });
                })
                .catch(function (err) {
                    send(res, 502, JSON.stringify({
                        code: 502,
                        msg: "Fygo proxy: " + (err && err.message ? err.message : String(err)),
                        data: null
                    }));
                });
        });
    });

    server.on("error", function (err) {
        // TizenBrew keeps services alive. If this module is reloaded while the
        // previous instance still owns the port, that existing proxy is usable.
        if (!err || err.code !== "EADDRINUSE") throw err;
    });

    server.listen(PORT, "127.0.0.1");
})();
