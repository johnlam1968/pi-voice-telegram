/**
 * fw-openai-sts — host-side shim that exposes a local whisper-server
 * (whisper.cpp's `examples/server`) as an OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint.
 *
 * The on-host CUDA whisper-server (e.g. running on port 8080 with a
 * `ggml-large-v3.bin` model in VRAM) speaks the `/inference` multipart
 * convention only. This shim is a pure HTTP forwarder: it accepts
 * `POST /v1/audio/transcriptions` (OpenAI format), forwards the
 * file to the local whisper-server's `/inference`, and returns the
 * OpenAI-shaped response. The whisper-server's GPU + VRAM model
 * stays exactly as-is; the shim adds ~1ms of HTTP overhead.
 *
 * After the shim is running, ANY OpenAI-compatible client (the
 * `pi-openai-stt` provider, the official OpenAI Python SDK, curl with
 * the OpenAI multipart, etc.) can talk to the local server by just
 * pointing at the shim's port. No upstream whisper.cpp patch is
 * needed.
 *
 * Env vars:
 *   - `FW_OPENAI_STS_PORT` (default 8081)
 *   - `FW_OPENAI_STS_UPSTREAM` (default http://127.0.0.1:8080)
 *   - `FW_OPENAI_STS_HOST` (default 127.0.0.1; binds to localhost)
 *
 * On-host install:
 *   cp scripts/fw-openai-sts.ts ~/.pi/agent/bin/fw-openai-sts
 *   chmod +x ~/.pi/agent/bin/fw-openai-sts
 *   fw-openai-sts &
 *
 * Usage:
 *   OPENAI_STT_BASE_URL=http://127.0.0.1:8081/v1
 *
 * No external deps. Uses Node's built-in `http`, `fs`, `path`. jiti-loadable.
 */

import * as http from "node:http";
import { Buffer } from "node:buffer";

const PORT = Number(process.env.FW_OPENAI_STS_PORT ?? 8081);
const HOST = process.env.FW_OPENAI_STS_HOST ?? "127.0.0.1";
const UPSTREAM = (process.env.FW_OPENAI_STS_UPSTREAM ?? "http://127.0.0.1:8080").replace(
	/\/$/,
	"",
);

const LOG_PREFIX = "[fw-openai-sts]";

interface ParsedPart {
	name: string;
	filename?: string;
	contentType?: string;
	value: Buffer;
}

function log(message: string, ...rest: unknown[]): void {
	console.log(`${LOG_PREFIX} ${message}`, ...rest);
}

function die(message: string, ...rest: unknown[]): never {
	console.error(`${LOG_PREFIX} FATAL: ${message}`, ...rest);
	process.exit(1);
}

/** Minimal RFC 7578 multipart parser. Reads the entire body as a
 *  Buffer and walks the parts by the boundary marker. Returns the
 *  parts in order. Sufficient for the OpenAI `/v1/audio/transcriptions`
 *  payload (which has at most 4 small text parts + 1 file part). */
function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
	const parts: ParsedPart[] = [];
	const marker = Buffer.from(`--${boundary}`);
	const crlf = Buffer.from("\r\n\r\n");
	const sep = Buffer.from("\r\n--");

	let pos = 0;
	// Find the first boundary.
	let idx = body.indexOf(marker, pos);
	if (idx === -1) return parts;
	pos = idx + marker.length;

	while (pos < body.length) {
		// Skip the CRLF after the boundary.
		if (body[pos] === 0x2d /* '-' */ && body[pos + 1] === 0x2d) {
			// Closing boundary `--` — done.
			break;
		}
		if (body[pos] === 0x0d /* \r */ && body[pos + 1] === 0x0a /* \n */) {
			pos += 2;
		}

		// Headers end at the first CRLF CRLF.
		const headerEnd = body.indexOf(crlf, pos);
		if (headerEnd === -1) break;
		const headerText = body.slice(pos, headerEnd).toString("utf8");
		const headerLines = headerText.split("\r\n");
		const part: ParsedPart = { name: "", value: Buffer.alloc(0) };
		for (const line of headerLines) {
			if (line.toLowerCase().startsWith("content-disposition:")) {
				const nameMatch = line.match(/name="([^"]+)"/);
				if (nameMatch) part.name = nameMatch[1];
				const filenameMatch = line.match(/filename="([^"]+)"/);
				if (filenameMatch) part.filename = filenameMatch[1];
			} else if (line.toLowerCase().startsWith("content-type:")) {
				part.contentType = line.split(":")[1]?.trim();
			}
		}

		// Body starts after the CRLF CRLF; ends at the next boundary.
		const bodyStart = headerEnd + crlf.length;
		const nextBoundary = body.indexOf(sep, bodyStart);
		const bodyEnd = nextBoundary === -1 ? body.length : nextBoundary;
		// Strip the trailing CRLF before the boundary.
		const rawValue = body.slice(
			bodyStart,
			bodyEnd >= 2 && body[bodyEnd - 2] === 0x0d && body[bodyEnd - 1] === 0x0a
				? bodyEnd - 2
				: bodyEnd,
		);
		part.value = rawValue;
		parts.push(part);

		// Move past this part's terminator.
		if (nextBoundary === -1) break;
		pos = nextBoundary + sep.length;
	}

	return parts;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function sendJson(
	res: http.ServerResponse,
	status: number,
	body: unknown,
): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(json),
	});
	res.end(json);
}

