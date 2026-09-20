"use strict";

(function () {
    var http = require("http");
    var https = require("https");
    var urlLib = require("url");
    var crypto = require("crypto");

    var PORT = 8770;
    var API_KEY = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh";
    var API_SECRET = "16CCEB3D-AB42-077D-36A1-F355324E4237";
    var session = {
        protocol: "http",
        host: "",
        port: "5666",
        token: "",
        accessCode: "",
        deviceId: "tizen-tv"
    };

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
        var nonce = String(Math.floor(Math.random() * 900000) + 100000);
        var timestamp = String(Date.now());
        var cleanPath = String(path || "").split("?")[0];
        var paramContent = String(method || "GET").toUpperCase() === "GET"
            ? getQueryParamContent(path)
            : String(bodyText || "");
        var signRaw = [
            API_KEY,
            cleanPath,
            nonce,
            timestamp,
            md5(paramContent),
            API_SECRET
        ].join("_");
        return "nonce=" + nonce + "&timestamp=" + timestamp + "&sign=" + md5(signRaw);
    }

    function updateSession(env) {
        if (!env) return;
        if (env.protocol) session.protocol = env.protocol === "https" ? "https" : "http";
        if (env.host) session.host = String(env.host).trim();
        if (env.port != null) session.port = String(env.port).trim();
        if (env.token) session.token = String(env.token);
        if (env.accessCode != null) session.accessCode = String(env.accessCode);
        if (env.deviceId) session.deviceId = String(env.deviceId);
    }

    function originFor(s) {
        return (s.protocol === "https" ? "https" : "http") + "://" +
            s.host + (s.port ? ":" + s.port : "");
    }

    function makeHeaders(path, method, bodyText, s, extra) {
        var headers = {
            "Accept": "*/*",
            "User-Agent": "okhttp/4.12.0",
            "Authorization": String(s.token || ""),
            "Cookie": "mode=relay",
            "x-access-source": "app",
            "x-device-id": String(s.deviceId || "tizen-tv"),
            "X-Trim-Client-Version": "13308",
            "authx": makeAuthx(path, method, bodyText)
        };
        if (method !== "GET" && method !== "HEAD") {
            headers["Content-Type"] = "application/json";
        }
        if (s.accessCode) {
            headers["x-access-code"] = Buffer.from(String(s.accessCode), "utf8").toString("base64");
        }
        if (extra) {
            Object.keys(extra).forEach(function (k) {
                if (extra[k] != null && extra[k] !== "") headers[k] = extra[k];
            });
        }
        return headers;
    }

    function upstreamOptions(targetUrl, method, headers) {
        var parsed = urlLib.parse(targetUrl);
        var opts = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
            path: (parsed.pathname || "/") + (parsed.search || ""),
            method: method,
            headers: headers
        };
        if (parsed.protocol === "https:") opts.rejectUnauthorized = false;
        return opts;
    }

    function transportFor(url) {
        return String(url).indexOf("https:") === 0 ? https : http;
    }

    function requestBuffered(targetUrl, method, headers, bodyText, callback) {
        var req;
        try {
            req = transportFor(targetUrl).request(
                upstreamOptions(targetUrl, method, headers),
                function (response) {
                    var chunks = [];
                    response.on("data", function (chunk) { chunks.push(chunk); });
                    response.on("end", function () {
                        callback(null, {
                            status: response.statusCode || 200,
                            headers: response.headers || {},
                            body: Buffer.concat(chunks)
                        });
                    });
                }
            );
        } catch (e) {
            callback(e);
            return;
        }
        req.setTimeout(15000, function () { req.destroy(new Error("timeout")); });
        req.on("error", function (err) { callback(err); });
        if (method !== "GET" && method !== "HEAD" && bodyText) req.write(bodyText);
        req.end();
    }

    function sendJson(res, status, body, contentType) {
        res.statusCode = status;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", contentType || "application/json; charset=utf-8");
        res.end(body == null ? "" : body);
    }

    function readBody(req, callback) {
        var chunks = [];
        var size = 0;
        req.on("data", function (chunk) {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) {
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", function () {
            callback(Buffer.concat(chunks).toString("utf8"));
        });
    }

    function imagePath(src, width) {
        var p = String(src || "");
        if (!p) return "";
        if (/^https?:\/\//i.test(p)) {
            try {
                var u = urlLib.parse(p);
                p = (u.pathname || "") + (u.search || "");
            } catch (e) {}
        }
        if (p.indexOf("/v/api/v1/sys/img") === 0) return p;
        if (p.indexOf("/api/v1/sys/img") === 0) return "/v" + p;
        p = p.replace(/^\/+/, "");
        var result = "/v/api/v1/sys/img/" + p;
        if (width && result.indexOf("?") < 0) result += "?w=" + width;
        return result;
    }

    function pipeUpstream(req, res, path, method, extraHeaders) {
        if (!session.host) {
            sendJson(res, 503, JSON.stringify({ code: 503, msg: "Fygo session not configured", data: null }));
            return;
        }
        var wirePath = rewriteFygoPath(path);
        var target = originFor(session) + wirePath;
        var headers = makeHeaders(wirePath, method, "", session, extraHeaders || {});
        var up;
        try {
            up = transportFor(target).request(
                upstreamOptions(target, method, headers),
                function (response) {
                    res.statusCode = response.statusCode || 200;
                    var copy = [
                        "content-type", "content-length", "content-range",
                        "accept-ranges", "etag", "last-modified", "cache-control"
                    ];
                    copy.forEach(function (h) {
                        if (response.headers[h] != null) res.setHeader(h, response.headers[h]);
                    });
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    if (method === "HEAD") {
                        response.resume();
                        res.end();
                    } else {
                        response.pipe(res);
                    }
                }
            );
        } catch (e) {
            sendJson(res, 502, JSON.stringify({ code: 502, msg: String(e.message || e), data: null }));
            return;
        }
        up.setTimeout(30000, function () { up.destroy(new Error("timeout")); });
        up.on("error", function (err) {
            if (!res.headersSent) {
                sendJson(res, 502, JSON.stringify({ code: 502, msg: "Fygo proxy: " + String(err.message || err), data: null }));
            } else {
                try { res.end(); } catch (e) {}
            }
        });
        up.end();
    }

    var server = http.createServer(function (req, res) {
        var parsed = urlLib.parse(req.url, true);
        var pathname = parsed.pathname || "/";

        if (req.method === "OPTIONS") {
            sendJson(res, 204, "", "text/plain");
            return;
        }

        if ((req.method === "GET" || req.method === "HEAD") && pathname === "/image") {
            var ipath = imagePath(parsed.query.src || "", parsed.query.w || "420");
            if (!ipath) {
                sendJson(res, 400, JSON.stringify({ code: 400, msg: "missing image", data: null }));
                return;
            }
            pipeUpstream(req, res, ipath, req.method, {});
            return;
        }

        if ((req.method === "GET" || req.method === "HEAD") && pathname === "/media") {
            var guid = String(parsed.query.guid || "");
            if (!guid) {
                sendJson(res, 400, JSON.stringify({ code: 400, msg: "missing media guid", data: null }));
                return;
            }
            var rangeHeaders = {};
            if (req.headers.range) rangeHeaders.Range = req.headers.range;
            pipeUpstream(
                req,
                res,
                "/v/api/v1/media/range/" + encodeURIComponent(guid),
                req.method,
                rangeHeaders
            );
            return;
        }

        if (req.method !== "POST" || pathname !== "/fygo") {
            sendJson(res, 404, JSON.stringify({ code: 404, msg: "not found", data: null }));
            return;
        }

        readBody(req, function (raw) {
            var env;
            try {
                env = JSON.parse(raw || "{}");
            } catch (e) {
                sendJson(res, 400, JSON.stringify({ code: 400, msg: "invalid proxy request", data: null }));
                return;
            }

            updateSession(env);

            var apiPath = String(env.path || "");
            var method = String(env.method || "GET").toUpperCase();
            var bodyText = typeof env.bodyText === "string" ? env.bodyText : "";

            if (!session.host || !apiPath || apiPath.charAt(0) !== "/") {
                sendJson(res, 400, JSON.stringify({ code: 400, msg: "invalid Fygo target", data: null }));
                return;
            }

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

            var wirePath = rewriteFygoPath(apiPath);
            var target = originFor(session) + wirePath;
            var headers = makeHeaders(wirePath, method, bodyText, session, {});
            if (bodyText && method !== "GET" && method !== "HEAD") {
                headers["Content-Length"] = Buffer.byteLength(bodyText, "utf8");
            }

            requestBuffered(target, method, headers, bodyText, function (err, result) {
                if (err) {
                    sendJson(res, 502, JSON.stringify({
                        code: 502,
                        msg: "Fygo proxy: " + String(err.message || err),
                        data: null
                    }));
                    return;
                }
                var ct = result.headers["content-type"] || "application/json; charset=utf-8";
                sendJson(res, result.status, result.body, ct);
            });
        });
    });

    server.on("error", function (err) {
        if (!err || err.code !== "EADDRINUSE") throw err;
    });

    server.listen(PORT, "127.0.0.1");
})();
