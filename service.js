"use strict";

(function () {
    var http = require("http");
    var https = require("https");
    var urlLib = require("url");
    var crypto = require("crypto");

    var PORT = 8769;
    var API_KEY = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh";
    var API_SECRET = "16CCEB3D-AB42-077D-36A1-F355324E4237";

    function md5(value) {
        return crypto.createHash("md5")
            .update(String(value == null ? "" : value), "utf8")
            .digest("hex");
    }

    function safeDecode(value) {
        try {
            return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
        } catch (e) {
            return String(value || "");
        }
    }

    // Mirrors Fygo TV Android 1.3.3's first OkHttp interceptor (LkI):
    // selected public API paths are rewritten to their /intl/ equivalents
    // before HeaderInsertInterceptor and SignerInterceptor run.
    function rewriteFygoPath(path) {
        var full = String(path || "");
        var q = full.indexOf("?");
        var pathname = q >= 0 ? full.substring(0, q) : full;
        var query = q >= 0 ? full.substring(q) : "";

        var exact = {
            "/v/api/v1/login": "/v/api/intl/v1/login",
            "/v/api/v2/user/loginByPassword": "/v/api/intl/v2/user/loginByPassword",
            "/v/api/v1/logincode/generate": "/v/api/intl/v1/logincode/generate",
            "/v/api/v1/user/status/check": "/v/api/intl/v1/user/status/check",
            "/v/api/v1/sys/config": "/v/api/intl/v1/sys/config"
        };

        if (Object.prototype.hasOwnProperty.call(exact, pathname)) {
            pathname = exact[pathname];
        } else if (pathname.indexOf("/v/api/v1/logincode/") === 0) {
            pathname = "/v/api/intl/v1/logincode/" +
                pathname.substring("/v/api/v1/logincode/".length);
        }

        return pathname + query;
    }

    // Matches the Android SignerInterceptor behaviour for GET requests:
    // query parameter names are canonicalised and key=value pairs form paramContent.
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

        names.sort();
        return names.map(function (n) {
            return n + "=" + values[n];
        }).join("&");
    }

    function makeAuthx(path, method, bodyText) {
        // Official clients use a six-digit nonce.
        var nonce = String(Math.floor(Math.random() * 900000) + 100000);
        var timestamp = String(Date.now());
        var cleanPath = String(path || "").split("?")[0];
        var paramContent = String(method || "GET").toUpperCase() === "GET"
            ? getQueryParamContent(path)
            : String(bodyText || "");

        var payloadMd5 = md5(paramContent);
        var signRaw = [
            API_KEY,
            cleanPath,
            nonce,
            timestamp,
            payloadMd5,
            API_SECRET
        ].join("_");

        return "nonce=" + nonce + "&timestamp=" + timestamp + "&sign=" + md5(signRaw);
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

    function upstreamRequest(targetUrl, method, headers, bodyText, callback) {
        var parsed;
        try {
            parsed = urlLib.parse(targetUrl);
        } catch (e) {
            callback(e);
            return;
        }

        var transport = parsed.protocol === "https:" ? https : http;
        var opts = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
            path: (parsed.pathname || "/") + (parsed.search || ""),
            method: method,
            headers: headers
        };

        // FygoOS can use a self-signed certificate on the local HTTPS port.
        if (parsed.protocol === "https:") opts.rejectUnauthorized = false;

        var upstream = transport.request(opts, function (response) {
            var chunks = [];
            response.on("data", function (chunk) { chunks.push(chunk); });
            response.on("end", function () {
                callback(null, {
                    status: response.statusCode || 200,
                    contentType: response.headers["content-type"] || "application/json; charset=utf-8",
                    body: Buffer.concat(chunks).toString("utf8")
                });
            });
        });

        upstream.setTimeout(10000, function () {
            upstream.destroy(new Error("timeout"));
        });
        upstream.on("error", function (err) { callback(err); });

        if (method !== "GET" && method !== "HEAD" && bodyText) {
            upstream.write(bodyText);
        }
        upstream.end();
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

            if (env.hashPassword && bodyText) {
                try {
                    var loginBody = JSON.parse(bodyText);
                    if (loginBody && typeof loginBody.password === "string") {
                        loginBody.password = crypto.createHash("sha256")
                            .update(loginBody.password, "utf8")
                            .digest("hex");
                        bodyText = JSON.stringify(loginBody);
                    }
                } catch (e) {}
            }

            if (!host || !apiPath || apiPath.charAt(0) !== "/") {
                send(res, 400, JSON.stringify({ code: 400, msg: "invalid Fygo target", data: null }));
                return;
            }

            var wirePath = rewriteFygoPath(apiPath);
            var target = protocol + "://" + host + (port ? ":" + port : "") + wirePath;
            var headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "okhttp/4.12.0",
                "Authorization": String(env.token || ""),
                "Cookie": "mode=relay",
                "x-access-source": "app",
                "x-device-id": String(env.deviceId || "tizen-tv"),
                "X-Trim-Client-Version": "13308",
                "authx": makeAuthx(wirePath, method, bodyText)
            };
            if (env.accessCode) {
                headers["x-access-code"] = Buffer.from(String(env.accessCode), "utf8").toString("base64");
            }
            if (bodyText && method !== "GET" && method !== "HEAD") {
                headers["Content-Length"] = Buffer.byteLength(bodyText, "utf8");
            }

            upstreamRequest(target, method, headers, bodyText, function (err, result) {
                if (err) {
                    send(res, 502, JSON.stringify({
                        code: 502,
                        msg: "Fygo proxy: " + (err && err.message ? err.message : String(err)),
                        data: null
                    }));
                    return;
                }
                send(res, result.status, result.body, result.contentType);
            });
        });
    });

    server.on("error", function (err) {
        if (!err || err.code !== "EADDRINUSE") throw err;
    });

    server.listen(PORT, "127.0.0.1");
})();
