"""Wait for files to change instead of polling them.

Linux inotify through ctypes (stdlib only). One Watch can cover several directories, and wake()
lets another thread end a wait early (e.g. /stop). If inotify isn't available, wait() sleeps with
backoff (50 ms doubling to 1 s) and returns None, meaning "something may have changed, check".

Callers are level-triggered: create the Watch first, then check the condition, then wait() and
check again. A change between the check and the wait is never missed, because the watch exists
before the check.
"""
import ctypes
import os
import select
import struct
import time

IN_MODIFY = 0x002
IN_CLOSE_WRITE = 0x008
IN_MOVED_FROM = 0x040
IN_MOVED_TO = 0x080
IN_CREATE = 0x100
IN_DELETE = 0x200
IN_NONBLOCK = 0o4000
IN_CLOEXEC = 0o2000000
DEFAULT_MASK = IN_MODIFY | IN_CLOSE_WRITE | IN_MOVED_TO | IN_MOVED_FROM | IN_CREATE | IN_DELETE
_HEADER = struct.Struct("iIII")  # wd, mask, cookie, len

_libc = None


def _inotify():
    global _libc
    if _libc is None:
        try:
            lib = ctypes.CDLL(None, use_errno=True)
            lib.inotify_init1, lib.inotify_add_watch  # noqa: B018 (raises if missing)
            _libc = lib
        except (OSError, AttributeError):
            _libc = False
    return _libc or None


class Watch:
    def __init__(self, *dirs, mask=DEFAULT_MASK, use_inotify=True):
        self.dirs, self.mask = [os.fspath(d) for d in dirs], mask
        self._use_inotify = use_inotify
        self._fd, self._wds, self._backoff = None, {}, 0.05
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_r, False)

    def __enter__(self):
        lib = _inotify() if self._use_inotify else None
        if lib:
            fd = lib.inotify_init1(IN_NONBLOCK | IN_CLOEXEC)
            if fd >= 0:
                self._fd = fd
                for d in self.dirs:  # never created here: watching must not change the filesystem
                    wd = lib.inotify_add_watch(fd, d.encode(), self.mask)
                    if wd < 0:  # missing folder or out of watches: fall back to polling
                        os.close(fd)
                        self._fd, self._wds = None, {}
                        break
                    self._wds[wd] = d
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        if self._fd is not None:
            os.close(self._fd)
            self._fd, self._wds = None, {}
        for fd in (self._wake_r, self._wake_w):
            try:
                os.close(fd)
            except OSError:
                pass
        self._wake_r = self._wake_w = -1

    @property
    def polling(self):
        return self._fd is None

    def wake(self):
        """End the current (or next) wait() from another thread."""
        try:
            os.write(self._wake_w, b"x")
        except OSError:
            pass

    def _drain_wake(self):
        try:
            return bool(os.read(self._wake_r, 4096))
        except (BlockingIOError, OSError):
            return False

    def wait(self, timeout):
        """Block until something changes, wake() is called, or `timeout` seconds pass.
        Returns [(dir, name, mask), …] ([] on timeout or wake), or None when polling."""
        timeout = max(0.0, timeout)
        if self._fd is None:
            r, _, _ = select.select([self._wake_r], [], [], min(self._backoff, timeout))
            self._drain_wake()
            self._backoff = min(1.0, self._backoff * 2)
            return None
        r, _, _ = select.select([self._fd, self._wake_r], [], [], timeout)
        if self._wake_r in r:
            self._drain_wake()
        if self._fd not in r:
            return []
        out, data = [], os.read(self._fd, 65536)
        off = 0
        while off + _HEADER.size <= len(data):
            wd, mask, _, length = _HEADER.unpack_from(data, off)
            name = data[off + _HEADER.size: off + _HEADER.size + length].rstrip(b"\0").decode(errors="replace")
            out.append((self._wds.get(wd), name, mask))
            off += _HEADER.size + length
        return out


def wait_for(check, watch, timeout):
    """Return check()'s first truthy value, waiting on `watch` between checks, or None at timeout."""
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        watch.wait(remaining)
