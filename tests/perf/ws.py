"""Minimal stdlib WebSocket client for the daimon pty-daemon."""
import base64, json, os, socket, struct, time


class WS:
    def __init__(self, port, token):
        self.s = socket.create_connection(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            f"GET /?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        assert b" 101 " in head.split(b"\r\n")[0], head
        self.bytes_in = 0

    def send(self, obj):
        p = json.dumps(obj).encode()
        hdr = bytes([0x81])
        n = len(p)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(p)))

    def write(self, tab, data, command=None):
        m = {"type": "write", "tab_id": tab, "data": data}
        if command:
            m["command"] = command
        self.send(m)

    def _need(self, n):
        while len(self.buf) < n:
            c = self.s.recv(1 << 20)
            if not c:
                raise EOFError
            self.buf += c

    def recv(self, timeout=None):
        """Next event dict, or None on timeout."""
        self.s.settimeout(timeout)
        try:
            self._need(2)
            b1 = self.buf[1] & 0x7F
            off = 2
            if b1 == 126:
                self._need(4); b1 = struct.unpack(">H", self.buf[2:4])[0]; off = 4
            elif b1 == 127:
                self._need(10); b1 = struct.unpack(">Q", self.buf[2:10])[0]; off = 10
            self._need(off + b1)
            op = self.buf[0] & 0x0F
            payload = self.buf[off:off + b1]
            self.buf = self.buf[off + b1:]
        except socket.timeout:
            return None
        finally:
            self.s.settimeout(None)
        self.bytes_in += len(payload)
        if op != 1:
            return {"type": f"_op{op}"}
        return json.loads(payload)

    def until(self, pred, timeout=60):
        end = time.perf_counter() + timeout
        while True:
            left = end - time.perf_counter()
            if left <= 0:
                return None
            ev = self.recv(left)
            if ev is None:
                return None
            if pred(ev):
                return ev
