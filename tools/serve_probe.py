#!/usr/bin/env python3
"""Serve only the public probe artifacts, never local game inputs."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import os

ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # A long play session can fill an unattended terminal's output pipe;
        # blocked logging then stalls asset responses. Still report HTTP errors.
        if len(args) > 1 and str(args[1]).isdigit() and int(args[1]) >= 400:
            super().log_message(format, *args)

    def send_head(self):
        self.byte_range = None
        requested = self.headers.get('Range')
        path = self.translate_path(self.path)
        if requested and os.path.isfile(path):
            size = os.path.getsize(path)
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            if not match or not any(match.groups()):
                self.send_error(416, 'Unsupported byte range')
                return None
            first, last = match.groups()
            start = int(first) if first else max(0, size - int(last))
            end = min(size - 1, int(last)) if first and last else size - 1
            if start >= size or end < start:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
            stream = open(path, 'rb')
            stream.seek(start)
            self.byte_range = end - start + 1
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(self.byte_range))
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            return stream
        return super().send_head()

    def copyfile(self, source, outputfile):
        if self.byte_range is None:
            return super().copyfile(source, outputfile)
        remaining = self.byte_range
        while remaining:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer.request_queue_size = 64
    server = ThreadingHTTPServer(("127.0.0.1", 8778), partial(Handler, directory=str(ROOT / "dist/probe")))
    print("Runtime probe: http://127.0.0.1:8778 (game is not booted)", flush=True)
    server.serve_forever()
