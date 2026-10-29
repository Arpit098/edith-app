"""A fake whisper.cpp whisper-server on 127.0.0.1 (random port): POST /inference parses the multipart
upload like the real one and answers from a script, so tests need no model and no network."""
import email.parser
import email.policy
import io
import json
import socket
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeWhisper:
    """`answers` is a list of (status, body dict) used in order; the last one repeats.
    Each request is recorded as {"fields": {name: str}, "wav": {channels, rate, width, seconds}}."""

    def __init__(self, answers=None):
        self.answers = list(answers or [(200, {"text": " hello edith", "language": "en"})])
        self.requests = []
        self.release = threading.Event()  # set() unless a test wants requests to hang
        self.release.set()
        self.arrived = threading.Event()  # set when a request has been received
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
                    b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
                fields, info = {}, None
                for part in msg.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    data = part.get_payload(decode=True)
                    if name == "file":
                        with wave.open(io.BytesIO(data)) as w:
                            info = {"channels": w.getnchannels(), "rate": w.getframerate(),
                                    "width": w.getsampwidth(), "seconds": w.getnframes() / w.getframerate()}
                    else:
                        fields[name] = data.decode()
                fake.requests.append({"path": self.path, "fields": fields, "wav": info})
                fake.arrived.set()
                fake.release.wait(10)
                status, body = fake.answers.pop(0) if len(fake.answers) > 1 else fake.answers[0]
                out = json.dumps(body).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                except (BrokenPipeError, ConnectionResetError):  # the client timed out and left
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        # A long idle poll: close() wakes it with a connection instead (the default 0.5 s poll made
        # every close wait up to half a second).
        self._thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 60}, daemon=True)
        self._thread.start()

    def close(self):
        self.release.set()
        stopper = threading.Thread(target=self.server.shutdown)
        stopper.start()
        while stopper.is_alive():  # serve_forever sees the shutdown when select() wakes: wake it
            try:
                socket.create_connection(self.server.server_address, timeout=1).close()
            except OSError:
                pass
            stopper.join(0.05)
        self.server.server_close()
        self._thread.join(5)


def wav(seconds: float, rate: int = 16000, channels: int = 1) -> bytes:
    """A silent 16-bit PCM WAV."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * channels * int(seconds * rate))
    return out.getvalue()