function sendText(
	res: http.ServerResponse,
	status: number,
	body: string,
): void {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

/** Forward the parsed OpenAI parts to the local whisper-server's
 *  `/inference` endpoint as multipart. whisper-server returns plain
 *  text. Returns the upstream body as a string. */
async function callWhisperInference(
	parts: ParsedPart[],
	whisperLang: string,
): Promise<string> {
	const file = parts.find((p) => p.name === "file");
	if (!file || file.value.length === 0) {
		throw Object.assign(new Error("missing or empty 'file' part"), {
			httpStatus: 400,
		});
	}

	// Build the upstream multipart. We use fetch's FormData + Blob so
	// the boundary is generated and Content-Type is set correctly.
	const form = new FormData();
	const filename = file.filename ?? "voice.ogg";
	form.append(
		"file",
		new Blob([file.value], { type: file.contentType ?? "audio/ogg" }),
		filename,
	);
	form.append("language", whisperLang);
	form.append("response_format", "text");

	const url = `${UPSTREAM}/inference`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			body: form,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		throw Object.assign(
			new Error(`upstream fetch failed: ${(err as Error).message}`),
			{ httpStatus: 502 },
		);
	}
	clearTimeout(timer);

	const text = await res.text();
	if (!res.ok) {
		throw Object.assign(
			new Error(`upstream ${res.status}: ${text.slice(0, 200)}`),
			{ httpStatus: res.status >= 500 ? 502 : 400 },
		);
	}
	return text;
}

/** Inspect the inbound request and respond appropriately. */
async function handleOpenAiTranscriptions(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const contentType = req.headers["content-type"] ?? "";
	if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
		sendJson(res, 400, {
			error: {
				message: "Content-Type must be multipart/form-data",
				type: "invalid_request_error",
			},
		});
		return;
	}
	const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
	if (!boundaryMatch) {
		sendJson(res, 400, {
			error: {
				message: "missing multipart boundary",
				type: "invalid_request_error",
			},
		});
		return;
	}
	const boundary = boundaryMatch[1] ?? boundaryMatch[2];

	const body = await readBody(req);
	const parts = parseMultipart(body, boundary);
	if (parts.length === 0) {
		sendJson(res, 400, {
			error: {
				message: "no multipart parts found",
				type: "invalid_request_error",
			},
		});
		return;
	}

	const langPart = parts.find((p) => p.name === "language");
	const lang = langPart ? langPart.value.toString("utf8") : "yue";

	const modelPart = parts.find((p) => p.name === "model");
	const model = modelPart ? modelPart.value.toString("utf8") : "whisper-1";
	log(`transcribe model=${model} lang=${lang} parts=${parts.length}`);

	const responseFormatPart = parts.find((p) => p.name === "response_format");
	const responseFormat = responseFormatPart
		? responseFormatPart.value.toString("utf8")
		: "text";

	let transcript: string;
	try {
		transcript = await callWhisperInference(parts, lang);
	} catch (err) {
		const httpStatus = (err as { httpStatus?: number }).httpStatus ?? 500;
		const message = (err as Error).message;
		log(`upstream error: ${message}`);
		sendJson(res, httpStatus, {
			error: {
				message,
				type: "upstream_error",
			},
		});
		return;
	}

	if (responseFormat === "text") {
		sendText(res, 200, transcript);
	} else {
		// OpenAI's default JSON shape.
		sendJson(res, 200, { text: transcript });
	}
}

const server = http.createServer((req, res) => {
	if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
		handleOpenAiTranscriptions(req, res).catch((err) => {
			log(`unhandled error: ${(err as Error).message}`);
			if (!res.headersSent) {
				sendJson(res, 500, {
					error: {
						message: "internal server error",
						type: "internal_error",
					},
				});
			}
		});
		return;
	}
	if (req.method === "GET" && req.url === "/") {
		sendText(
			res,
			200,
			`fw-openai-sts — OpenAI-compatible STT shim\nupstream: ${UPSTREAM}\nlistening: ${HOST}:${PORT}\nPOST /v1/audio/transcriptions (multipart: file, model, language, response_format)\n`,
		);
		return;
	}
	sendJson(res, 404, {
		error: { message: "not found", type: "not_found" },
	});
});

server.listen(PORT, HOST, () => {
	// When `PORT=0`, the OS picks a free port; the actual bound port
	// is available via `server.address().port`. Print the real port
	// so callers (and the test harness) can find us.
	const addr = server.address();
	const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
	log(`listening on http://${HOST}:${actualPort}, forwarding to ${UPSTREAM}/inference`);
});

process.on("SIGINT", () => {
	log("SIGINT — closing server");
	server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
	log("SIGTERM — closing server");
	server.close(() => process.exit(0));
});

// Fail fast on bad config. Allow `PORT=0` (let the OS pick a free
// port — useful for tests and sandboxed environments where a
// specific port might be taken).
if (!Number.isFinite(PORT) || PORT < 0 || PORT > 65535) {
	die(`invalid FW_OPENAI_STS_PORT: ${PORT}`);
}
if (!/^https?:\/\//.test(UPSTREAM)) {
	die(`FW_OPENAI_STS_UPSTREAM must start with http:// or https://, got: ${UPSTREAM}`);
}
