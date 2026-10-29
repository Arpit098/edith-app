"""A small WebSocket server side (RFC 6455), stdlib only: the handshake, framing, ping/pong, close.

Only what /v1/stream needs: text messages out, and from the client only control frames (plus
text, which is read and ignored). Client frames must be masked (RFC 6455 §5.1); fragments are
joined; control frames must be short and unfragmented; a message over max_message closes with 1009.
"""
import base64
import hashlib
import os
import struct

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
CLOSE_NORMAL, CLOSE_PROTOCOL, CLOSE_UNSUPPORTED, CLOSE_POLICY, CLOSE_TOO_BIG = 1000, 1002, 1003, 1008, 1009


class ProtocolError(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code, self.reason = code, reason


def accept_key(key: str) -> str:
    """Sec-WebSocket-Accept for a client's Sec-WebSocket-Key."""
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def valid_key(key) -> bool:
    try:
        return bool(key) and len(base64.b64decode(key, validate=True)) == 16
    except ValueError:
        return False


def encode(opcode: int, payload: bytes = b"") -> bytes:
    """One final, unmasked frame (servers never mask)."""
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 1 << 16:
        head += bytes([126]) + struct.pack("!H", n)
    else:
        head += bytes([127]) + struct.pack("!Q", n)
    return head + payload


def close_frame(code: int, reason: str = "") -> bytes:
    return encode(OP_CLOSE, struct.pack("!H", code) + reason.encode()[:120])


def mask(payload: bytes, key: bytes) -> bytes:
    """XOR with the 4-byte key (masking and unmasking are the same)."""
    if not payload:
        return payload
    k = (key * (len(payload) // 4 + 1))[:len(payload)]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(k, "big")).to_bytes(len(payload), "big")


def client_frame(opcode: int, payload: bytes = b"", fin: bool = True) -> bytes:
    """A masked frame as a client sends it (for tests)."""
    key = os.urandom(4)
    n = len(payload)
    head = bytes([(0x80 if fin else 0) | opcode])
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 1 << 16:
        head += bytes([0x80 | 126]) + struct.pack("!H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack("!Q", n)
    return head + key + mask(payload, key)


class Reader:
    """Reads client frames from a socket-like `recv(n)`; returns whole messages."""

    def __init__(self, recv, max_message=64 * 1024):
        self.recv, self.max_message = recv, max_message
        self._buf, self._parts, self._op = b"", [], None

    def _exactly(self, n):
        while len(self._buf) < n:
            chunk = self.recv(max(n - len(self._buf), 4096))
            if not chunk:
                raise ConnectionError("connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def read(self):
        """-> (opcode, payload) for the next whole message or control frame."""
        while True:
            b1, b2 = self._exactly(2)
            fin, opcode, masked, n = b1 & 0x80, b1 & 0x0F, b2 & 0x80, b2 & 0x7F
            if b1 & 0x70:
                raise ProtocolError(CLOSE_PROTOCOL, "reserved bits set")
            if not masked:
                raise ProtocolError(CLOSE_PROTOCOL, "client frames must be masked")
            if n == 126:
                n = struct.unpack("!H", self._exactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._exactly(8))[0]
            if opcode >= 0x8:
                if not fin or n > 125:
                    raise ProtocolError(CLOSE_PROTOCOL, "bad control frame")
                key = self._exactly(4)  # the masking key comes before the payload
                return opcode, mask(self._exactly(n), key)
            if opcode not in (OP_CONT, OP_TEXT, OP_BINARY):
                raise ProtocolError(CLOSE_PROTOCOL, f"unknown opcode {opcode}")
            if (opcode == OP_CONT) == (self._op is None):
                raise ProtocolError(CLOSE_PROTOCOL, "bad fragmentation")
            size = sum(map(len, self._parts)) + n
            if size > self.max_message:
                raise ProtocolError(CLOSE_TOO_BIG, "message too big")
            key = self._exactly(4)
            self._parts.append(mask(self._exactly(n), key))
            if opcode != OP_CONT:
                self._op = opcode
            if fin:
                op, data = self._op, b"".join(self._parts)
                self._op, self._parts = None, []
                return op, data
