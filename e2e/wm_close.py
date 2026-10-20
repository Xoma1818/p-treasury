"""Закрыть окно так, как это делает кнопка «×» оконного менеджера: сообщение
WM_DELETE_WINDOW. В xvfb нет оконного менеджера, а WebDriver при закрытии окна
просто завершает процесс, поэтому настоящее закрытие тест посылает сам.
Использование: python3 wm_close.py <id окна> [<id окна> ...]"""
import ctypes
import sys

x = ctypes.CDLL("libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x.XFlush.argtypes = [ctypes.c_void_p]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]


class ClientMessage(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", ctypes.c_long * 5),
        ("pad", ctypes.c_long * 12),  # XEvent занимает 24 long
    ]


CLIENT_MESSAGE = 33
d = x.XOpenDisplay(None)
if not d:
    sys.exit("нет дисплея")
protocols = x.XInternAtom(d, b"WM_PROTOCOLS", 0)
delete = x.XInternAtom(d, b"WM_DELETE_WINDOW", 0)
for wid in map(int, sys.argv[1:]):
    ev = ClientMessage(type=CLIENT_MESSAGE, send_event=1, display=d, window=wid, message_type=protocols, format=32)
    ev.data[0] = delete
    x.XSendEvent(d, wid, 0, 0, ctypes.byref(ev))
x.XFlush(d)
x.XCloseDisplay(d)
